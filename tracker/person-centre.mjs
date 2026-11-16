/*
 * person-centre.mjs: where is the person in the camera frame, for the servo tracker.
 *
 * The old estimate was the centre of the bounding box of every visible landmark. That moves whenever a limb moves:
 * stretching one arm out sideways shifted the reported position by about 16% of the frame while the torso stayed put,
 * which is far more than the dead zone, so the mount chased an arm. Two weaknesses are fixed here:
 *
 *  1. Anchor on the torso (shoulders and hips) instead of the whole bounding box. The torso hardly moves when a pose
 *     changes. If fewer than 3 torso points are visible the old bounding-box centre is used.
 *  2. Keep the whole body in frame. Landmarks at or beyond the frame edge are not dropped any more; if the visible body
 *     comes within `frameMargin` of an edge, the reported centre is pushed toward that edge so the mount turns toward
 *     the cut-off part instead of away from it.
 *
 * settings.centreMode: 1 = torso anchor (default), 0 = the old bounding-box centre.
 */

const TORSO = [11, 12, 23, 24];   // left shoulder, right shoulder, left hip, right hip
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const MAX_PUSH = 0.25;

export function findPersonCentre(landmarks, settings) {
  if (!Array.isArray(landmarks)) return null;
  const minVis = settings.minVisibility ?? 0.5;
  const finite = (lm) => Number.isFinite(lm?.x) && Number.isFinite(lm?.y);
  const visible = (lm) => finite(lm) && (lm.visibility ?? 1) >= minVis;
  const mode = settings.centreMode ?? 1;

  // Legacy path (and the fallback): bounding box of the visible in-frame landmarks.
  const inFrame = landmarks.filter((lm) => visible(lm) && lm.x >= 0 && lm.x <= 1 && lm.y >= 0 && lm.y <= 1);
  if (inFrame.length < (settings.minVisibleLandmarks ?? 8)) return null;
  const box = (pts) => {
    const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };
  const b = box(inFrame);
  if (Math.max(b.maxX - b.minX, b.maxY - b.minY) < (settings.minBboxFraction ?? 0.05)) return null;
  const legacy = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, source: 'bbox', pushX: 0, pushY: 0 };
  if (mode < 0.5) return legacy;

  const torso = TORSO.map((i) => landmarks[i]).filter((lm) => visible(lm) && lm.x > -0.5 && lm.x < 1.5 && lm.y > -0.5 && lm.y < 1.5);
  if (torso.length < 3) return legacy;
  let wsum = 0; let ax = 0; let ay = 0;
  for (const p of torso) { const w = Math.max(p.visibility ?? 1, 0.05); wsum += w; ax += p.x * w; ay += p.y * w; }
  ax /= wsum; ay /= wsum;

  // Keep-in-frame: use every visible landmark, including ones just outside the frame.
  const all = landmarks.filter((lm) => visible(lm) && lm.x > -0.5 && lm.x < 1.5 && lm.y > -0.5 && lm.y < 1.5);
  const a = box(all);
  const m = settings.frameMargin ?? 0.04;
  const push = (lo, hi) => Math.min(MAX_PUSH, Math.max(0, m - lo)) - Math.min(MAX_PUSH, Math.max(0, hi - (1 - m)));
  const pushX = -push(a.minX, a.maxX) || 0;   // body past the left edge -> report the person further left -> the mount turns left
  const pushY = -push(a.minY, a.maxY) || 0;
  return { x: clamp01(ax + pushX), y: clamp01(ay + pushY), source: 'torso', pushX, pushY };
}
