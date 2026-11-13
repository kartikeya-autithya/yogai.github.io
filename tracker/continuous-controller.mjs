// Pure control maths for continuous-rotation servos (no DOM, no USB).
// The camera is the only position sensor: image error -> signed speed (permille).
// Three parts:
//   createVelocityController  image error -> raw speed targets (deadband with hysteresis, P gain)
//   createSpeedShaper         ramp limit + forced pass through neutral on reversal, with dwell
//   applySoftLimits           blocks motion that would pass the approximate travel limits

export const CR_SETTINGS_DEFAULTS = Object.freeze({
  deadZone: 0.06,        // outer band: movement starts when |error| exceeds this (fraction of frame)
  innerFraction: 0.6,    // movement stops when |error| falls below deadZone * innerFraction
  emaAlpha: 0.5,
  gainYaw: 1.0,          // P: speed fraction per unit of image error beyond the inner band (with delay compensation a lower gain is smoother)
  gainTilt: 1.0,
  kd: 0,                 // D on the tracked velocity (off: the delay compensation already provides the damping)
  ki: 0,                 // I: speed fraction per accumulated error (frame fraction * s); 0 = off, see README note
  integralLimit: 0.1,    // anti-windup: the I term can never exceed this speed fraction
  staleDecayMs: 300,     // the speed fades out over this window ending at lostMs (do not act on very stale predictions)
  captureDelayMs: 250,   // camera frame -> pose result age when a detection arrives
  actuationDelayMs: 100, // speed command -> physical motion (USB + ramp)
  fovYawDeg: 50,         // approx. horizontal field of view of the phone camera (portrait); converts degrees to frame fractions
  fovTiltDeg: 65,        // approx. vertical field of view
  smithScale: 1.0,       // 0..1.5: how much of the already-commanded camera motion is subtracted from a stale measurement
  plantGainInit: 2.0,    // starting guess of (real picture shift / modelled shift) until it is learned; >1 is the cautious side
  speedSmoothMs: 100,    // low-pass on the commanded speed (removes steps when a new detection arrives)
  settingsRev: 3,        // bumped when defaults are retuned; older saved values of the retuned keys are dropped
  maxSpeedPct: 50,       // cap, percent of the calibrated speed range
  minSpeedPct: 3,        // floor while moving (the firmware adds its own minimum-move offset)
  rampPerSec: 3000,      // permille per second; keep at or below the firmware ramp
  dwellMs: 50,           // pause at neutral on a direction reversal; the firmware dwell is set to the same value
  lostMs: 800,           // no fresh detection for this long -> speeds go to zero (prediction bridges the gap before that)
  reacquireResetMs: 700,
  yawDirection: 1,
  tiltDirection: 1,
  softLimitYawDeg: 60,   // approximate, see travel-estimate.mjs
  softLimitTiltDeg: 30,
  manualSpeedPct: 30,
  minVisibility: 0.5,
  minVisibleLandmarks: 8,
  minBboxFraction: 0.05,
});

export const CR_SETTINGS_REV = 3;
// Keys whose defaults were retuned in this revision; a phone that saved the old values gets the new defaults.
export const CR_RETUNED_KEYS = Object.freeze(['gainYaw', 'gainTilt', 'lostMs', 'dwellMs', 'staleDecayMs', 'kd', 'ki', 'integralLimit', 'captureDelayMs', 'actuationDelayMs', 'fovYawDeg', 'fovTiltDeg', 'smithScale', 'plantGainInit', 'speedSmoothMs']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

const RANGES = Object.freeze({
  deadZone: [0.02, 0.25], captureDelayMs: [0, 1500], actuationDelayMs: [0, 1000], fovYawDeg: [10, 120], fovTiltDeg: [10, 120], smithScale: [0, 1.5], plantGainInit: [0.5, 3], speedSmoothMs: [0, 500], innerFraction: [0.3, 0.95], emaAlpha: [0.15, 0.9],
  gainYaw: [0.5, 8], gainTilt: [0.5, 8], kd: [0, 5], ki: [0, 2], integralLimit: [0, 0.3], staleDecayMs: [50, 1000], maxSpeedPct: [5, 100], minSpeedPct: [0, 20],
  rampPerSec: [200, 4000], dwellMs: [50, 1000], lostMs: [100, 1500], reacquireResetMs: [200, 3000],
  softLimitYawDeg: [5, 360], softLimitTiltDeg: [5, 180], manualSpeedPct: [5, 100],
  minVisibility: [0.1, 1], minVisibleLandmarks: [1, 33], minBboxFraction: [0.01, 1],
});

export function sanitizeCrSettings(input = {}) {
  const out = { ...CR_SETTINGS_DEFAULTS };
  const src = input && typeof input === 'object' ? input : {};
  for (const key of Object.keys(CR_SETTINGS_DEFAULTS)) {
    if (typeof src[key] === 'number' && Number.isFinite(src[key])) out[key] = src[key];
  }
  for (const [key, [lo, hi]] of Object.entries(RANGES)) out[key] = clamp(out[key], lo, hi);
  out.minVisibleLandmarks = Math.round(out.minVisibleLandmarks);
  out.yawDirection = out.yawDirection === -1 ? -1 : 1;
  out.tiltDirection = out.tiltDirection === -1 ? -1 : 1;
  return Object.freeze(out);
}

export function createVelocityController(initial = {}) {
  let s = sanitizeCrSettings(initial);
  let fx = null;
  let fy = null;
  let lastObsMs = null;
  let lastComputeMs = null;
  // Per axis: PID state, a filtered velocity of the image error, the output low-pass and a short history of the
  // estimated mount position. The history lets a stale measurement be corrected for the camera motion that has been
  // commanded since the picture was taken (Smith-predictor style ego-motion compensation): without it the controller
  // keeps commanding a correction that is already under way, and a delayed loop overshoots and oscillates.
  const mk = () => ({ moving: false, v: 0, i: 0, prevErr: null, lp: 0, hist: [], q: s.plantGainInit, rawErr: null, rawT: null });
  const ax = mk();
  const ay = mk();

  function resetAxis(a) { a.moving = false; a.v = 0; a.i = 0; a.prevErr = null; a.lp = 0; a.rawErr = null; a.rawT = null; }   // a.q (learned plant gain) is a property of the mount and survives
  function reset() { fx = null; fy = null; lastObsMs = null; lastComputeMs = null; resetAxis(ax); resetAxis(ay); ax.hist = []; ay.hist = []; }   // the learned plant gain is kept: it belongs to the mount, not to a session

  function updateAxis(a, err, dtSec) {
    if (a.prevErr !== null && dtSec > 0.01) {
      const raw = clamp((err - a.prevErr) / dtSec, -1.5, 1.5);
      a.v += 0.5 * (raw - a.v);                       // filtered velocity of the image error (frame fractions / s)
      if (s.ki > 0 && a.moving) {
        if (Math.sign(err) !== Math.sign(a.prevErr)) a.i = 0;
        else a.i = clamp(a.i + err * dtSec, -s.integralLimit / s.ki, s.integralLimit / s.ki);
      }
    }
    a.prevErr = err;
  }

  // Learn how much the picture really moves per degree of commanded motion. The estimate only knows rough degrees per
  // second, so the ratio (measured shift / commanded shift) between two detections corrects the model online.
  function learn(a, rawErr, t, dir, fovDeg) {
    if (a.rawErr !== null && a.rawT !== null && t - a.rawT > 0 && t - a.rawT <= 1500) {
      const p1 = posAt(a, t - s.captureDelayMs - s.actuationDelayMs);
      const p0 = posAt(a, a.rawT - s.captureDelayMs - s.actuationDelayMs);
      if (p1 !== null && p0 !== null) {
        const commanded = -dir * ((p1 - p0) / fovDeg);          // expected change of the image error
        const measured = rawErr - a.rawErr;
        if (Math.abs(commanded) > 0.03 && measured / commanded > 0) {
          a.q += 0.35 * (clamp(measured / commanded, 0.25, 3) - a.q);
        }
      }
    }
    a.rawErr = rawErr; a.rawT = t;
  }

  /** Feed the person's centre (normalised 0..1 in the raw camera frame). */
  function observe({ x, y, t }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return;
    if (lastObsMs !== null && t - lastObsMs > s.reacquireResetMs) { fx = null; fy = null; resetAxis(ax); resetAxis(ay); }
    const dtSec = lastObsMs === null ? 0 : (t - lastObsMs) / 1000;
    lastObsMs = t;
    if (fx === null) { fx = x; fy = y; } else { fx += s.emaAlpha * (x - fx); fy += s.emaAlpha * (y - fy); }
    updateAxis(ax, fx - 0.5, dtSec);
    updateAxis(ay, fy - 0.5, dtSec);
    learn(ax, x - 0.5, t, s.yawDirection, s.fovYawDeg);
    learn(ay, y - 0.5, t, s.tiltDirection, s.fovTiltDeg);
  }

  const record = (a, t, pos) => {
    if (!Number.isFinite(pos)) return;
    const h = a.hist;
    if (h.length && (t < h[h.length - 1].t || Math.abs(pos - h[h.length - 1].pos) > 90)) h.length = 0;   // clock or estimate reset
    h.push({ t, pos });
    while (h.length > 2 && t - h[0].t > 3000) h.shift();
  };
  function posAt(a, t) {
    const h = a.hist;
    if (h.length === 0) return null;
    if (t <= h[0].t) return h[0].pos;
    for (let i = h.length - 1; i >= 0; i -= 1) {
      if (h[i].t <= t) {
        const n = h[i + 1];
        if (!n) return h[i].pos;
        return h[i].pos + ((n.pos - h[i].pos) * (t - h[i].t)) / Math.max(n.t - h[i].t, 1);
      }
    }
    return h[0].pos;
  }

  // Measured error corrected for the camera motion commanded since the measured frame was captured.
  function compensated(measErr, a, dir, fovDeg, nowMs) {
    if (!(s.smithScale > 0)) return measErr;
    const tCap = lastObsMs - s.captureDelayMs;
    const pNow = posAt(a, nowMs - s.actuationDelayMs);
    const pCap = posAt(a, tCap - s.actuationDelayMs);
    if (pNow === null || pCap === null) return measErr;
    return measErr - dir * s.smithScale * a.q * ((pNow - pCap) / fovDeg);
  }

  function axis(measErr, a, gain, dir, fovDeg, freshness, nowMs, dtMs) {
    const err = compensated(measErr, a, dir, fovDeg, nowMs);
    const mag = Math.abs(err);
    const outer = s.deadZone;
    const inner = outer * s.innerFraction;
    let m = a.moving;
    if (m) { if (mag < inner) m = false; } else if (mag > outer) m = true;
    a.moving = m;
    let target = 0;
    if (m) {
      const u = Math.sign(err) * (gain / clamp(a.q, 0.5, 3)) * (mag - inner) + s.kd * a.v + s.ki * a.i;   // gain normalised by the learned plant gain
      if (Math.sign(u) === Math.sign(err)) {                 // never reverse to brake: coast instead
        target = Math.sign(err) * dir * clamp(Math.abs(u), s.minSpeedPct / 100, s.maxSpeedPct / 100) * freshness;
      }
    } else a.i = 0;
    // Low-pass the commanded speed so a new detection changes it smoothly instead of in a step.
    const alpha = s.speedSmoothMs <= 0 ? 1 : 1 - Math.exp(-dtMs / s.speedSmoothMs);
    a.lp += alpha * (target - a.lp);
    if (target === 0 && Math.abs(a.lp) < 0.01) a.lp = 0;
    return { speed: Math.round(a.lp * 1000), moving: m };
  }

  /**
   * @returns {{yaw:number, tilt:number, status:string}} speeds in permille.
   * Statuses: NO PERSON, CENTRED, TRACKING, LIMIT
   */
  function compute(nowMs, { estimate = null } = {}) {
    const dtMs = lastComputeMs === null ? 50 : clamp(nowMs - lastComputeMs, 1, 250);
    lastComputeMs = nowMs;
    if (estimate) { record(ax, nowMs, estimate.yaw); record(ay, nowMs, estimate.tilt); }
    if (lastObsMs === null || fx === null || nowMs - lastObsMs > s.lostMs) {
      ax.moving = false; ay.moving = false; ax.lp = 0; ay.lp = 0;   // keep velocity/integral memory across a late detection
      return { yaw: 0, tilt: 0, status: 'NO PERSON' };
    }
    const age = nowMs - lastObsMs;
    const freshness = clamp((s.lostMs - age) / s.staleDecayMs, 0, 1);
    const rx = axis(fx - 0.5, ax, s.gainYaw, s.yawDirection, s.fovYawDeg, freshness, nowMs, dtMs);
    const ry = axis(fy - 0.5, ay, s.gainTilt, s.tiltDirection, s.fovTiltDeg, freshness, nowMs, dtMs);
    const limited = applySoftLimits([rx.speed, ry.speed], estimate, s);
    const status = limited.blocked ? 'LIMIT' : (rx.moving || ry.moving ? 'TRACKING' : 'CENTRED');
    return { yaw: limited.speeds[0], tilt: limited.speeds[1], status };
  }

  return Object.freeze({
    observe,
    compute,
    reset,
    setSettings(next) { s = sanitizeCrSettings({ ...s, ...next }); },
    getSettings: () => s,
  });
}

/** Zeroes a speed that would push the estimate past its soft limit. */
export function applySoftLimits(speeds, estimate, settings) {
  const out = [speeds[0], speeds[1]];
  let blocked = false;
  if (estimate) {
    if ((out[0] > 0 && estimate.yaw >= settings.softLimitYawDeg) || (out[0] < 0 && estimate.yaw <= -settings.softLimitYawDeg)) { out[0] = 0; blocked = true; }
    if ((out[1] > 0 && estimate.tilt >= settings.softLimitTiltDeg) || (out[1] < 0 && estimate.tilt <= -settings.softLimitTiltDeg)) { out[1] = 0; blocked = true; }
  }
  return { speeds: out, blocked };
}

export function createSpeedShaper({ rampPerSec = 3000, dwellMs = 200 } = {}) {
  let ramp = rampPerSec;
  let dwell = dwellMs;
  const cur = [0, 0];
  const dwellUntil = [0, 0];

  function step(targets, nowMs, dtMs) {
    const out = [0, 0];
    for (let i = 0; i < 2; i += 1) {
      let target = clamp(Math.round(targets[i] || 0), -1000, 1000);
      const cs = sign(cur[i]);
      const ts = sign(target);
      if (cs !== 0 && ts !== 0 && cs !== ts) target = 0;
      else if (cs === 0 && ts !== 0 && nowMs < dwellUntil[i]) target = 0;
      const prev = cur[i];
      const maxStep = (ramp * dtMs) / 1000;
      const d = target - cur[i];
      cur[i] = d > maxStep ? cur[i] + maxStep : d < -maxStep ? cur[i] - maxStep : target;
      if (Math.abs(cur[i]) < 1 && target === 0) cur[i] = 0;
      const wanted = sign(clamp(Math.round(targets[i] || 0), -1000, 1000));
      if (sign(prev) !== 0 && cur[i] === 0 && wanted !== 0 && wanted !== sign(prev)) dwellUntil[i] = nowMs + dwell;
      out[i] = Math.round(cur[i]);
    }
    return out;
  }

  return Object.freeze({
    step,
    reset() { cur[0] = 0; cur[1] = 0; dwellUntil[0] = 0; dwellUntil[1] = 0; },
    setParams({ rampPerSec: r, dwellMs: d } = {}) { if (Number.isFinite(r)) ramp = r; if (Number.isFinite(d)) dwell = d; },
    current: () => [Math.round(cur[0]), Math.round(cur[1])],
  });
}
