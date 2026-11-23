// My Health - unit normalisation and reliable unit conversion.
// A conversion is only offered when it is a well-established exact factor. Anything else returns null,
// and callers must then say "direct comparison unavailable" instead of guessing.

export function normUnit(u) {
  let s = String(u ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/[µμ]/g, 'u').replace(/³/g, '3').replace(/⁶/g, '6').replace(/⁹/g, '9').replace(/¹²/g, '12').replace(/²/g, '2')
    .replace(/\s+/g, '').replace(/\.(?!\d)/g, '').replace(/\*/g, '').replace(/\^/g, '').replace(/^x(?=\d)/, '').replace(/^×(?=\d)/, '');
  const table = [
    [/^(cells\/ul|\/ul|\/cumm|\/cu\.?mm|\/mm3|cells\/cumm|cells\/mm3|percumm|permm3|cumm|\/cmm|cells\/cmm)$/, 'cells/ul'],
    [/^(10(e)?3\/ul|10(e)?3\/mm3|thou\/ul|thousand\/ul|thousand\/cumm|thou\/cumm|k\/ul|10(e)?9\/l|109\/l|10e9\/l|th\/ul|th\/cumm|10\^3\/ul|10\^9\/l)$/, 'k/ul'],
    [/^(lakhs?\/cumm|lakhs?\/mm3|lakhs?\/ul|lac\/cumm|lacs?\/cumm)$/, 'lakh/ul'],
    [/^(million\/ul|10(e)?6\/ul|106\/ul|mill\/cumm|million\/cumm|mil\/cumm|mill\/mm3|million\/mm3|10(e)?12\/l|1012\/l|m\/ul|mill\/ul|mil\/ul|millions\/cumm)$/, 'million/ul'],
    [/^(g\/dl|gm\/dl|gms\/dl|g%|gm%|gm\/100ml|g\/100ml)$/, 'g/dl'],
    [/^(mg\/dl|mg%|mg\/100ml)$/, 'mg/dl'],
    [/^(iu\/l|u\/l|units\/l|iu\/litre|iu\/liter|u\/litre)$/, 'u/l'],
    [/^(ug\/dl|mcg\/dl|ug%)$/, 'ug/dl'],
    [/^(miu\/l|uiu\/ml|mu\/l|miu\/litre|uiu\/ml\.?)$/, 'miu/l'],
    [/^(ml\/min\/1\.?73m2|ml\/min\/1\.?73sqm|ml\/min\/1\.?73m)$/, 'ml/min/1.73m2'],
    [/^(fl|femtolitre|femtoliter)$/, 'fl'],
    [/^(percent|%)$/, '%'],
  ];
  for (const [re, out] of table) if (re.test(s)) return out;
  return s;
}

const GENERAL = {   // exact, analyte-independent
  'k/ul>cells/ul': 1000, 'cells/ul>k/ul': 1 / 1000,
  'lakh/ul>cells/ul': 100000, 'cells/ul>lakh/ul': 1 / 100000,
  'g/l>g/dl': 0.1, 'g/dl>g/l': 10,
  'mg/l>mg/dl': 0.1, 'mg/dl>mg/l': 10,
  'ug/l>ng/ml': 1, 'ng/ml>ug/l': 1,
  'miu/l>miu/l': 1,
};
const MONOVALENT = new Set(['sodium', 'potassium', 'chloride', 'bicarbonate']);   // mmol/L == mEq/L
const FACTOR_BY_KEY = {   // [from unit, to unit, factor]; molar masses are standard values
  glucose_fasting: [['mmol/l', 'mg/dl', 18.016]], glucose_pp: [['mmol/l', 'mg/dl', 18.016]], glucose_random: [['mmol/l', 'mg/dl', 18.016]],
  cholesterol_total: [['mmol/l', 'mg/dl', 38.67]], ldl: [['mmol/l', 'mg/dl', 38.67]], hdl: [['mmol/l', 'mg/dl', 38.67]], non_hdl: [['mmol/l', 'mg/dl', 38.67]], vldl: [['mmol/l', 'mg/dl', 38.67]],
  triglycerides: [['mmol/l', 'mg/dl', 88.57]],
  creatinine: [['umol/l', 'mg/dl', 1 / 88.4]],
  uric_acid: [['umol/l', 'mg/dl', 1 / 59.48]],
  bilirubin_total: [['umol/l', 'mg/dl', 1 / 17.1]], bilirubin_direct: [['umol/l', 'mg/dl', 1 / 17.1]],
  blood_urea: [['mmol/l', 'mg/dl', 6.006]],
  calcium_total: [['mmol/l', 'mg/dl', 4.008]], magnesium: [['mmol/l', 'mg/dl', 2.431]], phosphorus: [['mmol/l', 'mg/dl', 3.097]],
  vitamin_d: [['nmol/l', 'ng/ml', 0.4006]], vitamin_b12: [['pmol/l', 'pg/ml', 1.355]],
  iron: [['umol/l', 'ug/dl', 5.585]], zinc: [['umol/l', 'ug/dl', 6.54]],
  free_t4: [['pmol/l', 'ng/dl', 1 / 12.87]], free_t3: [['pmol/l', 'pg/ml', 1 / 1.536]],
  total_t3: [['nmol/l', 'ng/dl', 65.1]], total_t4: [['nmol/l', 'ug/dl', 1 / 12.87]],
};

// Convert value from one unit to another for a given standard key. Returns a number, or null if not reliable.
export function convertValue(key, value, from, to) {
  const f = normUnit(from), t = normUnit(to);
  if (!Number.isFinite(value)) return null;
  if (f === t) return value;
  if (key === 'hba1c') {                       // NGSP % <-> IFCC mmol/mol (linear master equation)
    if (f === 'mmol/mol' && t === '%') return value * 0.09148 + 2.152;
    if (f === '%' && t === 'mmol/mol') return (value - 2.152) / 0.09148;
    return null;
  }
  if (MONOVALENT.has(key) && ((f === 'meq/l' && t === 'mmol/l') || (f === 'mmol/l' && t === 'meq/l'))) return value;
  const g = GENERAL[`${f}>${t}`];
  if (g != null) return value * g;
  for (const [a, b, k] of FACTOR_BY_KEY[key] || []) {
    if (f === a && t === b) return value * k;
    if (f === b && t === a) return value / k;
  }
  // two-step: general factor then key factor (e.g. g/L protein is handled above; keep it simple and honest)
  return null;
}

export function unitsCompatible(key, a, b) {
  const x = normUnit(a), y = normUnit(b);
  if (x === y) return true;
  return convertValue(key, 1, a, b) !== null;
}
