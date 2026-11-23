// My Health - Supabase storage layer. Uses the app's existing Supabase client and login.
// Every row carries user_id and is protected by Row Level Security (see myhealth_supabase.sql);
// the private storage bucket only allows each user to touch files under their own user-id folder.
const BUCKET = 'health-reports';
const rid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const safeName = (n) => String(n || 'report').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

export function createHealthStore(sb, getUser) {
  const uid = () => { const u = getUser(); if (!u || !u.id) throw new Error('Please log in to use My Health.'); return u.id; };
  const fail = (e, what) => { throw new Error(`${what}: ${e?.message || e}`); };

  async function listReports() {
    const id = uid();
    const { data, error } = await sb.from('health_reports').select('*').eq('user_id', id).order('test_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) fail(error, 'Could not load your reports');
    return data || [];
  }
  async function listResults() {
    const id = uid(); const out = []; const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from('health_results').select('*').eq('user_id', id).order('test_date', { ascending: false }).order('sort_order', { ascending: true }).range(from, from + PAGE - 1);
      if (error) fail(error, 'Could not load your results');
      out.push(...(data || [])); if (!data || data.length < PAGE) break;
    }
    return out;
  }

  // groups: [{ testDate, rows:[ result fields ] }]; meta: { labName, sex, adult, method, file }
  async function saveReports({ groups, meta }) {
    const id = uid();
    let path = null; const createdIds = [];
    try {
      if (meta.file) {
        path = `${id}/${rid()}-${safeName(meta.file.name)}`;
        const up = await sb.storage.from(BUCKET).upload(path, meta.file, { contentType: meta.file.type || undefined, upsert: false });
        if (up.error) fail(up.error, 'Could not store the original file');
      }
      for (const g of groups) {
        const rep = await sb.from('health_reports').insert({
          user_id: id, test_date: g.testDate, lab_name: meta.labName || null, sex_context: meta.sex || null, adult_confirmed: !!meta.adult,
          source_type: meta.file ? (meta.file.type === 'application/pdf' || /\.pdf$/i.test(meta.file.name) ? 'pdf' : 'image') : null,
          extraction_method: meta.method || null, file_path: path, file_name: meta.file ? meta.file.name : null, file_mime: meta.file ? meta.file.type || null : null,
        }).select().single();
        if (rep.error) fail(rep.error, 'Could not save the report');
        createdIds.push(rep.data.id);
        const rows = g.rows.map((r, i) => ({ ...r, user_id: id, report_id: rep.data.id, test_date: g.testDate, sort_order: i }));
        for (let k = 0; k < rows.length; k += 200) {
          const ins = await sb.from('health_results').insert(rows.slice(k, k + 200));
          if (ins.error) fail(ins.error, 'Could not save the results');
        }
      }
      return createdIds;
    } catch (e) {                                   // roll back: nothing half-saved is left behind
      for (const rid2 of createdIds) { try { await sb.from('health_reports').delete().eq('id', rid2).eq('user_id', id); } catch { /* ignore */ } }
      if (path) { try { await sb.storage.from(BUCKET).remove([path]); } catch { /* ignore */ } }
      throw e;
    }
  }

  async function deleteReport(reportId) {
    const id = uid();
    const { data: rep, error } = await sb.from('health_reports').select('id,file_path').eq('id', reportId).eq('user_id', id).single();
    if (error) fail(error, 'Could not find the report');
    const del = await sb.from('health_reports').delete().eq('id', reportId).eq('user_id', id);   // results are removed by ON DELETE CASCADE
    if (del.error) fail(del.error, 'Could not delete the report');
    if (rep.file_path) {
      const { count } = await sb.from('health_reports').select('id', { count: 'exact', head: true }).eq('user_id', id).eq('file_path', rep.file_path);
      if (!count) { const rm = await sb.storage.from(BUCKET).remove([rep.file_path]); if (rm.error) fail(rm.error, 'The report was deleted but its file could not be removed'); }
    }
  }

  async function signedUrl(path) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 120);   // private file, link works for 2 minutes
    if (error) fail(error, 'Could not open the original file');
    return data.signedUrl;
  }
  return { listReports, listResults, saveReports, deleteReport, signedUrl };
}
