// My Health - reference-range parsing and result classification.
// Priority: (1) the laboratory's own range printed in the report, (2) built-in general adult fallback
// (only when the user confirmed an adult and units are compatible), (3) no classification.
// This is organisation of data, not a diagnosis: statuses only say where a value sits against a range.
import { builtinRange, formatRange } from './reference-db.mjs';
import { convertValue, normUnit } from './units.mjs';

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const clean = (t) => String(t ?? '').replace(/[–—−]/g, '-').replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/\s+/g, ' ').trim();

// Returns { kind:'range', low, high, lowIncl, highIncl } | { kind:'bands'|'sex', reason } | { kind:'qualitative' } | null
export function parseRefText(text, sex = null) {
  const t = clean(text);
  if (!t) return null;
  if (/\b(female|women)\b/i.test(t) && /\b(male|men)\b/i.test(t)) {
    const parts = {}; const re = /(female|women|male|men)\s*[:=\-]?\s*([^a-zA-Z]*)/gi; let m;
    while ((m = re.exec(t))) parts[/^f|^w/i.test(m[1]) ? 'female' : 'male'] = m[2].trim();
    if (sex !== 'male' && sex !== 'female') return { kind: 'sex', reason: 'The lab gives separate ranges for males and females. Choose the sex used for reference ranges.' };
    return parseRefText(parts[sex] || '', sex);
  }
  const labels = (t.match(/\b(desirable|optimal|borderline|near optimal|high risk|very high|intermediate|prediabet\w*|diabet\w*|deficien\w*|insufficien\w*|sufficien\w*|toxic\w*|low risk|normal|elevated|moderate|severe)\s*[:=\-(]/gi) || []);
  if (labels.length >= 2 || (labels.length === 1 && /[;|]/.test(t))) return { kind: 'bands', reason: 'The lab lists several categories instead of one reference range. Enter the range you want to compare against.' };
  if (/^(negative|nil|absent|not detected|non[- ]?reactive|normal)$/i.test(t)) return { kind: 'qualitative' };
  let m = t.match(new RegExp(`${NUM}\\s*(?:-|to)\\s*${NUM}`, 'i'));
  if (m) { const low = +m[1], high = +m[2]; if (low <= high) return { kind: 'range', low, high, lowIncl: true, highIncl: true }; return null; }
  m = t.match(new RegExp(`(<=|≤|<|up\\s*to|upto|less than|below|upper limit|maximum|max\\.?)\\s*:?\\s*${NUM}`, 'i'));
  if (m) { const incl = /^(<=|≤|up|upto)/i.test(m[1]); return { kind: 'range', low: null, high: +m[2], lowIncl: true, highIncl: incl }; }
  m = t.match(new RegExp(`(>=|≥|>|greater than|above|more than|minimum|min\\.?|at least)\\s*:?\\s*${NUM}`, 'i'));
  if (m) { const incl = /^(>=|≥|at least|min)/i.test(m[1]); return { kind: 'range', low: +m[2], high: null, lowIncl: incl, highIncl: true }; }
  return null;
}

function evaluate(value, q, r) {
  const { low, high } = r; const lowIncl = r.lowIncl !== false, highIncl = r.highIncl !== false;
  const isLow = (v) => low != null && (lowIncl ? v < low : v <= low);
  const isHigh = (v) => high != null && (highIncl ? v > high : v >= high);
  if (!q) return isLow(value) ? 'low' : isHigh(value) ? 'high' : 'normal';
  if (q === '<' || q === '<=') {                    // true value is below the printed number
    if (high != null) {
      if (value > high || (value === high && !highIncl && q === '<=')) return 'verify';
      return (low == null || low <= 0) ? 'normal' : (value <= low ? 'low' : 'verify');
    }
    return low != null && value <= low ? 'low' : 'verify';
  }
  if (q === '>' || q === '>=') {                    // true value is above the printed number
    if (low != null) {
      if (value < low) return 'verify';
      return high == null ? 'normal' : (value >= high ? 'high' : 'verify');
    }
    return high != null && value >= high ? 'high' : 'verify';
  }
  return 'verify';
}

function flagDirection(flag) {
  const f = String(flag ?? '').trim().toLowerCase();
  if (!f) return null;
  if (/^(h|hh|high|h\*|\*h|↑|critical high|ch|\*)$/.test(f) || /\bhigh\b/.test(f)) return 'high';
  if (/^(l|ll|low|l\*|\*l|↓|critical low|cl)$/.test(f) || /\blow\b/.test(f)) return 'low';
  return null;
}

export const STATUS_LABEL = { normal: 'Normal', low: 'Low', high: 'High', verify: 'Needs verification' };

// result: { key, value, qualifier, unit, refText, refLow, refHigh, refLowIncl, refHighIncl, flag }
// ctx:    { sex: 'male'|'female'|null, adult: boolean }
export function classify(result, ctx = {}) {
  const out = { status: 'verify', reason: '', source: 'none', rangeText: '', rangeUnit: '', type: 'reference', range: null };
  const value = result.value;
  if (!Number.isFinite(value)) { out.reason = 'No numeric value to compare.'; return out; }
  const dir = flagDirection(result.flag);
  const q = result.qualifier || null;

  // 1. the laboratory's own range
  let lab = null;
  if (Number.isFinite(result.refLow) || Number.isFinite(result.refHigh)) {
    lab = { kind: 'range', low: Number.isFinite(result.refLow) ? result.refLow : null, high: Number.isFinite(result.refHigh) ? result.refHigh : null, lowIncl: result.refLowIncl !== false, highIncl: result.refHighIncl !== false };
  } else if (String(result.refText ?? '').trim()) {
    lab = parseRefText(result.refText, ctx.sex);
    if (!lab) { out.rangeText = clean(result.refText); out.reason = 'The reference range could not be read. Please check it.'; return out; }
    if (lab.kind === 'bands' || lab.kind === 'sex') { out.rangeText = clean(result.refText); out.reason = lab.reason; return out; }
    if (lab.kind === 'qualitative') { out.rangeText = clean(result.refText); out.reason = 'The lab range is descriptive, not numeric.'; return out; }
  }
  if (lab && lab.kind === 'range') {
    out.source = 'lab'; out.range = lab; out.rangeText = clean(result.refText) || formatRange(lab); out.rangeUnit = result.unit || '';
    out.status = evaluate(value, q, lab);
    if (out.status === 'verify') out.reason = 'The value is written as a limit (for example "<0.5"), so it cannot be placed exactly. Please check it.';
  } else {
    // 2. built-in fallback, adults only, compatible units only
    const key = result.key;
    if (!key) { out.reason = 'No reference range in the report and no built-in range for this test.'; return out; }
    if (ctx.adult !== true) { out.reason = 'The built-in ranges are for adults. Confirm the adult setting or enter the lab range.'; return out; }
    const b = builtinRange(key, ctx.sex);
    if (!b) { out.reason = 'No reference range in the report and no built-in range for this test.'; return out; }
    if (b.needsSex) { out.reason = 'This built-in range depends on sex. Choose the sex used for reference ranges.'; return out; }
    if (!result.unit) { out.reason = 'The unit is missing, so the value cannot be compared safely.'; return out; }
    const conv = convertValue(key, value, result.unit, b.unit);
    if (conv === null) { out.reason = `The unit (${result.unit}) cannot be reliably compared with the built-in unit (${b.unit}).`; return out; }
    out.source = 'builtin'; out.type = b.type; out.range = b; out.rangeUnit = b.unit;
    out.rangeText = `${formatRange(b)} ${b.unit}`.trim();
    out.status = evaluate(conv, q, b);
    if (out.status === 'verify') out.reason = 'The value is written as a limit, so it cannot be placed exactly. Please check it.';
    if (normUnit(result.unit) !== normUnit(b.unit) && out.status !== 'verify') out.reason = `Compared after converting ${result.unit} to ${b.unit}.`;
  }
  // 3. a lab flag that disagrees with the computed status needs a human look
  if (dir && (out.status === 'normal' || out.status === 'low' || out.status === 'high') && out.status !== dir) {
    out.reason = `The report flags this as ${dir}, but the comparison says ${out.status}. Please check the value and range.`;
    out.status = 'verify';
  }
  return out;
}
