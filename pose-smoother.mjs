/*
 * pose-smoother.mjs: adaptive (One Euro) smoothing of MediaPipe pose landmarks.
 *
 * Why: raw landmarks jitter by a few pixels every frame. One Euro filtering removes that jitter while the body is
 * still, and automatically relaxes when the body moves fast, so there is very little lag during real movement.
 * It smooths x, y and z of every landmark and passes every other field (visibility, presence) through unchanged,
 * so the existing pose rules, rep counters and tracker keep working on the same data shape.
 *
 * eased(): between pose inferences (the tracker throttles inference to keep USB timers alive) the skeleton can be
 * drawn from positions that glide toward the latest smoothed target instead of freezing.
 */

const TWO_PI = 2 * Math.PI;
const alphaFor = (cutoffHz, dtSec) => { const tau = 1 / (TWO_PI * cutoffHz); return 1 / (1 + tau / dtSec); };

export function createPoseSmoother({ minCutoff = 0.7, beta = 5, dCutoff = 1.0, resetGapMs = 400, easeTauMs = 70, staleMs = 1000 } = {}) {
  let state = null;      // per landmark per axis: { x, dx }
  let lastT = null;
  let target = null;     // last smoothed landmarks
  let shown = null;      // eased copy used for drawing
  let shownT = null;

  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  function reset() { state = null; lastT = null; target = null; shown = null; shownT = null; }

  function smooth(landmarks, tMs) {
    if (!Array.isArray(landmarks) || landmarks.length === 0 || !finite(tMs)) return landmarks;
    const fresh = state === null || lastT === null || state.length !== landmarks.length || tMs - lastT > resetGapMs || tMs <= lastT;
    if (fresh) state = landmarks.map((p) => ['x', 'y', 'z'].map((k) => ({ x: finite(p[k]) ? p[k] : 0, dx: 0 })));
    const dt = fresh ? 0 : Math.max((tMs - lastT) / 1000, 0.001);
    const out = landmarks.map((p, i) => {
      const o = { ...p };
      ['x', 'y', 'z'].forEach((k, j) => {
        const raw = p[k];
        if (!finite(raw)) return;
        const s = state[i][j];
        if (!fresh) {
          const rawVel = (raw - s.x) / dt;
          s.dx += alphaFor(dCutoff, dt) * (rawVel - s.dx);
          const cutoff = minCutoff + beta * Math.abs(s.dx);
          s.x += alphaFor(cutoff, dt) * (raw - s.x);
        } else { s.x = raw; s.dx = 0; }
        o[k] = s.x;
      });
      return o;
    });
    lastT = tMs;
    target = out;
    if (fresh || shown === null || shown.length !== out.length) { shown = out.map((p) => ({ ...p })); shownT = tMs; }
    return out;
  }

  // Positions gliding toward the latest smoothed landmarks; null when nothing recent to draw.
  function eased(tMs) {
    if (target === null || shown === null || !finite(tMs) || tMs - lastT > staleMs) return null;
    const dt = Math.max(tMs - (shownT ?? tMs), 0);
    const a = 1 - Math.exp(-dt / easeTauMs);
    for (let i = 0; i < target.length; i += 1) {
      shown[i].x += (target[i].x - shown[i].x) * a;
      shown[i].y += (target[i].y - shown[i].y) * a;
    }
    shownT = tMs;
    return shown;
  }

  return { smooth, eased, reset };
}
