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
  gainYaw: 3.0,          // P: speed fraction per unit of image error beyond the inner band
  gainTilt: 3.0,
  kd: 0.5,               // D: speed fraction removed per (frame fraction / second) of closing speed; damps overshoot
  ki: 0,                 // I: speed fraction per accumulated error (frame fraction * s); 0 = off, see README note
  integralLimit: 0.1,    // anti-windup: the I term can never exceed this speed fraction
  staleDecayMs: 200,     // speed fades to zero this long after the last fresh detection (do not act on stale error)
  maxSpeedPct: 50,       // cap, percent of the calibrated speed range
  minSpeedPct: 3,        // floor while moving (the firmware adds its own minimum-move offset)
  rampPerSec: 3000,      // permille per second; keep at or below the firmware ramp
  dwellMs: 200,          // pause at neutral on a direction reversal; keep above the firmware dwell
  lostMs: 250,           // no fresh detection for this long -> speeds go to zero
  reacquireResetMs: 700,
  yawDirection: 1,
  tiltDirection: 1,
  softLimitYawDeg: 60,   // approximate, see travel-estimate.mjs
  softLimitTiltDeg: 30,
  manualSpeedPct: 30,
  minVisibility: 0.5,
  minVisibleLandmarks: 8,
  minBboxFraction: 0.05,
  loopGainMargin: 0.45,  // gain scheduling: P gain is limited so that gain * mount speed * total delay stays below this (0 = off). Stable < ~1.5
  plantGainInit: 2.5,    // assumed (real picture shift / modelled shift) until the real mount speed has been measured; >1 is the cautious side
  captureDelayMs: 250,   // camera frame -> pose result age
  actuationDelayMs: 150, // speed command -> physical motion (USB + ramp + servo)
  fovYawDeg: 50,         // approx. horizontal / vertical field of view of the phone camera (portrait)
  fovTiltDeg: 65,
  centreMode: 1,         // 1 = anchor on the torso and keep the whole body in frame (person-centre.mjs); 0 = old bounding-box centre
  frameMargin: 0.04,     // keep-in-frame: the visible body is kept this far inside the frame edges
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

const RANGES = Object.freeze({
  deadZone: [0.02, 0.25], innerFraction: [0.3, 0.95], emaAlpha: [0.15, 0.9],
  gainYaw: [0.5, 8], gainTilt: [0.5, 8], kd: [0, 5], ki: [0, 2], integralLimit: [0, 0.3], staleDecayMs: [50, 1000], maxSpeedPct: [5, 100], minSpeedPct: [0, 20],
  rampPerSec: [200, 4000], dwellMs: [150, 1000], lostMs: [100, 1500], reacquireResetMs: [200, 3000],
  softLimitYawDeg: [5, 360], softLimitTiltDeg: [5, 180], manualSpeedPct: [5, 100],
  minVisibility: [0.1, 1], minVisibleLandmarks: [1, 33], minBboxFraction: [0.01, 1], centreMode: [0, 1], frameMargin: [0, 0.2], loopGainMargin: [0, 1.5], plantGainInit: [0.5, 4], captureDelayMs: [0, 1500], actuationDelayMs: [0, 1000], fovYawDeg: [10, 120], fovTiltDeg: [10, 120],
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
  let periodMs = 0;      // smoothed time between detections; the lost/fade windows stretch to fit a slow pose rate
  // Per-axis PID state. The plant is an integrator (speed -> position), so P+D does the work; I is optional.
  const mk = () => ({ moving: false, d: 0, i: 0, prevErr: null, hist: [], qs: [], rawErr: null, rawT: null });
  const ax = mk();
  const ay = mk();

  function resetAxis(a) { a.moving = false; a.d = 0; a.i = 0; a.prevErr = null; a.rawErr = null; a.rawT = null; }   // the learned mount speed (qs) and position history are kept
  function reset() { fx = null; fy = null; lastObsMs = null; periodMs = 0; resetAxis(ax); resetAxis(ay); }

  function updateAxis(a, err, dtSec) {
    if (a.prevErr !== null && dtSec > 0.01) {
      const raw = (err - a.prevErr) / dtSec;
      a.d += 0.5 * (raw - a.d);                       // lightly filtered derivative of the image error
      if (s.ki > 0 && a.moving) {
        if (Math.sign(err) !== Math.sign(a.prevErr)) a.i = 0;   // crossed the centre: drop the integral
        else a.i = clamp(a.i + err * dtSec, -s.integralLimit / s.ki, s.integralLimit / s.ki);
      }
    }
    a.prevErr = err;
  }

  // ---- gain scheduling -------------------------------------------------------------------------------------------------
  // The mount is an integrator (speed -> position) seen through a camera delay. A P controller on that is stable only while
  // gain * mount speed * total delay stays below about 1.5; above it the mount hunts and overshoots. The mount speed is not
  // known in advance, so it is measured: the picture shift between two detections is compared with the motion that was
  // commanded in between (from the travel estimate). The P gain is then limited to what the measured speed and delay allow.
  const record = (a, t, pos) => {
    if (!Number.isFinite(pos)) return;
    const h = a.hist;
    if (h.length && (t < h[h.length - 1].t || Math.abs(pos - h[h.length - 1].pos) > 90)) h.length = 0;
    h.push({ t, pos });
    while (h.length > 2 && t - h[0].t > 3000) h.shift();
  };
  const posAt = (a, t) => {
    const h = a.hist;
    if (h.length === 0) return null;
    if (t <= h[0].t) return h[0].pos;
    for (let i = h.length - 1; i >= 0; i -= 1) {
      if (h[i].t <= t) { const n = h[i + 1]; return n ? h[i].pos + ((n.pos - h[i].pos) * (t - h[i].t)) / Math.max(n.t - h[i].t, 1) : h[i].pos; }
    }
    return h[0].pos;
  };
  function learn(a, rawErr, t, dir, fovDeg) {
    if (a.rawErr !== null && a.rawT !== null && t - a.rawT > 0 && t - a.rawT <= 1500) {
      const p1 = posAt(a, t - s.captureDelayMs - s.actuationDelayMs);
      const p0 = posAt(a, a.rawT - s.captureDelayMs - s.actuationDelayMs);
      if (p1 !== null && p0 !== null) {
        const commanded = -dir * ((p1 - p0) / fovDeg);          // expected change of the image error
        const measured = rawErr - a.rawErr;
        if (Math.abs(commanded) > 0.03 && measured / commanded > 0) {
          a.qs.push(clamp(measured / commanded, 0.25, 4));
          if (a.qs.length > 6) a.qs.shift();
        }
      }
    }
    a.rawErr = rawErr; a.rawT = t;
  }
  const qHat = (a) => { if (a.qs.length === 0) return s.plantGainInit; const v = [...a.qs].sort((p, q) => p - q); return v[Math.min(v.length - 1, Math.floor(0.75 * v.length))]; };   // upper side on purpose
  function gainCap(a, fovDeg) {
    const speed = qHat(a) * (60 / fovDeg);                      // picture fractions per second at full speed (60 deg/s modelled)
    const delay = (s.captureDelayMs + s.actuationDelayMs) / 1000 + 0.5 * periodMs / 1000;
    return s.loopGainMargin / Math.max(speed * delay, 1e-6);
  }

  /** Feed the person's centre (normalised 0..1 in the raw camera frame). */
  function observe({ x, y, t }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return;
    if (lastObsMs !== null && t - lastObsMs > s.reacquireResetMs) { fx = null; fy = null; resetAxis(ax); resetAxis(ay); }
    const dtSec = lastObsMs === null ? 0 : (t - lastObsMs) / 1000;
    if (lastObsMs !== null && t - lastObsMs < s.reacquireResetMs) periodMs = periodMs ? periodMs * 0.7 + (t - lastObsMs) * 0.3 : (t - lastObsMs);
    lastObsMs = t;
    if (fx === null) { fx = x; fy = y; } else { fx += s.emaAlpha * (x - fx); fy += s.emaAlpha * (y - fy); }
    updateAxis(ax, fx - 0.5, dtSec);
    updateAxis(ay, fy - 0.5, dtSec);
    learn(ax, x - 0.5, t, s.yawDirection, s.fovYawDeg);
    learn(ay, y - 0.5, t, s.tiltDirection, s.fovTiltDeg);
  }

  function axis(error, a, gain, dir, freshness, fovDeg) {
    const mag = Math.abs(error);
    const outer = s.deadZone;
    const inner = outer * s.innerFraction;
    let m = a.moving;
    if (m) { if (mag < inner) m = false; } else if (mag > outer) m = true;
    a.moving = m;
    if (!m) { a.i = 0; return { speed: 0, moving: false }; }
    // PID on the signed error; the output must never push away from the target (no active reverse braking).
    const gainEff = s.loopGainMargin > 0 ? Math.min(gain, gainCap(a, fovDeg)) : gain;
    const pTerm = Math.sign(error) * gainEff * (mag - inner);
    const dTerm = s.kd * a.d;
    const iTerm = s.ki * a.i;
    let u = pTerm + dTerm + iTerm;
    if (Math.sign(u) !== Math.sign(error)) return { speed: 0, moving: true };   // damped to a coast
    const um = clamp(Math.abs(u), s.minSpeedPct / 100, s.maxSpeedPct / 100) * freshness;
    return { speed: Math.round(Math.sign(error) * dir * um * 1000), moving: true };
  }

  /**
   * @returns {{yaw:number, tilt:number, status:string}} speeds in permille.
   * Statuses: NO PERSON, CENTRED, TRACKING, LIMIT
   */
  function compute(nowMs, { estimate = null } = {}) {
    if (estimate) { record(ax, nowMs, estimate.yaw); record(ay, nowMs, estimate.tilt); }
    // With a slow pose rate the fixed 250 ms windows would stop the mount between every two detections. Stretch them to the
    // measured detection period (bounded), so the speed fades smoothly across a gap instead of stopping.
    const effDecay = Math.max(s.staleDecayMs, Math.min(1.3 * periodMs, 900));
    const effLost = Math.max(s.lostMs, Math.min(2.5 * periodMs, 1000));
    if (lastObsMs === null || fx === null || nowMs - lastObsMs > effLost) {
      ax.moving = false; ay.moving = false;   // keep the derivative/integral memory: a late detection is not a new person
      return { yaw: 0, tilt: 0, status: 'NO PERSON' };
    }
    // Do not keep driving on an old measurement: fade the speed out between fresh detections.
    const freshness = clamp(1 - (nowMs - lastObsMs) / effDecay, 0, 1);
    const rx = axis(fx - 0.5, ax, s.gainYaw, s.yawDirection, freshness, s.fovYawDeg);
    const ry = axis(fy - 0.5, ay, s.gainTilt, s.tiltDirection, freshness, s.fovTiltDeg);
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
