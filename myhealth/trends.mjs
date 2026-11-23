// My Health - history and trends. Results from different dates are NEVER merged into one measurement.
import { BY_KEY, normName } from './reference-db.mjs';
import { convertValue, normUnit } from './units.mjs';

export const seriesId = (r) => r.standard_key || `name:${normName(r.original_name || r.standard_name)}`;

// results: rows with { standard_key, standard_name, original_name, value_num, unit, test_date, status, ref_text, id, report_id }
// returns Map<seriesId, { id, name, key, unit, points:[{date,value,unit,converted|null,...}], changes:[...] }>
export function buildSeries(results) {
  const map = new Map();
  for (const r of results) {
    if (!Number.isFinite(r.value_num) || !r.test_date) continue;
    const id = seriesId(r);
    if (!map.has(id)) map.set(id, { id, key: r.standard_key || null, name: r.standard_name || r.original_name, points: [] });
    map.get(id).points.push({ date: r.test_date, value: r.value_num, unit: r.unit || '', status: r.status, refText: r.ref_text || '', resultId: r.id, reportId: r.report_id, qualifier: r.qualifier || null });
  }
  for (const s of map.values()) {
    s.points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const canon = (s.key && BY_KEY[s.key]?.ranges.length ? BY_KEY[s.key].unit : null) || s.points[s.points.length - 1].unit;
    s.unit = canon;
    for (const p of s.points) p.converted = !p.unit && !canon ? p.value : convertValue(s.key, p.value, p.unit || canon, canon);
    s.comparable = s.points.every((p) => p.converted !== null);
    s.changes = [];
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i];
      if (a.converted === null || b.converted === null) { s.changes.push({ from: a.date, to: b.date, available: false, reason: 'The units differ and cannot be converted reliably, so a direct comparison is unavailable.' }); continue; }
      const delta = b.converted - a.converted;
      s.changes.push({ from: a.date, to: b.date, available: true, delta, pct: a.converted !== 0 ? (delta / Math.abs(a.converted)) * 100 : null, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same', qualified: !!(a.qualifier || b.qualifier) });
    }
  }
  return map;
}
