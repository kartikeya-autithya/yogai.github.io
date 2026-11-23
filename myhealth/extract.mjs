// My Health - turn report text (PDF text layer or OCR lines) into structured results.
// Pure functions: no DOM, no network. Nothing is invented: a field that cannot be read stays empty and is flagged.
import { findKey, BY_KEY, GROUP_LABEL } from './reference-db.mjs';
import { parseRefText } from './classify.mjs';

// ---------- lines from pdf.js text items ({ str, x, y, w }) ----------
export function buildLinesFromItems(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    let row = rows.find((r) => Math.abs(r.y - it.y) <= 3);
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);                 // pdf y grows upwards
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let s = '', prevEnd = null;
    for (const it of r.items) {
      if (prevEnd !== null) s += it.x - prevEnd > 6 ? '   ' : (it.x - prevEnd > 0.5 ? ' ' : '');
      s += it.str; prevEnd = it.x + (it.w || it.str.length * 4);
    }
    return s.replace(/\s+$/, '');
  });
}

// ---------- dates ----------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*';
const pad = (n) => String(n).padStart(2, '0');
function mkIso(y, m, d, today) {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  if (today && iso > today) return null;          // a test cannot be in the future
  return iso;
}
// returns [{ iso, ambiguous, raw, index }]
export function findDates(line, today = null) {
  const out = []; const taken = [];
  const free = (i, len) => !taken.some(([a, b]) => i < b && i + len > a);
  const push = (m, iso, ambiguous = false) => { if (iso && free(m.index, m[0].length)) { taken.push([m.index, m.index + m[0].length]); out.push({ iso, ambiguous, raw: m[0], index: m.index }); } };
  let m, re;
  re = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g; while ((m = re.exec(line))) push(m, mkIso(+m[1], +m[2], +m[3], today));
  re = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[-/. ]+${MON_RE}[-/. ,]+(\\d{2,4})\\b`, 'gi'); while ((m = re.exec(line))) push(m, mkIso(+m[3] ? +m[3] : 0, MON[m[2].toLowerCase()], +m[1], today));
  re = new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'); while ((m = re.exec(line))) push(m, mkIso(+m[3], MON[m[1].toLowerCase()], +m[2], today));
  re = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g;
  while ((m = re.exec(line))) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12) push(m, mkIso(y, b, a, today));
    else if (b > 12) push(m, mkIso(y, a, b, today));
    else push(m, mkIso(y, b, a, today), a !== b);   // day/month assumed, but flagged as ambiguous
  }
  return out.sort((x, y) => x.index - y.index);
}

const LABELS = [
  ['collection', /(sample\s*(?:collected|collection|date|drawn|taken)|specimen\s*(?:collected|collection|date)|date\s*of\s*(?:collection|sampling|sample)|collection\s*(?:date|time|on)?|collected\s*(?:on|at|date)?|collected|drawn|sampling\s*date|coll\.?\s*date|sample\s*on|test\s*date|date\s*of\s*test)/gi],
  ['registered', /(registered|registration|received|accession(?:ed)?|booked|booking|ordered|order\s*date|reg\.?\s*date)/gi],
  ['report', /(report(?:ed)?\s*(?:on|date|time)?|generated|printed|authori[sz]ed|approved|released|issued|validated|verified|final\s*report)/gi],
];
// assign each date in a line to the nearest preceding label ('collection' | 'registered' | 'report' | 'unlabeled')
export function labelDates(line, dates) {
  const marks = [];
  for (const [type, re] of LABELS) { re.lastIndex = 0; let m; while ((m = re.exec(line))) marks.push({ type, at: m.index, end: m.index + m[0].length }); }
  return dates.map((d) => {
    const before = marks.filter((k) => k.end <= d.index + 1 && d.index - k.end < 45).sort((a, b) => b.end - a.end)[0];
    return { ...d, type: before ? before.type : 'unlabeled' };
  });
}

// ---------- row parsing ----------
const NUM_TOK = /^([<>]=?|≤|≥)?(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)([HL*↑↓])?$/;
const FLAG_TOK = /^\(?(H|L|HH|LL|High|Low|\*|↑|↓|H\*|L\*|Critical|Abnormal)\)?$/i;
const QUAL_TOK = /^(negative|positive|nil|absent|present|trace|reactive|non[- ]?reactive|detected|not detected)$/i;
const STOP_NAME = /^(age|sex|gender|date|dob|patient|name|ref|referred|referring|doctor|dr|sample|specimen|lab|barcode|mobile|phone|tel|page|id|uhid|mrn|visit|time|bill|invoice|address|email|registered|collected|reported|received|printed|authori[sz]ed|accession|sid|pid|collection|report|test name|investigation|method|note|notes|comment|comments|interpretation|reference|bio|biological|result|results|units?|www|http|pin|fax|customer|client|order|status|regn?|barcode|sample type|reg no|lab no|ward|bed)\b/i;
const BAND_START = /^(desirable|optimal|borderline|near optimal|above optimal|high risk|very high|intermediate|normal|low risk|prediabet|diabet|deficien|insufficien|sufficien|toxic|male|female|men|women|adult|children|child|reference|bio\.?\s*ref|ref\.?)\b/i;
const METHOD_WORDS = /\b(method|calculated|automated|photometry|spectrophotometry|cyanide|sls|ise|hplc|clia|elisa|ecl|cmia|enzymatic|colorimetric|impedance|flow cytometry|jaffe|uricase|gpo|ifcc|calc|direct)\b/i;
const REF_START = /(?:^|\s)((?:<=|>=|≤|≥|<|>)\s*-?\d|(?:up\s*to|upto|less\s+than|greater\s+than|below|above|upper\s+limit|male\b|female\b|desirable|optimal|borderline|negative\b|nil\b)|-?\d[\d,]*\.?\d*\s*(?:-|to)\s*-?\d)/i;
const UNIT_OK = /^[A-Za-zµμ%/0-9.^³²⁶⁹¹\-× ()]{1,26}$/;

function cleanName(n) {
  return n.replace(/[.·…_]{2,}/g, ' ').replace(/^\W*\d{1,2}[.)]\s+(?=[A-Za-z])/, '').replace(/[:\-–\s]+$/g, '').replace(/\s+/g, ' ').trim();
}
function keyFor(name) {
  let k = findKey(name);
  if (k) return k;
  let n = name.replace(/\([^)]*\)/g, (p) => (METHOD_WORDS.test(p) ? '' : p)).replace(/\s+/g, ' ').trim();
  k = findKey(n); if (k) return k;
  const w = n.split(' ');
  for (let cut = 1; cut <= 3 && w.length - cut >= 1; cut++) {
    const tail = w.slice(-cut).join(' ');
    if (METHOD_WORDS.test(tail) || /^(sls|method)$/i.test(tail)) { k = findKey(w.slice(0, -cut).join(' ')); if (k) return k; }
  }
  return null;
}

// Parse the part of a line after the value token into { flag, unit, refText, odd }
function parseTail(tokens) {
  let flag = '';
  let rest = tokens.slice();
  while (rest.length && FLAG_TOK.test(rest[0])) { flag = flag || rest[0].replace(/[()]/g, ''); rest.shift(); }
  let s = rest.join(' ');
  const tf = s.match(/\s+(H|L|HH|LL|High|Low|\*|↑|↓)$/);
  if (tf) { flag = flag || tf[1]; s = s.slice(0, tf.index); }
  s = s.replace(/\s+(normal|abnormal)$/i, '');
  const m = s.match(REF_START);
  let unit = s, refText = '';
  if (m) { const i = m.index + (m[0].length - m[1].length); unit = s.slice(0, i).trim(); refText = s.slice(i).trim(); }
  unit = unit.replace(/^[\s:|]+|[\s:|]+$/g, '');
  let odd = false;
  if (unit && !UNIT_OK.test(unit)) { odd = true; unit = ''; }
  refText = refText.replace(/\s*(mg\/dl|g\/dl|u\/l|iu\/l|mmol\/l|ng\/ml|pg\/ml|%|fl|pg|cells\/[µu]l|\/cumm|miu\/l|ng\/dl|[µu]g\/dl)\s*$/i, '').trim();
  return { flag, unit, refText, odd };
}

function parseRow(text) {
  const toks = text.replace(/\u00a0/g, ' ').replace(/[–—−]/g, '-').replace(/\|/g, ' ').replace(/([<>≤≥]=?)\s+(?=\d)/g, '$1').replace(/\s+/g, ' ').trim().split(' ');
  if (toks.length < 2) return null;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    const isNum = NUM_TOK.test(t); const isQual = QUAL_TOK.test(t);
    if (!isNum && !isQual) continue;
    const nameToks = toks.slice(0, i);
    const name = cleanName(nameToks.join(' '));
    if (!/[A-Za-z]{2}/.test(name)) { continue; }                 // e.g. "25" at the start of "25 OH Vitamin D"
    const m = isNum ? t.match(NUM_TOK) : null;
    const tail = parseTail(toks.slice(i + 1));
    const flagFromValue = m && m[3] ? m[3] : '';
    return { name, nameToks, valueTok: t, m, qual: isQual ? t : null, ...tail, flag: tail.flag || flagFromValue, rawTail: toks.slice(i + 1) };
  }
  return null;
}

// ---------- document-level helpers ----------
function findLab(lines) {
  const re = /(laborator|diagnostic|pathlab|path lab|patholog|\blabs?\b|hospital|clinic|healthcare|health care|metropolis|thyrocare|\bsrl\b|apollo|redcliffe|orange health|1mg|medical centre|medical center|scan centre)/i;
  for (const l of lines.slice(0, 18)) { const t = l.replace(/\s{2,}/g, '  ').trim(); if (t.length >= 4 && t.length <= 90 && re.test(t) && !/report|patient|collected|reported|date/i.test(t)) return t.replace(/\s+/g, ' '); }
  return null;
}
function findPatientHints(lines) {
  const hints = { sex: null, ageYears: null };
  for (const l of lines.slice(0, 40)) {
    let m = l.match(/\b(?:sex|gender)\s*[:\-]?\s*(male|female|m|f)\b/i);
    if (m && !hints.sex) hints.sex = /^f/i.test(m[1]) ? 'female' : 'male';
    m = l.match(/\bage\s*(?:\/\s*(?:sex|gender))?\s*[:\-]?\s*(\d{1,3})\s*(?:years?|yrs?|y)?\s*(?:\/\s*([MF]|male|female))?\b/i);
    if (m && hints.ageYears == null && !/month|day/i.test(l.slice(m.index, m.index + 24))) hints.ageYears = +m[1];
    if (m && m[2] && !hints.sex) hints.sex = /^f/i.test(m[2]) ? 'female' : 'male';
  }
  return hints;
}

let _uid = 0;
const uid = () => `r${Date.now().toString(36)}${(++_uid).toString(36)}`;

// pages: [{ lines: [ 'text' | { text, conf } ], ocr: boolean }]
export function parseReport(pages, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const allText = [];
  const datesFound = [];
  const results = [];
  const warnings = [];
  let currentDate = null;           // { iso, ambiguous }
  let columnDates = null;
  let pendingName = null;
  let lastRow = null, lastRowAge = 99;

  pages.forEach((pg, pIdx) => {
    pendingName = null; lastRow = null;
    for (const raw of pg.lines) {
      const text = (typeof raw === 'string' ? raw : raw.text || '').replace(/\s+$/, '');
      const conf = typeof raw === 'string' ? null : (Number.isFinite(raw.conf) ? raw.conf : null);
      if (!text.trim()) continue;
      allText.push(text);
      lastRowAge++;

      // dates
      const ds = labelDates(text, findDates(text, today));
      let hadDate = false;
      for (const d of ds) {
        datesFound.push({ iso: d.iso, type: d.type, ambiguous: d.ambiguous, raw: d.raw, page: pIdx + 1 });
        if (d.type === 'collection') { currentDate = { iso: d.iso, ambiguous: d.ambiguous }; hadDate = true; }
      }
      if (ds.length >= 2 && ds.every((d) => d.type === 'unlabeled' || d.type === 'collection') && !/[<>]/.test(text) && (text.match(/\d+(?:\.\d+)?\s*(?:-|to)\s*\d/g) || []).length === 0) {
        columnDates = ds.map((d) => ({ iso: d.iso, ambiguous: d.ambiguous }));
      }
      if (hadDate && !parseRow(text)?.m) continue;

      // multi-line name: previous line was a bare name, this one starts with a value
      let rowText = text;
      if (pendingName && NUM_TOK.test(text.trim().split(/\s+/)[0] || '')) rowText = `${pendingName} ${text.trim()}`;
      pendingName = null;

      const row = parseRow(rowText);
      const nameStart = rowText.trim();
      if (!row || STOP_NAME.test(nameStart) || BAND_START.test(nameStart)) {
        // continuation of the previous row's reference range (several categories, male/female ranges)
        if (lastRow && lastRowAge <= 6 && BAND_START.test(nameStart)) {
          lastRow.ref_text = `${lastRow.ref_text ? lastRow.ref_text + ' ; ' : ''}${nameStart}`.trim();
          lastRow.reasons.push('Reference range spans several lines'); lastRow.uncertain = true; lastRowAge = 0;
        } else if (!row && /^[A-Za-z][A-Za-z0-9 ,()/%+.\-]{2,60}$/.test(nameStart) && nameStart.split(' ').length <= 8 && !STOP_NAME.test(nameStart) && !BAND_START.test(nameStart)) {
          pendingName = nameStart;
        }
        continue;
      }
      if (row.name.length > 80 || row.name.split(' ').length > 9) continue;

      const key = keyFor(row.name);
      const hasInfo = !!(row.unit || row.refText);
      if (!hasInfo && !key && !row.qual) continue;                 // free text, not a test row

      const qualifier = row.m && row.m[1] ? row.m[1] : null;
      const value = row.m ? Number(row.m[2].replace(/,/g, '')) : null;
      const reasons = [];
      if (pg.ocr) reasons.push('Read from an image');
      if (!row.unit && value !== null && !(key && BY_KEY[key]?.unit === 'ratio')) reasons.push('Unit not found');
      if (row.odd) reasons.push('Unit text unclear');
      if (row.refText) { const pr = parseRefText(row.refText); if (!pr) reasons.push('Reference range unclear'); }
      if (pg.ocr && conf !== null && conf < 80) reasons.push(`Low OCR confidence (${Math.round(conf)}%)`);
      if (row.qual) reasons.push('Non-numeric result');

      const base = {
        original_name: row.name, standard_key: key, standard_name: key ? BY_KEY[key].name : row.name,
        group: key ? BY_KEY[key].group : 'other', value_num: value, value_text: row.m ? row.m[2] : row.qual, qualifier,
        unit: row.unit || '', ref_text: row.refText || '', flag: row.flag || '', page: pIdx + 1,
        source: pg.ocr ? 'ocr' : 'text', conf,
      };
      // several result columns, each with its own date (trend table)
      if (columnDates && value !== null) {
        const nums = []; for (const tk of row.rawTail) { if (NUM_TOK.test(tk) && !NUM_TOK.exec(tk)[1]) nums.push(Number(tk.replace(/,/g, ''))); else break; }
        const afterVals = row.rawTail.slice(nums.length);
        if (nums.length + 1 === columnDates.length && !/^(-|to)$/i.test(afterVals[0] || '')) {
          const tail2 = parseTail(afterVals);
          [value, ...nums].forEach((v, i) => results.push({ id: uid(), ...base, value_num: v, value_text: String(v), unit: tail2.unit, ref_text: tail2.refText, flag: '', test_date: columnDates[i].iso, test_date_ambiguous: columnDates[i].ambiguous, reasons: [...reasons, 'Several dated columns'], uncertain: true }));
          lastRow = null; continue;
        }
      }
      const r = { id: uid(), ...base, test_date: currentDate ? currentDate.iso : null, test_date_ambiguous: currentDate ? currentDate.ambiguous : false, reasons, uncertain: reasons.some((x) => x !== 'Read from an image' && x !== 'Non-numeric result') || (row.qual != null) };
      results.push(r); lastRow = r; lastRowAge = 0;
    }
  });

  // rows that appeared before any dated line: use the document's single collection date, otherwise leave blank
  const collections = [...new Map(datesFound.filter((d) => d.type === 'collection').map((d) => [d.iso, d])).values()];
  if (collections.length === 1) for (const r of results) if (!r.test_date) { r.test_date = collections[0].iso; r.test_date_ambiguous = collections[0].ambiguous; }
  for (const r of results) { if (!r.test_date) { r.reasons.push('Test date not found'); r.uncertain = true; } if (r.test_date_ambiguous) { r.reasons.push('Date could be day/month or month/day'); r.uncertain = true; } }

  const distinct = [...new Set(results.map((r) => r.test_date).filter(Boolean))];
  if (distinct.length > 1) warnings.push(`This file has results from ${distinct.length} different dates. Each date will be saved as its own record.`);
  if (!collections.length) warnings.push('No collection date was found in the report. Please enter the actual test date; the report/print date is not used automatically.');
  if (!results.length) warnings.push('No test results could be read from this file.');
  const reportDate = datesFound.find((d) => d.type === 'report') || null;
  return {
    labName: findLab(allText), patient: findPatientHints(allText), results, warnings, datesFound,
    testDate: collections.length === 1 ? collections[0] : null, reportDate, groupLabels: GROUP_LABEL,
  };
}
