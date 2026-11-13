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
  gainYaw: 0.7,          // P: speed fraction per unit of image error beyond the inner band
  gainTilt: 0.7,
  kd: 0.5,               // D: speed fraction removed per (frame fraction / second) of closing speed; damps overshoot
  ki: 0,                 // I: speed fraction per accumulated error (frame fraction * s); 0 = off, see README note
  integralLimit: 0.1,    // anti-windup: the I term can never exceed this speed fraction
  staleDecayMs: 200,     // speed fades to zero this long after the last fresh detection (do not act on stale error)
  maxSpeedPct: 10,       // cap, percent of the calibrated speed range
  minSpeedPct: 3,        // floor while moving (the firmware adds its own minimum-move offset)
  rampPerSec: 3000,      // permille per second; keep at or below the firmware ramp
  dwellMs: 350,          // pause at neutral on a direction reversal; keep above the firmware dwell
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
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

const RANGES = Object.freeze({
  deadZone: [0.02, 0.25], innerFraction: [0.3, 0.95], emaAlpha: [0.15, 0.9],
  gainYaw: [0.5, 8], gainTilt: [0.5, 8], kd: [0, 5], ki: [0, 2], integralLimit: [0, 0.3], staleDecayMs: [50, 1000], maxSpeedPct: [5, 100], minSpeedPct: [0, 20],
  rampPerSec: [200, 4000], dwellMs: [150, 1000], lostMs: [100, 1500], reacquireResetMs: [200, 3000],
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
  // Per-axis PID state. The plant is an integrator (speed -> position), so P+D does the work; I is optional.
  const ax = { moving: false, d: 0, i: 0, prevErr: null };
  const ay = { moving: false, d: 0, i: 0, prevErr: null };

  function resetAxis(a) { a.moving = false; a.d = 0; a.i = 0; a.prevErr = null; }
  function reset() { fx = null; fy = null; lastObsMs = null; resetAxis(ax); resetAxis(ay); }

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

  /** Feed the person's centre (normalised 0..1 in the raw camera frame). */
  function observe({ x, y, t }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return;
    if (lastObsMs !== null && t - lastObsMs > s.reacquireResetMs) { fx = null; fy = null; resetAxis(ax); resetAxis(ay); }
    const dtSec = lastObsMs === null ? 0 : (t - lastObsMs) / 1000;
    lastObsMs = t;
    if (fx === null) { fx = x; fy = y; } else { fx += s.emaAlpha * (x - fx); fy += s.emaAlpha * (y - fy); }
    updateAxis(ax, fx - 0.5, dtSec);
    updateAxis(ay, fy - 0.5, dtSec);
  }

  function axis(error, a, gain, dir, freshness) {
    const mag = Math.abs(error);
    const outer = s.deadZone;
    const inner = outer * s.innerFraction;
    let m = a.moving;
    if (m) { if (mag < inner) m = false; } else if (mag > outer) m = true;
    a.moving = m;
    if (!m) { a.i = 0; return { speed: 0, moving: false }; }
    // PID on the signed error; the output must never push away from the target (no active reverse braking).
    const pTerm = Math.sign(error) * gain * (mag - inner);
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
    if (lastObsMs === null || fx === null || nowMs - lastObsMs > s.lostMs) {
      ax.moving = false; ay.moving = false;   // keep the derivative/integral memory: a late detection is not a new person
      return { yaw: 0, tilt: 0, status: 'NO PERSON' };
    }
    // Do not keep driving on an old measurement: fade the speed out between fresh detections.
    const freshness = clamp(1 - (nowMs - lastObsMs) / s.staleDecayMs, 0, 1);
    const rx = axis(fx - 0.5, ax, s.gainYaw, s.yawDirection, freshness);
    const ry = axis(fy - 0.5, ay, s.gainTilt, s.tiltDirection, freshness);
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
