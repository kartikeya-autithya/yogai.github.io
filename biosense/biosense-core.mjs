/*
 * biosense-core.mjs: the BioSense engine. Pure logic, no DOM, so it can be tested without a browser.
 *
 *   headband (ESP8266: pulse + skin temperature + skin conductance)  ->  samples  ->  features  ->  stress estimate
 *                                                                                              ->  pranayama recommendation
 *
 * IMPORTANT: this is a transparent wellness estimate built from simple rules and z-scores against YOUR OWN baseline. It is
 * not a trained model and not a medical device. Skin conductance, pulse and forehead temperature from hobby sensors are
 * noisy; the engine reports a confidence and tells the user when a signal looks wrong.
 *
 * Sample format the band sends (all fields optional, any subset per message, JSON):
 *   { "hr": 72,        // heart rate, beats per minute
 *     "ibi": 830,      // one inter-beat interval in ms (optional but needed for HRV); "ibis": [830, 845] also accepted
 *     "temp": 34.1,    // skin temperature, degrees C
 *     "gsr": 412 }     // skin conductance, any unit where HIGHER = more conductive (raw ADC is fine; see invertGsr)
 */
import { createPulseStabilizer } from './pulse-stabilizer.mjs';


export const DURATIONS = [1, 2, 3, 5, 10, 15, 20, 30];         // the Meditation screen's minute choices
export const WINDOW_MS = 5 * 60 * 1000;
export const READY_SECONDS = 30;                                // "this will take up to 30 seconds"

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// ------------------------------------------------------------------------------------------------ feature extraction
/** HRV (RMSSD, ms) from inter-beat intervals; beats that deviate >25% from the local median (missed or doubled beats) are dropped. */
export function rmssd(ibis) {
  if (ibis.length < 8) return NaN;
  const med = median(ibis);
  const valid = ibis.map((v) => Math.abs(v - med) <= 0.25 * med);
  let s = 0; let n = 0;
  for (let i = 1; i < ibis.length; i += 1) {             // only differences between two neighbouring good beats
    if (valid[i] && valid[i - 1]) { const d = ibis[i] - ibis[i - 1]; s += d * d; n += 1; }
  }
  return n >= 7 ? Math.sqrt(s / n) : NaN;
}

/** Tonic skin conductance level: the median of the samples. */
export const scl = (vals) => median(vals);

/** Phasic skin conductance responses per minute: rises above a moving baseline that are clearly bigger than the noise. */
export function scrPerMinute(points) {            // points: [{t (ms), v}]
  if (points.length < 20) return NaN;
  const spanMs = points[points.length - 1].t - points[0].t;
  if (spanMs < 15000) return NaN;
  const vals = points.map((p) => p.v);
  const level = median(vals);
  if (!(level > 0)) return NaN;
  // moving median baseline over ~6 s
  const resid = points.map((p, i) => {
    const win = []; for (let j = i; j >= 0 && p.t - points[j].t <= 6000; j -= 1) win.push(points[j].v);
    return p.v - median(win);
  });
  const mad = median(resid.map((r) => Math.abs(r)));
  const thr = Math.max(0.02 * level, 4 * mad);
  let count = 0; let lastT = -1e9;
  for (let i = 1; i < resid.length - 1; i += 1) {
    if (resid[i] > thr && resid[i] >= resid[i - 1] && resid[i] > resid[i + 1] && points[i].t - lastT > 1500) { count += 1; lastT = points[i].t; }
  }
  return (count * 60000) / spanMs;
}

/** Least-squares slope in units per minute (needs >= 20 s of data). */
export function slopePerMin(points) {
  if (points.length < 4) return NaN;
  const t0 = points[0].t; const span = points[points.length - 1].t - t0;
  if (span < 20000) return NaN;
  const xs = points.map((p) => (p.t - t0) / 60000); const ys = points.map((p) => p.v);
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : NaN;
}

// ------------------------------------------------------------------------------------------------ scoring
export const PRIORS = Object.freeze({ hr: 72, rmssd: 40, temp: 34, scrRate: 1.5 });
const WEIGHTS = Object.freeze({ hr: 0.25, hrv: 0.30, scl: 0.20, scr: 0.15, temp: 0.10 });
export const BANDS = Object.freeze([
  { id: 'calm', label: 'Calm', max: 30 },
  { id: 'balanced', label: 'Balanced', max: 60 },
  { id: 'elevated', label: 'Elevated', max: 80 },
  { id: 'high', label: 'High', max: 101 },
]);
export const bandOf = (score) => BANDS.find((b) => score < b.max);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const zToScore = (z) => 100 * sigmoid(1.1 * (clamp(z, -3, 3) - 0.25));   // baseline (z = 0) reads about 43, "Balanced"

/**
 * features: { hr, rmssd, scl, scrRate, temp, tempSlope }  (NaN = not available)
 * baseline: { hr, rmssd, scl, scrRate, temp } or null; sessionRef: { scl } used for skin conductance when no baseline exists
 */
export function scoreStress(f, baseline, sessionRef = {}, opts = {}) {
  const W = { ...WEIGHTS, temp: opts.tempWeight ?? WEIGHTS.temp };
  const b = baseline || null;
  const hr0 = b?.hr ?? PRIORS.hr; const rm0 = b?.rmssd ?? PRIORS.rmssd; const t0 = b?.temp ?? NaN; const sr0 = b?.scrRate ?? PRIORS.scrRate;
  const scl0 = b?.scl ?? sessionRef.scl ?? NaN;
  const z = {};
  if (finite(f.hr)) z.hr = (f.hr - hr0) / Math.max(6, 0.12 * hr0);
  if (finite(f.rmssd)) z.hrv = (rm0 - f.rmssd) / (0.35 * rm0);
  if (finite(f.scl) && finite(scl0) && f.scl > 0 && scl0 > 0) z.scl = Math.log(f.scl / scl0) / Math.log(1.25);
  if (finite(f.scrRate)) z.scr = (f.scrRate - sr0) / 3;
  const tparts = [];
  if (finite(f.temp) && finite(t0)) tparts.push(-(f.temp - t0) / 0.5);
  if (finite(f.tempSlope)) tparts.push(-f.tempSlope / 0.15);       // skin cooling = more arousal
  if (tparts.length) z.temp = mean(tparts);

  let wsum = 0; let acc = 0;
  for (const k of Object.keys(z)) { const zz = clamp(z[k], -3, 3); z[k] = zz; acc += W[k] * zz; wsum += W[k]; }
  if (wsum < 0.3) return { score: NaN, z, used: Object.keys(z), confidence: 0, driver: null };   // not enough channels to say anything
  const zc = acc / wsum;
  const used = Object.keys(z);
  // Without a personal baseline the estimate leans on population averages, so confidence is capped at "Medium".
  const confidence = clamp(0.1 + (z.hr !== undefined ? 0.1 : 0) + (z.hrv !== undefined ? 0.2 : 0) + (z.scl !== undefined ? 0.15 : 0)
    + (z.scr !== undefined ? 0.05 : 0) + (z.temp !== undefined ? 0.05 : 0) + (b ? 0.35 : 0), 0, 1);
  const driver = used.reduce((best, k) => (best === null || W[k] * z[k] > W[best] * z[best] ? k : best), null);
  return { score: zToScore(zc), z, zCombined: zc, used, confidence, driver };
}

// ------------------------------------------------------------------------------------------------ recommendation
// Names match the Meditation screen exactly so the recommendation can open it pre-selected.
export const PRANAYAMA = Object.freeze({
  bhramari: { name: 'Bhramari (Humming Bee Breath)', steps: ['Sit tall, close your eyes, relax your jaw.', 'Inhale gently through the nose for about 4 seconds.', 'Exhale for 6 to 8 seconds with a soft, steady hum.', 'Repeat, letting the vibration settle your mind.'] },
  anulom: { name: 'Anulom Vilom', steps: ['Sit tall. Close the right nostril, inhale through the left for about 4 seconds.', 'Switch: close the left, exhale through the right for 6 to 8 seconds.', 'Inhale through the right, then switch and exhale through the left.', 'Keep it smooth and quiet, with no breath holding.'] },
  sama: { name: 'Sama Vritti (Equal Breathing)', steps: ['Sit comfortably and breathe through the nose.', 'Inhale for a count of 4, exhale for a count of 4.', 'Keep both equal and easy; do not strain the count.'] },
  ujjayi: { name: 'Ujjayi (Ocean Breath)', steps: ['Breathe through the nose with a slight, soft narrowing at the throat, like a faint ocean sound.', 'Keep inhale and exhale long, smooth and even.'] },
  dirga: { name: 'Dirga Pranayama (Three-Part Breath)', steps: ['Inhale into the belly, then the ribs, then the upper chest.', 'Exhale from the chest, ribs, then belly.', 'Move slowly, with no force.'] },
  sheetali: { name: 'Sheetali (Cooling Breath)', steps: ['Curl the tongue into a tube (or use Sheetkari if you cannot).', 'Inhale slowly through the tongue, feeling the cool air.', 'Close the mouth and exhale slowly through the nose.'] },
  chandra: { name: 'Chandra Bhedana (Left Nostril Breathing)', steps: ['Close the right nostril. Inhale through the left for about 4 seconds.', 'Close the left and exhale through the right for 6 to 8 seconds.', 'Repeat on the same side; keep it soft, with no holding.'] },
});
const snap = (m) => DURATIONS.reduce((best, d) => (Math.abs(d - m) < Math.abs(best - m) ? d : best), DURATIONS[0]);

const CAUTION = 'Breathe gently and never strain. Skip any breath holding. Stop if you feel dizzy. If you have a heart or blood-pressure condition, are pregnant, or are worried about your health, check with a doctor first. This is a wellness estimate, not a medical diagnosis.';

/** result: output of scoreStress plus raw features. ctx: { hour (0-23) }. Only gentle, retention-free practices are ever recommended. */
export function recommend(result, ctx = {}) {
  const score = result.score;
  if (!finite(score)) return null;
  const band = bandOf(score);
  const f = result.features || {};
  const z = result.z || {};
  const why = [];
  let key; let minutes; let alt; let when;

  const cardiac = (z.hr ?? 0) >= 0.8 && (z.hrv ?? 0) >= 0.8;
  const skin = (z.scl ?? 0) >= 0.8 || (z.scr ?? 0) >= 0.8;
  const warm = finite(f.temp) && (z.temp ?? 0) <= -0.8;            // skin warming up noticeably

  if (band.id === 'high') {
    minutes = 10; when = 'Now, seated somewhere quiet.';
    if (warm) { key = 'sheetali'; alt = ['bhramari', 'chandra']; why.push('Your skin temperature is rising, and a cooling breath helps bring heat and arousal down.'); }
    else if (cardiac) { key = 'anulom'; alt = ['bhramari', 'sama']; why.push('Your pulse is up and your heart-rate variability is down; slow alternate-nostril breathing with a longer exhale steadies both.'); }
    else { key = 'bhramari'; alt = ['anulom', 'chandra']; why.push(skin ? 'Your skin conductance shows strong arousal; the humming exhale quiets the mind quickly.' : 'The long, humming exhale is one of the fastest ways to settle a high-arousal state.'); }
  } else if (band.id === 'elevated') {
    minutes = score >= 70 ? 10 : 5; when = 'Within the next hour, seated.';
    if (cardiac) { key = 'anulom'; alt = ['sama', 'bhramari']; why.push('Pulse and variability both point to tension; slow alternate-nostril breathing balances them.'); }
    else if (skin) { key = 'bhramari'; alt = ['anulom', 'sama']; why.push('Skin conductance is above your usual level; a humming exhale helps it settle.'); }
    else { key = 'sama'; alt = ['anulom', 'ujjayi']; why.push('A mild lift in stress signals; equal breathing is an easy, reliable way to bring it back down.'); }
  } else if (band.id === 'balanced') {
    minutes = 5; when = (ctx.hour ?? 12) >= 20 ? 'Tonight before bed.' : 'Any time today.';
    key = (ctx.hour ?? 12) >= 20 ? 'dirga' : 'sama'; alt = ['ujjayi', 'anulom'];
    why.push('You are in a balanced range. A short, even practice keeps it there.');
  } else {
    minutes = 3; when = 'Optional.';
    key = 'ujjayi'; alt = ['dirga', 'sama'];
    why.push('You are calm. A short, smooth practice is enough to stay centred; nothing more is needed.');
  }
  if (finite(f.hr) && f.hr >= 110) why.push('Your pulse is quite fast at rest. Sit down, breathe slowly, and if you feel unwell seek medical care.');
  if (result.confidence < 0.5) why.push('Confidence is low, so treat this as a rough guide (see the notes about your signals).');

  const p = PRANAYAMA[key];
  return {
    id: key, name: p.name, minutes: snap(minutes), when, why, steps: p.steps, caution: CAUTION,
    alternatives: alt.map((k) => ({ id: k, name: PRANAYAMA[k].name })),
  };
}

// ------------------------------------------------------------------------------------------------ the engine
const BASELINE_KEY = 'yogai.biosense.baseline.v1';
const CONFIG_KEY = 'yogai.biosense.config.v1';
const readJson = (storage, key) => { try { const t = storage?.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; } };
const writeJson = (storage, key, v) => { try { storage?.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked: ignore */ } };

export function createBioSense({ now = () => Date.now(), storage = null } = {}) {
  let hrs = []; let temps = []; let gsrs = []; let ibis = []; let hums = [];   // [{t, v}]
  let startedAt = null; let lastSampleAt = null; let validSeconds = new Set();
  let smoothScore = NaN; let lastBand = null;
  let baseline = readJson(storage, BASELINE_KEY);
  let config = { invertGsr: false, tempMode: 'air', ...(readJson(storage, CONFIG_KEY) || {}) };   // tempMode: 'air' (a DHT22 reads the air next to the skin) or 'skin' (a sensor touching the skin)
  let sessionRef = {};
  const pulse = createPulseStabilizer({ now });                      // validates every beat before it is used
  let calibrating = null;                                             // { startedAt, hr: [], ... }
  const history = [];                                                 // [{t, score}] one point every few seconds

  const trim = (arr, t) => { while (arr.length && t - arr[0].t > WINDOW_MS) arr.shift(); };

  function start() {
    hrs = []; temps = []; gsrs = []; ibis = []; hums = []; startedAt = now(); lastSampleAt = null; validSeconds = new Set();
    smoothScore = NaN; lastBand = null; sessionRef = {}; history.length = 0; pulse.reset();
  }

  /** Feed one message from the band. Returns true if anything usable was in it. */
  function ingest(msg) {
    if (!msg || typeof msg !== 'object') return false;
    const t = now(); let used = false;
    // Pulse: every beat goes through the validator. Rejected beats (false peaks, missed beats, implausible values)
    // are NOT used for heart rate or HRV; they only show up in the debug view.
    const list = Array.isArray(msg.ibis) ? msg.ibis : (msg.ibi !== undefined ? [msg.ibi] : []);
    if (list.length) {
      for (const v of list) {
        const r = pulse.push({ ibi: v, hr: list.length === 1 ? msg.hr : undefined });
        if (r.accepted) { ibis.push({ t, v: r.ibi }); hrs.push({ t, v: r.bpm }); used = true; }
      }
    } else if (finite(msg.hr)) {                    // heart rate only (no intervals): validated the same way, but gives no HRV
      const r = pulse.push({ hr: msg.hr });
      if (r.accepted) { hrs.push({ t, v: msg.hr }); used = true; }
    }
    if (finite(msg.temp) && msg.temp >= 20 && msg.temp <= 45) { temps.push({ t, v: msg.temp }); used = true; }
    if (finite(msg.hum) && msg.hum >= 0 && msg.hum <= 100) { hums.push({ t, v: msg.hum }); used = true; }
    if (finite(msg.gsr) && msg.gsr >= 0) { gsrs.push({ t, v: config.invertGsr ? 1 / Math.max(msg.gsr, 1e-6) : msg.gsr }); used = true; }
    if (!used) return false;
    lastSampleAt = t;
    trim(hrs, t); trim(temps, t); trim(gsrs, t); trim(ibis, t); trim(hums, t);
    if (startedAt !== null && (hrs.length || gsrs.length)) validSeconds.add(Math.floor((t - startedAt) / 1000));
    if (calibrating) { calibrating.n += 1; }
    return true;
  }

  const since = (arr, t, ms) => arr.filter((p) => t - p.t <= ms);

  function features(t = now()) {
    const hr15 = since(hrs, t, 15000).map((p) => p.v);
    const ibi60 = since(ibis, t, 60000).map((p) => p.v);
    const g20 = since(gsrs, t, 20000).map((p) => p.v);
    const g60 = since(gsrs, t, 60000);
    const t60 = since(temps, t, 60000);
    return {
      hr: (() => { const pr = pulse.reading(); return pr.state === 'stable' ? pr.bpm : NaN; })(),   // only a stable, validated reading is ever shown
      rmssd: rmssd(ibi60),
      scl: g20.length >= 10 ? scl(g20) : NaN,
      scrRate: scrPerMinute(g60),
      temp: t60.length >= 3 ? median(t60.slice(-10).map((p) => p.v)) : NaN,
      tempSlope: slopePerMin(t60),
      hum: since(hums, t, 60000).length >= 2 ? median(since(hums, t, 60000).slice(-6).map((p) => p.v)) : NaN,
    };
  }

  function quality(f, t = now()) {
    const issues = [];
    if (startedAt !== null && !since(hrs, t, 15000).length) issues.push({ id: 'pulse', text: 'No pulse detected. Check that the pulse sensor sits snugly on the skin (temple or forehead) and stays still.' });
    const g = since(gsrs, t, 20000).map((p) => p.v);
    if (g.length >= 10) {
      const lo = Math.min(...g); const hi = Math.max(...g); const m = median(g);
      if (m <= 0 || (hi - lo) / Math.max(m, 1e-9) < 0.0005) issues.push({ id: 'gsr', text: 'Skin conductance looks flat. Check that both electrodes touch the skin; a little moisture helps.' });
    } else if (startedAt !== null && !g.length) issues.push({ id: 'gsr', text: 'No skin-conductance signal. Check the electrodes and wiring.' });
    const tt = since(temps, t, 15000);
    if (startedAt !== null && !tt.length) issues.push({ id: 'temp', text: 'No temperature reading. Check the temperature sensor.' });
    else if (config.tempMode === 'skin' && tt.length && median(tt.map((p) => p.v)) < 28) issues.push({ id: 'temp', text: 'Temperature is below normal skin range. The sensor may not be touching the skin.' });
    if (ibis.length === 0 && hrs.length) issues.push({ id: 'hrv', text: 'Only heart rate is arriving, so heart-rate variability cannot be used. Send beat-to-beat intervals ("ibi") for a better estimate.' });
    return issues;
  }

  /** Where are we in the flow: waiting for data, processing (progress 0..1), or ready. */
  function status(t = now()) {
    if (startedAt === null) return { state: 'idle', progress: 0 };
    const progress = clamp(validSeconds.size / READY_SECONDS, 0, 1);
    if (lastSampleAt === null) return { state: t - startedAt > 10000 ? 'waiting' : 'processing', progress: 0 };
    const silent = t - lastSampleAt > 10000;
    if (progress >= 1) return { state: silent ? 'lost' : 'ready', progress: 1 };
    return { state: silent ? 'lost' : 'processing', progress };
  }

  function analyze(t = now()) {
    const f = features(t);
    if (!finite(sessionRef.scl) && finite(f.scl) && startedAt !== null && t - startedAt >= 20000) sessionRef = { scl: f.scl };
    const r = scoreStress(f, baseline, sessionRef, { tempWeight: config.tempMode === 'air' ? 0.04 : 0.10 });
    r.features = f;
    if (finite(r.score)) {
      smoothScore = finite(smoothScore) ? smoothScore + 0.3 * (r.score - smoothScore) : r.score;
      // stay in the previous band until the score is clearly past the edge (avoids flicker)
      let band = bandOf(smoothScore);
      if (lastBand && band.id !== lastBand.id) {
        const edge = band.max > lastBand.max ? lastBand.max : band.max;
        if (Math.abs(smoothScore - edge) < 2) band = lastBand;
      }
      lastBand = band;
      r.rawScore = r.score; r.score = smoothScore; r.band = band;
      if (!history.length || t - history[history.length - 1].t >= 3000) { history.push({ t, score: smoothScore }); if (history.length > 200) history.shift(); }
    } else r.band = null;
    r.issues = quality(f, t);
    r.hasBaseline = !!baseline;
    r.recommendation = recommend(r, { hour: new Date(t).getHours() });
    if (finite(f.scl) && baseline?.scl > 0) r.sclChangePct = (f.scl / baseline.scl - 1) * 100;   // only meaningful against a real baseline
    return r;
  }

  // ---- personal baseline: 2 relaxed minutes
  function startBaseline() { calibrating = { startedAt: now(), n: 0 }; }
  function baselineProgress(t = now()) { return calibrating ? clamp((t - calibrating.startedAt) / 120000, 0, 1) : 0; }
  function finishBaseline(t = now()) {
    if (!calibrating) return null;
    const win = t - calibrating.startedAt; calibrating = null;
    const f = features(t);
    const g = since(gsrs, t, Math.min(win, 120000)).map((p) => p.v);
    const b = {
      hr: finite(f.hr) ? f.hr : undefined, rmssd: finite(f.rmssd) ? f.rmssd : undefined,
      scl: g.length >= 20 ? median(g) : undefined, scrRate: finite(f.scrRate) ? f.scrRate : undefined,
      temp: finite(f.temp) ? f.temp : undefined, at: t,
    };
    if (b.hr === undefined && b.scl === undefined) return null;
    baseline = b; writeJson(storage, BASELINE_KEY, b);
    return b;
  }
  function clearBaseline() { baseline = null; try { storage?.removeItem(BASELINE_KEY); } catch { /* ignore */ } }
  function setConfig(next) { config = { ...config, ...next }; writeJson(storage, CONFIG_KEY, config); }

  return {
    start, ingest, features, analyze, status, pulseReading: () => pulse.reading(), pulseLog: () => pulse.log(),
    startBaseline, baselineProgress, finishBaseline, clearBaseline, isCalibrating: () => calibrating !== null,
    getBaseline: () => baseline, getConfig: () => ({ ...config }), setConfig, getHistory: () => history.slice(),
    stop() { startedAt = null; },
  };
}

// ------------------------------------------------------------------------------------------------ data sources
/** Deterministic synthetic band for the demo mode and tests. scenario: 'calm' | 'mixed' | 'stressed' */
export function demoSample(tSec, scenario = 'mixed', rand = Math.random) {
  const stress = scenario === 'calm' ? 0.1 : scenario === 'stressed' ? 0.95 : (0.5 + 0.45 * Math.sin(tSec / 40));   // 0..1
  const noise = (a) => (rand() - 0.5) * 2 * a;
  const hr = 64 + 28 * stress + noise(1.5);
  const ibi = 60000 / hr + noise(60 - 45 * stress);                     // RMSSD about 49 ms when calm, about 12 ms when stressed
  return {
    hr: Math.round(hr * 10) / 10,
    ibi: Math.round(ibi),
    temp: Math.round((34.4 - 0.9 * stress + noise(0.03)) * 100) / 100,
    gsr: Math.round((300 + 260 * stress + noise(4) + (rand() < 0.01 + 0.04 * stress ? 30 : 0)) * 10) / 10,
  };
}

/** Poll an HTTPS JSON endpoint that returns one sample object, an array of samples, or {samples:[...]} */
export function createPollSource(url, { intervalMs = 500, fetchFn = (typeof fetch === 'function' ? fetch : null), onSamples, onError, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let timer = null; let busy = false;
  async function once() {
    if (busy) return; busy = true;
    try {
      const r = await fetchFn(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = Array.isArray(j) ? j : (Array.isArray(j?.samples) ? j.samples : [j]);
      onSamples?.(list);
    } catch (e) { onError?.(e); } finally { busy = false; }
  }
  return { start() { if (!timer) { timer = setTimer(once, intervalMs); once(); } }, stop() { if (timer) { clearTimer(timer); timer = null; } }, once };
}

/** WebSocket source (use wss:// from the HTTPS site). One JSON object or array per message. */
export function createSocketSource(url, { WebSocketCtor = (typeof WebSocket === 'function' ? WebSocket : null), onSamples, onError, onClose } = {}) {
  let ws = null;
  return {
    start() {
      if (ws || !WebSocketCtor) { if (!WebSocketCtor) onError?.(new Error('WebSocket is not available')); return; }
      try { ws = new WebSocketCtor(url); } catch (e) { onError?.(e); return; }
      ws.onmessage = (ev) => { try { const j = JSON.parse(ev.data); onSamples?.(Array.isArray(j) ? j : [j]); } catch (e) { onError?.(e); } };
      ws.onerror = (e) => onError?.(e instanceof Error ? e : new Error('WebSocket error'));
      ws.onclose = () => { ws = null; onClose?.(); };
    },
    stop() { if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; } },
  };
}

/**
 * The Arduino Uno band over USB, through the same WebUSB / Web Serial transports the phone tracker uses (passed in so this file
 * stays free of browser code). The Uno prints one JSON object per line; anything that is not JSON (boot noise) is ignored, and
 * {"band": ...} status lines go to onBand.
 */
export function createUsbSource({ WebUsb, WebSerial, nav = (typeof navigator !== 'undefined' ? navigator : null), onSamples, onBand, onError, onStatus, onClose, baudRate = 115200, bootWaitMs = 2500 } = {}) {
  let transport = null; let closed = false;
  function choose() {
    const android = /Android/i.test(nav?.userAgent || '');
    if (android && nav?.usb?.requestDevice) return 'web-usb';
    if (nav?.serial?.requestPort) return 'web-serial';
    if (nav?.usb?.requestDevice) return 'web-usb';
    return 'none';
  }
  function handleLine(line) {
    const a = String(line).indexOf('{'); const b = String(line).lastIndexOf('}');
    if (a < 0 || b < a) return;
    let j; try { j = JSON.parse(String(line).slice(a, b + 1)); } catch { return; }
    if (!j || typeof j !== 'object') return;
    if (j.band) onBand?.(j); else onSamples?.([j]);
  }
  async function start() {
    closed = false;
    const kind = choose();
    if (kind === 'none') { onError?.(new Error('This browser supports neither WebUSB nor Web Serial. Use Chrome on Android or on a computer.')); return false; }
    const Ctor = kind === 'web-usb' ? WebUsb : WebSerial;
    transport = new Ctor({
      baudRate, bootWaitMs, onStatus: (m) => onStatus?.(m), onLine: handleLine,
      onDisconnect: (e) => { if (!closed) { onError?.(e instanceof Error ? e : new Error('The Arduino was disconnected.')); onClose?.(); } },
    });
    try { await transport.connect(); return true; } catch (e) { onError?.(e); return false; }
  }
  async function stop() { closed = true; try { await transport?.disconnect?.(); } catch { /* already gone */ } transport = null; }
  return { start, stop, choose };
}
