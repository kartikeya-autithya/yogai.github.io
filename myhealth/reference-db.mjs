// My Health - built-in reference database.
// GENERAL ADULT reference ranges for informational comparison ONLY. They are a FALLBACK used when a report
// does not print its own range. A laboratory's own reference interval always takes priority (see classify.mjs).
// To add a parameter, append one R(...) line. Nothing else needs to change.
//
// R(key, standardName, group, unit, aliases[], ranges[], { type, note })
//   ranges: [{ sex:'any'|'male'|'female', low, high, lowIncl, highIncl }]   (low/high may be null = one-sided)
//   type:   'reference' (a reference interval) | 'target' (a desirable/general target, not a diagnostic threshold)

export const GROUPS = [
  { id: 'cbc', label: 'Complete Blood Count' },
  { id: 'diff', label: 'Differential Leukocyte Count' },
  { id: 'glucose', label: 'Blood Glucose & Diabetes Screening' },
  { id: 'lipid', label: 'Lipid Profile' },
  { id: 'liver', label: 'Liver Function' },
  { id: 'kidney', label: 'Kidney Function' },
  { id: 'electrolytes', label: 'Electrolytes' },
  { id: 'thyroid', label: 'Thyroid Profile' },
  { id: 'vitamins', label: 'Vitamins & Minerals' },
  { id: 'iron', label: 'Iron Studies' },
  { id: 'other', label: 'Other Tests' },
];

const between = (low, high, sex = 'any') => ({ sex, low, high, lowIncl: true, highIncl: true });
const below = (high, sex = 'any') => ({ sex, low: null, high, lowIncl: true, highIncl: false });   // "below 200"
const atLeast = (low, sex = 'any') => ({ sex, low, high: null, lowIncl: true, highIncl: true });   // "40 or above"

const REF = [];
function R(key, name, group, unit, aliases, ranges, opts = {}) {
  REF.push({ key, name, group, unit, aliases, ranges, type: opts.type || 'reference', note: opts.note || '' });
}

// ---- A. Complete Blood Count
R('hemoglobin', 'Haemoglobin', 'cbc', 'g/dL', ['hb', 'hgb', 'haemoglobin', 'hemoglobin', 'hb hgb', 'hemoglobin hb', 'haemoglobin hb', 'haemoglobin (hb)'], [between(13.5, 17.5, 'male'), between(12.0, 15.5, 'female')]);
R('rbc', 'RBC count', 'cbc', 'million/µL', ['rbc', 'rbc count', 'red blood cell count', 'red blood cells', 'red cell count', 'erythrocyte count', 'total rbc count', 'rbc count total'], [between(4.5, 5.9, 'male'), between(4.1, 5.1, 'female')]);
R('wbc', 'WBC count', 'cbc', 'cells/µL', ['wbc', 'wbc count', 'tlc', 'total leucocyte count', 'total leukocyte count', 'total wbc count', 'white blood cell count', 'white blood cells', 'leucocyte count', 'leukocyte count', 'total leucocytes count', 'tlc total leucocyte count'], [between(4000, 11000)]);
R('platelets', 'Platelet count', 'cbc', 'cells/µL', ['platelets', 'platelet count', 'plt', 'platelet', 'thrombocyte count', 'platelets count'], [between(150000, 450000)]);
R('hematocrit', 'Haematocrit', 'cbc', '%', ['hct', 'pcv', 'packed cell volume', 'haematocrit', 'hematocrit', 'pcv hct', 'haematocrit pcv', 'hematocrit hct'], [between(41, 53, 'male'), between(36, 46, 'female')]);
R('mcv', 'MCV', 'cbc', 'fL', ['mcv', 'mean corpuscular volume', 'mean cell volume'], [between(80, 100)]);
R('mch', 'MCH', 'cbc', 'pg', ['mch', 'mean corpuscular hemoglobin', 'mean corpuscular haemoglobin', 'mean cell hemoglobin'], [between(27, 33)]);
R('mchc', 'MCHC', 'cbc', 'g/dL', ['mchc', 'mean corpuscular hemoglobin concentration', 'mean corpuscular haemoglobin concentration'], [between(32, 36)]);
R('rdw_cv', 'RDW-CV', 'cbc', '%', ['rdw cv', 'rdw', 'rdw cv %', 'red cell distribution width', 'red cell distribution width cv'], [between(11.5, 14.5)]);

// ---- B. Differential leukocyte count (percentages)
R('neutrophils', 'Neutrophils', 'diff', '%', ['neutrophils', 'neutrophil', 'neutrophils %', 'neutrophil %', 'polymorphs', 'polymorphonuclear leucocytes', 'segmented neutrophils', 'neutrophils percent'], [between(40, 70)]);
R('lymphocytes', 'Lymphocytes', 'diff', '%', ['lymphocytes', 'lymphocyte', 'lymphocytes %', 'lymphocyte %', 'lymphocytes percent'], [between(20, 40)]);
R('monocytes', 'Monocytes', 'diff', '%', ['monocytes', 'monocyte', 'monocytes %', 'monocyte %'], [between(2, 8)]);
R('eosinophils', 'Eosinophils', 'diff', '%', ['eosinophils', 'eosinophil', 'eosinophils %', 'eosinophil %'], [between(1, 4)]);
R('basophils', 'Basophils', 'diff', '%', ['basophils', 'basophil', 'basophils %', 'basophil %'], [between(0, 1)]);

// ---- C. Blood glucose
R('glucose_fasting', 'Fasting glucose', 'glucose', 'mg/dL', ['fbs', 'fasting blood sugar', 'fasting glucose', 'glucose fasting', 'blood sugar fasting', 'fasting plasma glucose', 'fpg', 'glucose f', 'blood glucose fasting', 'fasting blood glucose', 'fbg', 'glucose plasma fasting'], [between(70, 99)]);
R('glucose_pp', '2-hour post-meal glucose', 'glucose', 'mg/dL', ['ppbs', 'pp blood sugar', 'post prandial glucose', 'postprandial glucose', 'post prandial blood sugar', 'postprandial blood sugar', '2 hour post meal glucose', 'glucose pp', 'glucose post prandial', 'blood sugar pp', 'pp glucose', 'blood glucose post prandial', 'glucose 2 hr post meal', 'ppbs 2 hours'], [below(140)], { note: 'Usually below 140 mg/dL, two hours after a meal.' });
R('hba1c', 'HbA1c', 'glucose', '%', ['hba1c', 'glycosylated hemoglobin', 'glycosylated haemoglobin', 'glycated hemoglobin', 'glycated haemoglobin', 'a1c', 'glycohemoglobin', 'hemoglobin a1c', 'haemoglobin a1c', 'hb a1c', 'hba1c glycosylated hemoglobin'], [below(5.7)], { note: 'The 5.7% limit is a screening threshold, not a diagnosis.' });
R('glucose_random', 'Random glucose', 'glucose', 'mg/dL', ['rbs', 'random blood sugar', 'random glucose', 'glucose random', 'blood sugar random', 'blood glucose random', 'glucose'], []);

// ---- D. Lipids (general adult targets, not diagnostic thresholds)
const LT = { type: 'target', note: 'General adult target, not a universal diagnostic threshold.' };
R('cholesterol_total', 'Total cholesterol', 'lipid', 'mg/dL', ['total cholesterol', 'cholesterol total', 'cholesterol', 'serum cholesterol', 't cholesterol', 'tc', 'cholesterol t'], [below(200)], LT);
R('ldl', 'LDL cholesterol', 'lipid', 'mg/dL', ['ldl', 'ldl cholesterol', 'ldl c', 'ldl cholesterol direct', 'ldl cholesterol calculated', 'ldl direct', 'ldl calculated', 'low density lipoprotein', 'ldl cholesterol calc'], [below(100)], LT);
R('hdl', 'HDL cholesterol', 'lipid', 'mg/dL', ['hdl', 'hdl cholesterol', 'hdl c', 'high density lipoprotein', 'hdl cholesterol direct'], [atLeast(40, 'male'), atLeast(50, 'female')], LT);
R('triglycerides', 'Triglycerides', 'lipid', 'mg/dL', ['triglycerides', 'triglyceride', 'tg', 'serum triglycerides', 'triglycerides serum'], [below(150)], LT);
R('vldl', 'VLDL cholesterol', 'lipid', 'mg/dL', ['vldl', 'vldl cholesterol', 'very low density lipoprotein', 'vldl cholesterol calculated'], [between(5, 40)]);
R('chol_hdl_ratio', 'Total cholesterol/HDL ratio', 'lipid', 'ratio', ['total cholesterol hdl ratio', 'chol hdl ratio', 'tc hdl ratio', 'cholesterol hdl ratio', 'total cholesterol/hdl ratio', 'tc/hdl ratio', 'chol/hdl ratio', 'cholesterol/hdl ratio', 'total chol hdl ratio', 'tchol hdl ratio'], [below(5)], { type: 'target', note: 'Preferably below 5. A general target, not a diagnostic threshold.' });
R('non_hdl', 'Non-HDL cholesterol', 'lipid', 'mg/dL', ['non hdl cholesterol', 'non hdl', 'non hdl c'], []);
R('ldl_hdl_ratio', 'LDL/HDL ratio', 'lipid', 'ratio', ['ldl hdl ratio', 'ldl/hdl ratio'], []);

// ---- E. Liver function
R('alt', 'ALT (SGPT)', 'liver', 'U/L', ['alt', 'sgpt', 'alanine aminotransferase', 'alanine transaminase', 'alt sgpt', 'sgpt alt', 'alt/sgpt', 'sgpt/alt', 'serum glutamic pyruvic transaminase', 'alanine amino transferase', 'sgpt alanine aminotransferase', 'alt (sgpt)'], [between(7, 56)]);
R('ast', 'AST (SGOT)', 'liver', 'U/L', ['ast', 'sgot', 'aspartate aminotransferase', 'aspartate transaminase', 'ast sgot', 'sgot ast', 'ast/sgot', 'sgot/ast', 'serum glutamic oxaloacetic transaminase', 'aspartate amino transferase', 'sgot aspartate aminotransferase', 'ast (sgot)'], [between(10, 40)]);
R('alp', 'ALP', 'liver', 'U/L', ['alp', 'alkaline phosphatase', 'alk phos', 'alkaline phosphatase alp', 'alk phosphatase'], [between(44, 147)]);
R('ggt', 'GGT', 'liver', 'U/L', ['ggt', 'ggtp', 'gamma gt', 'gamma glutamyl transferase', 'gamma glutamyl transpeptidase', 'gamma glutamyl transferase ggt', 'gamma-gt'], [between(8, 61, 'male'), between(5, 36, 'female')]);
R('bilirubin_total', 'Total bilirubin', 'liver', 'mg/dL', ['total bilirubin', 'bilirubin total', 'bilirubin', 't bilirubin', 'serum bilirubin total', 'bilirubin t', 'bilirubin-total'], [between(0.1, 1.2)]);
R('bilirubin_direct', 'Direct bilirubin', 'liver', 'mg/dL', ['direct bilirubin', 'bilirubin direct', 'd bilirubin', 'conjugated bilirubin', 'bilirubin conjugated', 'bilirubin d'], [between(0, 0.3)]);
R('bilirubin_indirect', 'Indirect bilirubin', 'liver', 'mg/dL', ['indirect bilirubin', 'bilirubin indirect', 'unconjugated bilirubin', 'i bilirubin'], []);
R('albumin', 'Albumin', 'liver', 'g/dL', ['albumin', 'serum albumin', 'albumin serum', 'albumin alb'], [between(3.5, 5.0)]);
R('total_protein', 'Total protein', 'liver', 'g/dL', ['total protein', 'protein total', 'serum protein', 'total proteins', 'proteins total', 'protein'], [between(6.0, 8.3)]);
R('globulin', 'Globulin', 'liver', 'g/dL', ['globulin', 'serum globulin'], []);
R('ag_ratio', 'A/G ratio', 'liver', 'ratio', ['a g ratio', 'a/g ratio', 'albumin globulin ratio', 'albumin/globulin ratio', 'ag ratio'], []);

// ---- F. Kidney function
R('creatinine', 'Serum creatinine', 'kidney', 'mg/dL', ['creatinine', 'serum creatinine', 'creatinine serum', 's creatinine', 'creatinine s'], [between(0.7, 1.3, 'male'), between(0.6, 1.1, 'female')]);
R('blood_urea', 'Blood urea', 'kidney', 'mg/dL', ['urea', 'blood urea', 'serum urea', 'urea serum', 'urea blood'], [between(15, 40)]);
R('bun', 'BUN', 'kidney', 'mg/dL', ['bun', 'blood urea nitrogen', 'urea nitrogen', 'bun blood urea nitrogen', 'serum bun'], [between(7, 20)]);
R('uric_acid', 'Uric acid', 'kidney', 'mg/dL', ['uric acid', 'serum uric acid', 'uric acid serum', 's uric acid'], [between(3.4, 7.0, 'male'), between(2.4, 6.0, 'female')]);
R('egfr', 'eGFR', 'kidney', 'mL/min/1.73 m²', ['egfr', 'estimated gfr', 'gfr', 'estimated glomerular filtration rate', 'egfr estimated', 'e gfr'], [atLeast(90)], { type: 'target', note: '90 or above is a general level; kidney staging needs a clinician.' });

// ---- G. Electrolytes
R('sodium', 'Sodium', 'electrolytes', 'mmol/L', ['sodium', 'na', 'serum sodium', 'sodium serum', 'na+', 'sodium na'], [between(135, 145)]);
R('potassium', 'Potassium', 'electrolytes', 'mmol/L', ['potassium', 'k', 'serum potassium', 'potassium serum', 'k+', 'potassium k'], [between(3.5, 5.0)]);
R('chloride', 'Chloride', 'electrolytes', 'mmol/L', ['chloride', 'cl', 'serum chloride', 'chloride serum', 'cl-', 'chloride cl'], [between(98, 106)]);
R('bicarbonate', 'Bicarbonate', 'electrolytes', 'mmol/L', ['bicarbonate', 'hco3', 'total co2', 'co2', 'serum bicarbonate', 'bicarbonate hco3', 'hco3-'], [between(22, 29)]);
R('calcium_total', 'Calcium (total)', 'electrolytes', 'mg/dL', ['calcium', 'total calcium', 'calcium total', 'serum calcium', 'ca', 'calcium serum', 'calcium ca'], [between(8.5, 10.5)]);
R('magnesium', 'Magnesium', 'electrolytes', 'mg/dL', ['magnesium', 'mg', 'serum magnesium', 'magnesium serum', 'magnesium mg'], [between(1.7, 2.2)]);
R('phosphorus', 'Phosphorus', 'electrolytes', 'mg/dL', ['phosphorus', 'phosphate', 'inorganic phosphorus', 'phos', 'serum phosphorus', 'inorganic phosphate', 'phosphorus inorganic', 'serum phosphate'], [between(2.5, 4.5)]);

// ---- H. Thyroid
R('tsh', 'TSH', 'thyroid', 'mIU/L', ['tsh', 'thyroid stimulating hormone', 'tsh ultrasensitive', 'tsh 3rd generation', 'tsh third generation', 'thyrotropin', 'ultrasensitive tsh', 'tsh ultra sensitive'], [between(0.4, 4.0)]);
R('free_t4', 'Free T4', 'thyroid', 'ng/dL', ['free t4', 'ft4', 'free thyroxine', 'free thyroxine ft4', 't4 free', 'thyroxine free', 'ft4 free thyroxine'], [between(0.8, 1.8)]);
R('free_t3', 'Free T3', 'thyroid', 'pg/mL', ['free t3', 'ft3', 'free triiodothyronine', 'free triiodothyronine ft3', 't3 free', 'triiodothyronine free', 'ft3 free triiodothyronine'], [between(2.3, 4.2)]);
R('total_t3', 'Total T3', 'thyroid', 'ng/dL', ['t3', 'total t3', 'triiodothyronine', 't3 total', 'total triiodothyronine', 'triiodothyronine t3', 'triiodothyronine total'], [between(80, 200)]);
R('total_t4', 'Total T4', 'thyroid', 'µg/dL', ['t4', 'total t4', 'thyroxine', 't4 total', 'total thyroxine', 'thyroxine t4', 'thyroxine total'], [between(5, 12)]);

// ---- I. Vitamins, iron, minerals
R('vitamin_b12', 'Vitamin B12', 'vitamins', 'pg/mL', ['vitamin b12', 'vit b12', 'b12', 'cyanocobalamin', 'cobalamin', 'serum vitamin b12', 'vitamin b 12', 'vitamin b12 cyanocobalamin'], [between(200, 900)]);
R('vitamin_d', '25-OH Vitamin D', 'vitamins', 'ng/mL', ['25 oh vitamin d', 'vitamin d', 'vit d', '25 hydroxy vitamin d', '25 oh vit d', 'vitamin d 25 hydroxy', 'vitamin d total', 'vitamin d3', '25 hydroxyvitamin d', '25 hydroxy vit d', '25 oh d', 'vitamin d 25 oh', 'total 25 oh vitamin d', '25(oh) vitamin d'], [between(20, 50)], { note: 'Vitamin D reference levels differ between laboratories; the lab range takes priority.' });
R('zinc', 'Zinc', 'vitamins', 'µg/dL', ['zinc', 'serum zinc', 'zn', 'zinc serum'], [between(60, 120)]);
R('ferritin', 'Ferritin', 'iron', 'ng/mL', ['ferritin', 'serum ferritin', 'ferritin serum'], [between(30, 400, 'male'), between(15, 150, 'female')]);
R('iron', 'Serum iron', 'iron', 'µg/dL', ['iron', 'serum iron', 'iron serum', 'iron total', 'fe', 's iron'], [between(65, 175, 'male'), between(50, 170, 'female')]);
R('tibc', 'TIBC', 'iron', 'µg/dL', ['tibc', 'total iron binding capacity', 'iron binding capacity total', 'iron binding capacity'], [between(250, 450)]);
R('transferrin_sat', 'Transferrin saturation', 'iron', '%', ['transferrin saturation', 'tsat', 'iron saturation', 'transferrin sat', '% saturation', 'saturation', 'transferrin saturation %', 'percent saturation'], [between(20, 50)]);

export const REFERENCE = REF;
export const BY_KEY = Object.fromEntries(REF.map((r) => [r.key, r]));
export const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));

// ---- alias lookup
export function normName(s) {
  return String(s ?? '').toLowerCase().replace(/[µμ]/g, 'u').replace(/&/g, ' and ')
    .replace(/[^a-z0-9%+\-/ ]/g, ' ').replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim();
}
const ALIAS = new Map();
for (const r of REF) {
  for (const a of [r.name, ...r.aliases]) { const n = normName(a); if (n && !ALIAS.has(n)) ALIAS.set(n, r.key); }
}
const NOISE_WORDS = new Set(['serum', 'plasma', 'level', 'levels', 'test', 'estimation', 'quantitative', 'blood', 'whole', 'method']);

// Map a name as printed in a report to a standard key (or null). Never guesses: unknown names stay unknown.
export function findKey(rawName) {
  const full = normName(rawName);
  if (!full) return null;
  if (ALIAS.has(full)) return ALIAS.get(full);
  const stripped = full.split(' ').filter((w) => !NOISE_WORDS.has(w)).join(' ');
  if (stripped && ALIAS.has(stripped)) return ALIAS.get(stripped);
  // "SGPT / ALT", "Hemoglobin (Hb)": every non-empty part must agree on the same standard test
  const parts = String(rawName).split(/[/()\[\],]/).map((p) => normName(p)).filter(Boolean);
  if (parts.length > 1) {
    const keys = parts.map((p) => ALIAS.get(p) || ALIAS.get(p.split(' ').filter((w) => !NOISE_WORDS.has(w)).join(' ')) || null);
    const found = keys.filter(Boolean);
    if (found.length && found.every((k) => k === found[0]) && found.length >= Math.ceil(parts.length / 2) && keys.filter((k) => !k).length <= 1) return found[0];
  }
  return null;
}

// Sex-specific range selection. Returns null when sex is needed but unknown.
export function builtinRange(key, sex) {
  const e = BY_KEY[key];
  if (!e || !e.ranges.length) return null;
  const any = e.ranges.find((x) => x.sex === 'any');
  if (any) return { ...any, unit: e.unit, type: e.type, note: e.note };
  if (sex !== 'male' && sex !== 'female') return { needsSex: true, unit: e.unit, type: e.type };
  const r = e.ranges.find((x) => x.sex === sex);
  return r ? { ...r, unit: e.unit, type: e.type, note: e.note } : null;
}

export function formatRange(r) {
  if (!r || r.needsSex) return '';
  const n = (v) => (Number.isInteger(v) ? v.toLocaleString('en-US') : String(v));
  if (r.low != null && r.high != null) return `${n(r.low)}–${n(r.high)}`;
  if (r.high != null) return `${r.highIncl ? '≤' : '<'} ${n(r.high)}`;
  if (r.low != null) return `${r.lowIncl ? '≥' : '>'} ${n(r.low)}`;
  return '';
}
