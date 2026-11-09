// Approximate rotation estimate from commanded speed x time. NOT a measurement.
// There is no position feedback, so this drifts: speed varies with load, supply voltage,
// temperature and direction, the stand can be moved by hand, and a stalled servo still
// "moves" in this model. Use it only for a soft travel budget and a display with an
// uncertainty that grows with the distance travelled.

const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export function createTravelEstimator({ dpsAtFull = [60, 60], tables = [null, null], uncertaintyFraction = 0.15 } = {}) {
  let full = [...dpsAtFull];
  let tab = [tables[0], tables[1]];
  let uf = uncertaintyFraction;
  const pos = [0, 0];       // signed degrees, + = positive pulse side
  const travel = [0, 0];    // cumulative absolute degrees since the last reset

  function dpsFor(axis, permille) {
    const p = Math.abs(permille);
    const t = tab[axis];
    if (Array.isArray(t) && t.length > 0) {
      if (p <= t[0].permille) return t[0].dps;
      for (let i = 1; i < t.length; i += 1) {
        if (p <= t[i].permille) {
          const a = t[i - 1];
          const b = t[i];
          return a.dps + ((b.dps - a.dps) * (p - a.permille)) / (b.permille - a.permille);
        }
      }
      return t[t.length - 1].dps;
    }
    return (full[axis] * p) / 1000;
  }

  return Object.freeze({
    step(axis, permille, dtMs) {
      if (!permille || !(dtMs > 0)) return;
      const deg = (dpsFor(axis, permille) * dtMs) / 1000;
      pos[axis] += sign(permille) * deg;
      travel[axis] += deg;
    },
    get() {
      return {
        yaw: pos[0], tilt: pos[1],
        yawTravel: travel[0], tiltTravel: travel[1],
        yawUncertainty: travel[0] * uf, tiltUncertainty: travel[1] * uf,
      };
    },
    reset() { pos[0] = 0; pos[1] = 0; travel[0] = 0; travel[1] = 0; },
    setCalibration({ dpsAtFull: d, tables: t, uncertaintyFraction: u } = {}) {
      if (Array.isArray(d)) full = [Number(d[0]) || full[0], Number(d[1]) || full[1]];
      if (Array.isArray(t)) tab = [t[0] ?? null, t[1] ?? null];
      if (Number.isFinite(u)) uf = u;
    },
    serialize() { return { pos: [...pos], travel: [...travel], at: Date.now() }; },
    restore(saved) {
      if (!saved || !Array.isArray(saved.pos) || !Array.isArray(saved.travel)) return false;
      const ok = [...saved.pos, ...saved.travel].every((n) => Number.isFinite(n));
      if (!ok) return false;
      pos[0] = saved.pos[0]; pos[1] = saved.pos[1]; travel[0] = saved.travel[0]; travel[1] = saved.travel[1];
      return true;
    },
  });
}
