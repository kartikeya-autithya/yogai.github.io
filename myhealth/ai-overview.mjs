// My Health - AI Overview.
// 1) Code (not the AI) finds entries in the user's OWN Ayurvedic notes (Yog Kriya Notes) that mention the out-of-range tests.
// 2) The AI writes a short plain-language overview and may only mention items from those matched notes.
// 3) The output is checked: anything that looks like a dose, a cure claim or an instruction to take something is thrown away.
// Educational only. It never diagnoses and never gives doses. Liver/kidney results outside range switch the medicine part off.

export const AYURVEDA_ENTRY = /ayurved/i;      // an entry counts as Ayurvedic if its title (or the start of its text) mentions this
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
const SYSTEM = [
  'You write a short educational overview of someone\'s blood-test results for the YogAI app.',
  'RULES: Use only the results listed. Never diagnose, never say a result means or proves a condition, never name a disease as the cause.',
  'Plain, calm language, at most 170 words. Say in general terms what each out-of-range test measures. Say that being outside a range does not by itself mean a disease.',
  'Then, only if NOTES are provided, add a heading "From your Ayurvedic notes:" with at most 4 bullet items.',
  'Use ONLY items that appear in the numbered NOTES. Copy each item\'s name exactly as written in the notes and say which result it relates to. Never add an item from your own knowledge.',
  'Never give doses, amounts, durations or instructions to take, buy or use anything. Never say anything treats, cures, fixes or lowers anything; say "your notes list it in connection with ...".',
  'If the notes contain nothing relevant, write "Your notes have nothing for these results."',
  'End with one line: discuss these results, and any herbal or Ayurvedic product, with a doctor or qualified Ayurvedic practitioner first.',
].join(' ').slice(0, 1990);

export function buildRequest(items, noteMatches, gate, includeAyurveda, counts) {
  const lines = items.slice(0, 25).map((i, n) => `${n + 1}. ${i.name}: ${i.value} ${i.unit} (${i.status.toUpperCase()}${i.rangeText ? `; range ${i.rangeText}` : ''})`);
  let msg = `Results outside the reference range:\n${lines.join('\n')}\nResults within range: ${counts.normal}. Results not interpreted (need verification): ${counts.verify}.\n`;
  if (includeAyurveda && !gate.suppressMeds && noteMatches.matches.length) {
    msg += '\nNOTES from the user\'s own Ayurvedic database (the ONLY source for the Ayurvedic section):\n' + noteMatches.matches.slice(0, 8).map((m, n) => `[${n + 1}] ${m.title}: ${m.text.replace(/\s+/g, ' ').slice(0, 380)}`).join('\n');
  } else {
    msg += '\nNo NOTES are provided. Do not include an Ayurvedic section and do not mention any herbal or Ayurvedic product.';
  }
  return { message: msg.slice(0, 3900), systemPrompt: SYSTEM, history: [], appContext: '' };
}

const BAD = /(\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|gm|ml|tablets?|tabs?|capsules?|drops?|spoons?|tsp|tbsp|times|days|weeks|months)\b|\b(?:cures?|cured|treats?|heals?|guaranteed|take\s+(?:one|two|\d)|twice\s+(?:a|daily)|once\s+(?:a|daily)|before\s+(?:meals|food)|after\s+(?:meals|food)|you\s+should\s+(?:take|start|use)|diagnos(?:is|e|ed)\s+(?:of|with)|you\s+have\s+(?:a|an)?\s*(?:anemia|anaemia|diabetes|thyroid|hypothyroidism|disease)))/i;
export function checkReply(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  const m = t.match(BAD);
  if (m) return { ok: false, reason: `contains "${m[0]}"` };
  return { ok: true, text: t };
}

// plain summary made by code, used when the AI is unavailable or its answer is rejected
export function basicSummary(items, counts) {
  if (!items.length) return 'No results are outside the reference range used.';
  const parts = items.map((i) => `${i.name} is ${i.status === 'low' ? 'below' : 'above'} the range (${i.value} ${i.unit}${i.rangeText ? `, range ${i.rangeText}` : ''})`);
  return `${parts.join('; ')}. ${counts.normal} other result${counts.normal === 1 ? ' is' : 's are'} within range. A result outside its range does not by itself mean a disease; please discuss it with a doctor.`;
}

export async function getOverview({ workerUrl, kriyas, results, includeAyurveda = true, fetchFn = (typeof fetch === 'function' ? fetch : null), timeoutMs = 45000 }) {
  const items = buildItems(results);
  const counts = { normal: results.filter((r) => r.status === 'normal').length, verify: results.filter((r) => r.status === 'verify').length };
  const gate = safetyGate(items);
  const notes = includeAyurveda && !gate.suppressMeds && items.length ? matchNotes(kriyas, items) : { status: 'off', matches: [], entries: findAyurvedaDb(kriyas).length };
  const out = { items, counts, gate, notes, text: '', source: 'basic', aiError: '' };
  if (!items.length) { out.text = basicSummary(items, counts); return out; }
  if (!workerUrl || !fetchFn) { out.text = basicSummary(items, counts); out.aiError = 'AI is not set up.'; return out; }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null; const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(workerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildRequest(items, notes, gate, includeAyurveda, counts)), signal: ctl ? ctl.signal : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The AI service could not answer right now.');
    const chk = checkReply(data.reply);
    if (chk.ok) { out.text = chk.text; out.source = 'ai'; }
    else { out.text = basicSummary(items, counts); out.aiError = 'The AI answer was not used because it did not meet the safety rules, so a basic summary is shown instead.'; }
  } catch (e) {
    out.text = basicSummary(items, counts);
    out.aiError = e && e.name === 'AbortError' ? 'The AI took too long to answer.' : (e && e.message) || 'The AI service could not be reached.';
  } finally { if (timer) clearTimeout(timer); }
  return out;
}
