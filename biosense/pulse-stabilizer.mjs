// BioSense - beat validation and stable BPM.
// Works with ANY firmware that sends beat events ({ibi} and/or {hr}). It never invents a value:
// a BPM is only reported when enough consistent, plausible beats have been seen; otherwise the state says why not.
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export const PULSE_CFG = Object.freeze({
  minBpm: 40, maxBpm: 180,        // resting/wellness plausibility window (ibi 333..1500 ms)
  history: 7,                     // accepted beats used as the local reference
  maxJump: 0.25,                  // a beat may differ from the local median by at most 25%
  halfRatio: 0.55, doubleRatio: 1.8,   // below: false extra peak, above: missed beat
  warmup: 4,                      // beats before the median check applies (until then: within 30% of previous)
  resetAfter: 6,                  // this many rejects in a row that agree with each other = a real rate change
  stableBeats: 6, stableWindowMs: 20000, maxSpread: 0.10,   // MAD/median of the last accepted beats
  noPulseMs: 5000, poorReject: 0.5, outcomes: 12,
});

export function createPulseStabilizer({ now = () => Date.now(), cfg = {} } = {}) {
  const C = { ...PULSE_CFG, ...cfg };
  let accepted = [];                // [{ t, ibi, derived }]
  let outcomes = [];                // last N booleans
  let rejectRun = [];               // consecutive rejected ibis
  let lastBeatAt = 0, startedAt = now();
  const log = [];                   // recent events for the debug view
  const note = (e) => { log.push(e); if (log.length > 40) log.shift(); return e; };
  const minIbi = 60000 / C.maxBpm, maxIbi = 60000 / C.minBpm;

  function reset() { accepted = []; outcomes = []; rejectRun = []; lastBeatAt = 0; startedAt = now(); log.length = 0; }

  function decide(ibi, derived) {
    if (!(ibi >= minIbi && ibi <= maxIbi)) return 'Outside the plausible range (40-180 bpm)';
    const ref = accepted.slice(-C.history).map((b) => b.ibi);
    if (ref.length >= C.warmup) {
      const med = median(ref); const r = ibi / med;
      if (r < C.halfRatio) return 'Too short: likely a false extra peak';
      if (r > C.doubleRatio) return 'Too long: likely a missed beat';
      if (Math.abs(r - 1) > C.maxJump) return 'Changed more than 25% from recent beats';
    } else if (ref.length) {
      if (Math.abs(ibi / ref[ref.length - 1] - 1) > 0.30) return 'Does not match the previous beat yet';
    }
    return null;
  }

  /** push({ ibi, hr }): returns { accepted, reason, ibi, bpm, derived } */
  function push({ ibi, hr } = {}) {
    const t = now(); let derived = false; let v = ibi;
    if (!finite(v) && finite(hr)) { v = 60000 / hr; derived = true; }
    if (!finite(v)) return { accepted: false, reason: 'No usable value', ibi: null, bpm: null, derived };
    if (finite(ibi) && finite(hr) && Math.abs(60000 / ibi - hr) / hr > 0.35) {
      outcomes.push(false); outcomes = outcomes.slice(-C.outcomes);
      return note({ t, accepted: false, reason: 'Heart rate and interval disagree', ibi: Math.round(v), bpm: Math.round(60000 / v), derived });
    }
    let reason = decide(v, derived);
    if (reason) {
      rejectRun.push(v);
      if (rejectRun.length >= C.resetAfter) {                 // several rejects that agree with each other: the rate really changed
        const m = median(rejectRun); const agree = rejectRun.every((x) => Math.abs(x / m - 1) <= 0.15);
        if (agree && m >= minIbi && m <= maxIbi) { accepted = []; rejectRun = []; reason = null; }
        else rejectRun = rejectRun.slice(-C.resetAfter);
      }
    }
    outcomes.push(!reason); outcomes = outcomes.slice(-C.outcomes);
    if (reason) return note({ t, accepted: false, reason, ibi: Math.round(v), bpm: Math.round(60000 / v), derived });
    rejectRun = []; accepted.push({ t, ibi: v, derived }); accepted = accepted.slice(-30); lastBeatAt = t;
    return note({ t, accepted: true, reason: '', ibi: Math.round(v), bpm: Math.round(60000 / v), derived });
  }

  /** reading(): { state: 'none'|'stabilising'|'poor'|'stable', bpm: number|null, ... } */
  function reading() {
    const t = now();
    const recent = accepted.filter((b) => t - b.t <= C.stableWindowMs).slice(-8);
    const rejRatio = outcomes.length >= 8 ? outcomes.filter((o) => !o).length / outcomes.length : 0;
    const base = { accepted: accepted.length, rejectRatio: rejRatio, lastBeatAgoMs: lastBeatAt ? t - lastBeatAt : null, bpm: null, spread: null, state: 'none' };
    if (!lastBeatAt && (outcomes.length === 0)) return { ...base, state: t - startedAt > C.noPulseMs ? 'none' : 'stabilising' };
    if (lastBeatAt && t - lastBeatAt > C.noPulseMs) return { ...base, state: 'none' };
    if (!lastBeatAt || outcomes.length >= 8 && rejRatio > C.poorReject) return { ...base, state: 'poor' };
    if (recent.length < C.stableBeats) return { ...base, state: 'stabilising' };
    const ibis = recent.map((b) => b.ibi); const med = median(ibis); const mad = median(ibis.map((x) => Math.abs(x - med)));
    const spread = mad / med;
    if (spread > C.maxSpread) return { ...base, state: 'stabilising', spread };
    return { ...base, state: 'stable', bpm: Math.round(60000 / med), spread };
  }
  return { push, reading, reset, log: () => log.slice(), acceptedIbis: () => accepted.filter((b) => !b.derived).map((b) => b.ibi) };
}
