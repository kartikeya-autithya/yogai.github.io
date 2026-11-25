// My Health - AI Overview.
// 1) Code (not the AI) finds entries in the user's OWN Ayurvedic notes (Yog Kriya Notes) that mention the out-of-range tests.
// 2) The AI writes a short plain-language overview and may only mention items from those matched notes.
// 3) The output is checked: anything that looks like a dose, a cure claim or an instruction to take something is thrown away.
// Educational only. It never diagnoses and never gives doses. Liver/kidney results outside range switch the medicine part off.

export const AYURVEDA_ENTRY = /ayurved/i;      // an entry counts as Ayurvedic if its title (or the start of its text) mentions this
export const DISCLAIMER = 'Dosage and medicines must be run through a real doctor before being taken.';
export const SAFETY_NOTE = 'Ayurvedic and herbal products can interact with prescription medicines, and some preparations contain metals or can strain the liver and kidneys. They are not suitable for everyone, for example during pregnancy, for children, or with an existing health condition. Do not start, stop or change any medicine because of this page. Please talk to a doctor or a qualified Ayurvedic practitioner first.';

// search words per standard test (any word found in a note counts as a match). Names of the tests themselves are added automatically.
const T = {
  anemia: ['anemia', 'anaemia', 'iron', 'pandu', 'haemoglobin', 'hemoglobin', 'blood building'],
  sugar: ['diabetes', 'blood sugar', 'glucose', 'madhumeha', 'prameha', 'sugar'],
  lipid: ['cholesterol', 'lipid', 'triglyceride', 'medoroga', 'dyslipid', 'fat'],
  thyroid: ['thyroid', 'galaganda', 'hypothyroid', 'hyperthyroid'],
  uric: ['uric', 'gout', 'vatarakta', 'vata rakta'],
  vitd: ['vitamin d', 'bone', 'asthi'],
  b12: ['b12', 'vitamin b12'],
  immunity: ['immunity', 'immune', 'ojas', 'blood count'],
  platelet: ['platelet'],
};
const KEY_TERMS = {
  hemoglobin: T.anemia, rbc: T.anemia, hematocrit: T.anemia, mcv: T.anemia, mch: T.anemia, mchc: T.anemia, ferritin: T.anemia, iron: T.anemia, tibc: T.anemia, transferrin_sat: T.anemia,
  glucose_fasting: T.sugar, glucose_pp: T.sugar, glucose_random: T.sugar, hba1c: T.sugar,
  cholesterol_total: T.lipid, ldl: T.lipid, hdl: T.lipid, triglycerides: T.lipid, vldl: T.lipid, chol_hdl_ratio: T.lipid, non_hdl: T.lipid,
  tsh: T.thyroid, free_t3: T.thyroid, free_t4: T.thyroid, total_t3: T.thyroid, total_t4: T.thyroid,
  uric_acid: T.uric, vitamin_d: T.vitd, vitamin_b12: T.b12, wbc: T.immunity, platelets: T.platelet,
};
const BLOCK_GROUPS = new Set(['liver', 'kidney']);          // abnormal liver/kidney results: no medicine suggestions at all

export function buildItems(results) {
  // results: [{ standard_key, standard_name, original_name, grp, value_num, qualifier, unit, status, _c }]
  return results.filter((r) => r.status === 'low' || r.status === 'high').map((r) => {
    const c = r._c || {}; const rg = c.range || {}; let dev = null;
    if (Number.isFinite(r.value_num) && !r.qualifier && (c.source === 'lab' || !c.rangeUnit || String(c.rangeUnit).toLowerCase() === String(r.unit || '').toLowerCase())) {
      if (r.status === 'high' && Number.isFinite(rg.high) && rg.high !== 0) dev = (r.value_num - rg.high) / Math.abs(rg.high);
      if (r.status === 'low' && Number.isFinite(rg.low) && rg.low !== 0) dev = (rg.low - r.value_num) / Math.abs(rg.low);
    }
    return { key: r.standard_key || null, name: r.standard_name, original: r.original_name, group: r.grp, value: `${r.qualifier || ''}${r.value_num}`, unit: r.unit || '', status: r.status, rangeText: c.rangeText || '', deviation: dev };
  });
}

export function safetyGate(items) {
  const blocked = items.filter((i) => BLOCK_GROUPS.has(i.group));
  const marked = items.filter((i) => i.deviation != null && i.deviation >= 0.5);
  return { suppressMeds: blocked.length > 0, blockedNames: blocked.map((i) => i.name), marked: marked.map((i) => i.name) };
}

// ---- find matching passages in the user's Ayurvedic notes
function chunkText(text) {
  const parts = String(text || '').split(/\n\s*\n+|\n(?=\s*(?:[-•*]|\d+[.)])\s)/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) { if (p.length <= 700) out.push(p); else for (let i = 0; i < p.length; i += 600) out.push(p.slice(i, i + 700)); }
  return out;
}
const wordIn = (hay, term) => hay.includes(term.toLowerCase());

export function findAyurvedaDb(kriyas) {
  return (Array.isArray(kriyas) ? kriyas : []).filter((k) => k && (AYURVEDA_ENTRY.test(k.title || '') || AYURVEDA_ENTRY.test(String(k.text || '').slice(0, 4000))));
}

export function matchNotes(kriyas, items, { perItem = 3, total = 10 } = {}) {
  const entries = findAyurvedaDb(kriyas);
  if (!entries.length) return { status: 'no-db', matches: [], entries: 0 };
  const chunks = [];
  for (const e of entries) for (const c of chunkText(e.text)) chunks.push({ title: e.title || 'Ayurvedic notes', text: c, low: c.toLowerCase() });
  const picked = new Map();
  for (const it of items) {
    const terms = new Set([...(KEY_TERMS[it.key] || [])]);
    for (const w of `${it.name} ${it.original}`.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !['count', 'total', 'serum', 'blood', 'level', 'test'].includes(w)) terms.add(w);
    const scored = chunks.map((c) => ({ c, s: [...terms].filter((t) => wordIn(c.low, t)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, perItem);
    for (const { c, s } of scored) {
      const id = `${c.title}|${c.text.slice(0, 60)}`;
      if (!picked.has(id)) picked.set(id, { title: c.title, text: c.text, score: s, relatedTo: [] });
      const m = picked.get(id); if (!m.relatedTo.includes(it.name)) m.relatedTo.push(it.name); m.score = Math.max(m.score, s);
    }
  }
  const matches = [...picked.values()].sort((a, b) => b.score - a.score).slice(0, total);
  return { status: matches.length ? 'ok' : 'no-match', matches, entries: entries.length };
}

// ---- the request to the AI (small: only test names, values, statuses and the matched note passages)
export const HEADINGS = { results: 'I noticed these results out of place:', advice: 'Ayurvedic advice from your notes:', medicine: 'Medicine listed in your notes:' };
const COMMON = [
  'You are YogAI\'s friendly health-information assistant. Write a helpful, calm answer in plain language, using ONLY the results and NOTES you are given.',
  'Never diagnose, never say a result proves a condition, never name a disease as the cause. Being outside a range does not by itself mean a disease.',
  'Never state doses, amounts, or how long or how often to take anything. Never say anything cures, treats or fixes a condition; say "your notes list ...". Do not write a disclaimer, one is added automatically.',
];
const SYSTEM_FULL = [...COMMON,
  'Use exactly these three headings, each on its own line, in this order:',
  HEADINGS.results, HEADINGS.advice, HEADINGS.medicine,
  'Under the first heading write one short bullet per result: what the test measures and whether it is low or high, in simple words.',
  'Under the second heading explain in your own words the Ayurvedic advice (diet, lifestyle, practices) that the NOTES give for these results, and say which result each piece of advice relates to.',
  'Under the third heading name the medicine(s) the NOTES list for these results, exactly as written in the NOTES, with one sentence on what the notes say it is for. Use only names that appear in the NOTES.',
  'Never invent advice or medicines that are not in the NOTES. If the NOTES have nothing for a result, say so under that heading. Maximum 300 words.'].join(' ').slice(0, 1990);
const SYSTEM_RESULTS = [...COMMON,
  'Use exactly one heading on its own line:', HEADINGS.results,
  'Under it write one short bullet per result: what the test measures and whether it is low or high, in simple words. Do not mention any herbal, Ayurvedic or other medicine. Maximum 200 words.'].join(' ').slice(0, 1990);

export function buildRequest(items, noteMatches, gate, includeAyurveda, counts) {
  const lines = items.slice(0, 25).map((i, n) => `${n + 1}. ${i.name}: ${i.value} ${i.unit} (${i.status.toUpperCase()}${i.rangeText ? `; range ${i.rangeText}` : ''})`);
  let msg = `Results outside the reference range:\n${lines.join('\n')}\nResults within range: ${counts.normal}. Results not interpreted (need verification): ${counts.verify}.\n`;
  const useNotes = includeAyurveda && !gate.suppressMeds && noteMatches.matches.length;
  if (useNotes) {
    const picks = noteMatches.matches.slice(0, 8); const budget = 3850 - msg.length - 140;
    const each = Math.max(150, Math.min(650, Math.floor(budget / picks.length) - 20));
    msg += '\nNOTES from the user\'s own Ayurvedic database (the ONLY source for advice and medicines):\n' + picks.map((m, n) => `[${n + 1}] ${m.title}: ${m.text.replace(/\s+/g, ' ').slice(0, each)}`).join('\n');
  } else if (includeAyurveda && !gate.suppressMeds) {
    msg += '\nNo matching NOTES were found. Under the advice and medicine headings, if you use them, say only: "Your notes have nothing for these results."';
  }
  return { message: msg.slice(0, 3950), systemPrompt: useNotes ? SYSTEM_FULL : (includeAyurveda && !gate.suppressMeds ? SYSTEM_FULL : SYSTEM_RESULTS), history: [], appContext: '' };
}

// Things the answer must never contain. Units like "mg/dL" or "g/dL" are NOT doses and are allowed.
const DOSE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|gm|gms|ml|tablets?|tabs?|capsules?|drops?|spoons?|teaspoons?|tablespoons?|tsp|tbsp)\b(?!\s*\/)/i;
const TIMING = /\b(?:\d+\s*times\s*(?:a|per|daily|each)|(?:once|twice|thrice)\s+(?:a|per|daily|every)|every\s+(?:morning|night|day)\s+(?:with|for|before|after)|for\s+\d+\s*(?:days?|weeks?|months?)|(?:before|after)\s+(?:meals?|food|eating|breakfast|lunch|dinner)|at\s+bedtime|empty\s+stomach)\b/i;
const CLAIM = /\b(?:cures?|cured|curing|heals?|guaranteed?|guarantees|will\s+(?:treat|fix|reverse|lower|raise)|treats?\s+(?:your|the)?\s*(?:anemia|anaemia|diabetes|cholesterol|thyroid)|you\s+should\s+(?:take|start|use|buy|stop)|you\s+must\s+(?:take|use)|take\s+(?:one|two|three|\d))\b/i;
const DIAG = /\byou\s+(?:have|are\s+suffering\s+from|suffer\s+from)\s+(?:an?\s+)?(?:anemia|anaemia|diabetes|prediabetes|hypothyroidism|hyperthyroidism|disease|deficiency|gout|fatty\s+liver)/i;
export function badReason(line) { for (const [n, re] of [['dose', DOSE], ['timing', TIMING], ['claim', CLAIM], ['diagnosis', DIAG]]) { const m = String(line).match(re); if (m) return `${n}: "${m[0]}"`; } return ''; }

// Drop only the offending lines instead of throwing the whole answer away.
export function scrubReply(text) {
  const raw = String(text || '').trim(); if (!raw) return { ok: false, reason: 'empty' };
  const lines = raw.split(/\n/); const kept = []; const dropped = [];
  for (const l of lines) { const r = badReason(l); if (r) dropped.push(r); else kept.push(l); }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const hasBody = kept.filter((l) => l.trim() && !/:\s*$/.test(l.trim())).length >= 2;
  if (!hasBody || (dropped.length && dropped.length > lines.filter((l) => l.trim()).length * 0.5)) return { ok: false, reason: dropped.join('; ') || 'too short' };
  return { ok: true, text: out, dropped };
}
export const checkReply = (t) => scrubReply(t);

// plain answer made by code (same layout), used when the AI is unavailable or its answer cannot be used
export function basicSummary(items, counts) {
  if (!items.length) return 'No results are outside the reference range used.';
  const bullets = items.map((i) => `- ${i.name}: ${i.value} ${i.unit} is ${i.status === 'low' ? 'below' : 'above'} the range${i.rangeText ? ` (${i.rangeText})` : ''}.`);
  return `${HEADINGS.results}\n${bullets.join('\n')}\n${counts.normal} other result${counts.normal === 1 ? ' is' : 's are'} within range. Being outside a range does not by itself mean a disease; please discuss it with a doctor.`;
}

export async function getOverview({ workerUrl, kriyas, results, includeAyurveda = true, fetchFn = (typeof fetch === 'function' ? fetch : null), timeoutMs = 45000 }) {
  const items = buildItems(results);
  const counts = { normal: results.filter((r) => r.status === 'normal').length, verify: results.filter((r) => r.status === 'verify').length };
  const gate = safetyGate(items);
  const notes = includeAyurveda && !gate.suppressMeds && items.length ? matchNotes(kriyas, items) : { status: 'off', matches: [], entries: findAyurvedaDb(kriyas).length };
  const out = { items, counts, gate, notes, text: '', source: 'basic', aiError: '', disclaimer: !!(includeAyurveda && !gate.suppressMeds && items.length) };
  if (!items.length) { out.text = basicSummary(items, counts); return out; }
  if (!workerUrl || !fetchFn) { out.text = basicSummary(items, counts); out.aiError = 'AI is not set up.'; return out; }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null; const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(workerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildRequest(items, notes, gate, includeAyurveda, counts)), signal: ctl ? ctl.signal : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The AI service could not answer right now.');
    const chk = scrubReply(data.reply);
    if (chk.ok) { out.text = chk.text; out.source = 'ai'; if (chk.dropped.length) out.scrubbed = chk.dropped; }
    else { out.text = basicSummary(items, counts); out.aiError = 'The AI answer could not be used, so a basic summary is shown with the matching passages from your notes.'; if (typeof console !== 'undefined') console.warn('[My Health] AI answer rejected:', chk.reason); }
  } catch (e) {
    out.text = basicSummary(items, counts);
    out.aiError = e && e.name === 'AbortError' ? 'The AI took too long to answer.' : (e && e.message) || 'The AI service could not be reached.';
  } finally { if (timer) clearTimeout(timer); }
  return out;
}
