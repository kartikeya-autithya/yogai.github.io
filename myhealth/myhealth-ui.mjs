// My Health - screen, upload, verification, dashboard, history and trends.
// Self-injecting like BioSense: adds #myhealth-screen and a home card. No existing code is replaced.
import { GROUPS, GROUP_LABEL, REFERENCE, BY_KEY, findKey, formatRange, builtinRange } from './reference-db.mjs';
import { classify, parseRefText, STATUS_LABEL } from './classify.mjs';
import { parseReport } from './extract.mjs';
import { readFile, stopOcr, fileKind, ACCEPT } from './loader.mjs';
import { buildSeries, seriesId } from './trends.mjs';
import { createHealthStore } from './store.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(`${iso}T00:00:00`); return Number.isNaN(+d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const fmtNum = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(Math.round(v * 1000) / 1000)) : '');
const todayIso = () => new Date().toISOString().slice(0, 10);
const PREF_KEY = 'yogai.myhealth.prefs.v1';
const DISCLAIMER = 'My Health organises your lab results so they are easier to read. It does not diagnose any condition, and a result outside a range does not automatically mean a disease. Ranges differ between laboratories, ages and people. Please discuss your results with a doctor.';

const CSS = `
#myhealth-screen .mh-wrap{background:#fff;color:#1c2521;border-radius:14px;padding:20px;font-size:.95rem;line-height:1.45}
#myhealth-screen .mh-wrap *{box-sizing:border-box}
#myhealth-screen h2.mh-title{margin:0 0 4px;color:#14201b}
#myhealth-screen .mh-sub{color:#55635d;font-size:.9rem;margin-bottom:14px}
#myhealth-screen .mh-back{background:transparent;color:#2f9e86;border:none;padding:0 0 10px;font-weight:600;cursor:pointer}
#myhealth-screen .mh-box{border:1px solid #dfe6e2;border-radius:12px;padding:14px;margin:12px 0;background:#fff}
#myhealth-screen .mh-note{background:#f4f8f6;border:1px solid #dfe6e2;border-radius:10px;padding:10px 12px;color:#41524b;font-size:.84rem;margin:10px 0}
#myhealth-screen .mh-warn{background:#fff6e5;border:1px solid #f0d49a;color:#7a5200;border-radius:10px;padding:10px 12px;font-size:.86rem;margin:10px 0}
#myhealth-screen .mh-err{background:#fdecea;border:1px solid #f1b5ae;color:#9b1c10;border-radius:10px;padding:10px 12px;font-size:.88rem;margin:10px 0}
#myhealth-screen .mh-ok{background:#e8f6ee;border:1px solid #a9dcc0;color:#14633a;border-radius:10px;padding:10px 12px;font-size:.88rem;margin:10px 0}
#myhealth-screen .mh-btn{background:#1f8f73;color:#fff;border:none;border-radius:8px;padding:11px 18px;font-weight:600;cursor:pointer;font-size:.92rem}
#myhealth-screen .mh-btn.sec{background:#eef3f1;color:#1c2521;border:1px solid #d3dcd8}
#myhealth-screen .mh-btn.danger{background:#fff;color:#b3261e;border:1px solid #e3b5b0}
#myhealth-screen .mh-btn:disabled{opacity:.45;cursor:not-allowed}
#myhealth-screen .mh-drop{border:2px dashed #b9c7c1;border-radius:12px;padding:22px;text-align:center;color:#41524b;background:#fafcfb}
#myhealth-screen .mh-drop.over{border-color:#1f8f73;background:#eef8f4}
#myhealth-screen .mh-row2{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#myhealth-screen .mh-chip{border:1px solid #cfd9d4;background:#fff;color:#1c2521;border-radius:999px;padding:7px 14px;font-size:.84rem;cursor:pointer;font-weight:600}
#myhealth-screen .mh-chip.on{background:#1f8f73;border-color:#1f8f73;color:#fff}
#myhealth-screen .mh-tabs{display:flex;gap:6px;margin:14px 0 8px;border-bottom:1px solid #dfe6e2}
#myhealth-screen .mh-tab{background:transparent;border:none;border-bottom:3px solid transparent;padding:9px 14px;font-weight:700;color:#55635d;cursor:pointer}
#myhealth-screen .mh-tab.on{color:#14201b;border-bottom-color:#1f8f73}
#myhealth-screen input[type=text],#myhealth-screen input[type=date],#myhealth-screen input[type=search],#myhealth-screen select{width:100%;background:#fff;color:#1c2521;border:1px solid #c9d4cf;border-radius:8px;padding:9px 10px;font-size:.9rem;font-family:inherit}
#myhealth-screen input[type=checkbox]{width:17px;height:17px;accent-color:#1f8f73}
#myhealth-screen label.mh-f{display:block;font-size:.76rem;color:#55635d;font-weight:600}
#myhealth-screen label.mh-f>input,#myhealth-screen label.mh-f>select{margin-top:3px;font-weight:400}
#myhealth-screen .mh-group{border:1px solid #dfe6e2;border-radius:12px;margin:10px 0;background:#fff;overflow:hidden}
#myhealth-screen .mh-group>summary{cursor:pointer;padding:12px 14px;font-weight:700;color:#14201b;background:#f7faf8;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#myhealth-screen .mh-group>summary::-webkit-details-marker{display:none}
#myhealth-screen .mh-group>summary::before{content:'▸';color:#2f9e86}
#myhealth-screen .mh-group[open]>summary::before{content:'▾'}
#myhealth-screen .mh-cnt{font-weight:500;color:#55635d;font-size:.8rem}
#myhealth-screen .mh-badge{font-size:.72rem;font-weight:700;border-radius:999px;padding:2px 9px;background:#fdecea;color:#b3261e}
#myhealth-screen .mh-thead,#myhealth-screen .mh-row{display:grid;grid-template-columns:2.2fr 1.3fr 1.6fr 1.1fr 1fr;gap:10px;padding:10px 14px;align-items:start}
#myhealth-screen .mh-thead{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:#6b7873;border-top:1px solid #eef2f0}
#myhealth-screen .mh-row{border-top:1px solid #eef2f0}
#myhealth-screen .mh-orig{display:block;font-size:.76rem;color:#6b7873}
#myhealth-screen .mh-val{font-weight:800;font-size:1.05rem}
#myhealth-screen .mh-unit{color:#55635d;font-size:.85rem;margin-left:4px}
#myhealth-screen .mh-tag{display:inline-block;font-size:.68rem;border:1px solid #d3dcd8;border-radius:6px;padding:1px 6px;color:#55635d;margin-top:3px}
#myhealth-screen .mh-pill{display:inline-block;font-size:.78rem;font-weight:700;border-radius:999px;padding:3px 10px}
#myhealth-screen .s-normal{color:#1a7f4b}.s-low,.s-high{color:#c0392b}.s-verify{color:#5f6b66}
#myhealth-screen .mh-pill.s-normal{background:#e8f6ee}#myhealth-screen .mh-pill.s-low,#myhealth-screen .mh-pill.s-high{background:#fdecea}#myhealth-screen .mh-pill.s-verify{background:#eef0ef}
#myhealth-screen .mh-sm{font-size:.78rem;color:#55635d;margin-top:3px}
#myhealth-screen .mh-erow{border:1px solid #dfe6e2;border-radius:12px;padding:12px;margin:10px 0;background:#fff}
#myhealth-screen .mh-erow.bad{border-color:#e9a39b}
#myhealth-screen .mh-egrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
#myhealth-screen .mh-ehead{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;font-size:.8rem;color:#55635d}
#myhealth-screen .mh-src{font-size:.7rem;font-weight:700;border-radius:6px;padding:2px 7px;background:#eef3f1;color:#41524b}
#myhealth-screen .mh-src.ocr{background:#fff0d6;color:#8a5a00}
#myhealth-screen .mh-check{display:flex;gap:8px;align-items:center;margin-top:8px;font-size:.84rem;color:#7a5200}
#myhealth-screen .mh-chart{width:100%;height:auto;background:#fff;border:1px solid #dfe6e2;border-radius:12px}
#myhealth-screen table.mh-tbl{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:10px}
#myhealth-screen table.mh-tbl th,#myhealth-screen table.mh-tbl td{text-align:left;padding:8px 6px;border-bottom:1px solid #eef2f0}
@media(max-width:720px){
  #myhealth-screen .mh-wrap{padding:14px}
  #myhealth-screen .mh-thead{display:none}
  #myhealth-screen .mh-row{grid-template-columns:1fr 1fr;gap:8px}
  #myhealth-screen .mh-row>div:first-child{grid-column:1/-1}
  #myhealth-screen .mh-row>div[data-l]::before{content:attr(data-l);display:block;font-size:.68rem;text-transform:uppercase;color:#6b7873;letter-spacing:.04em}
}`;

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M9 14h2l1-3 2 5 1-2h1"/></svg>';
const DATE_REASON = /^(Read from an image|Test date not found|Date could be|Non-numeric result|Unit not found|Unit text unclear|Reference range unclear)/;

export function initMyHealth({ sb, getUser, document: doc = document, win = window, storage = (typeof localStorage !== 'undefined' ? localStorage : null) } = {}) {
  if (!doc || !sb || doc.getElementById('myhealth-screen')) return null;
  const store = createHealthStore(sb, getUser);
  const prefs = (() => { try { return JSON.parse(storage?.getItem(PREF_KEY) || 'null') || {}; } catch { return {}; } })();
  const savePrefs = () => { try { storage?.setItem(PREF_KEY, JSON.stringify({ sex: prefs.sex || null, adult: !!prefs.adult })); } catch { /* ignore */ } };
  const ui = { view: 'home', loaded: false, loading: false, error: '', notice: '', reports: [], results: [], series: new Map(), selId: null, tab: 'results', trendId: null, search: '', draft: null, progress: '', token: 0, saving: false, byReport: new Map() };

  // ---------- DOM
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
  const screen = doc.createElement('div'); screen.id = 'myhealth-screen'; screen.className = 'screen';
  screen.innerHTML = '<div class="card"><div class="mh-wrap" id="mh-root"></div></div>';
  const anchor = doc.getElementById('home-screen');
  (anchor && anchor.parentElement ? anchor.parentElement : doc.body).appendChild(screen);
  const root = screen.querySelector('#mh-root');
  const grid = doc.querySelector('.ya-mod-grid');
  if (grid) {
    const card = doc.createElement('div'); card.className = 'home-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
    card.innerHTML = `<span class="ico">${ICON}</span><div class="title">My Health</div><div class="desc">Upload blood-test reports and see every result, with history and trends</div>`;
    const open = () => win.showMyHealth();
    card.addEventListener('click', open); card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    const bio = [...grid.querySelectorAll('.home-card .title')].find((t) => /biosense/i.test(t.textContent));
    const after = bio ? bio.closest('.home-card') : null;
    if (after && after.nextSibling) grid.insertBefore(card, after.nextSibling); else grid.appendChild(card);
  }

  // ---------- data
  function ctxFor(rep) { return { sex: rep?.sex_context || null, adult: !!rep?.adult_confirmed }; }
  function classifyRow(r, rep) {
    return classify({ key: r.standard_key, value: r.value_num, qualifier: r.qualifier, unit: r.unit, refText: r.ref_text, flag: r.flag }, ctxFor(rep));
  }
  async function loadData() {
    if (!getUser()) { ui.loaded = false; render(); return; }
    ui.loading = true; ui.error = ''; render();
    try {
      const [reports, results] = await Promise.all([store.listReports(), store.listResults()]);
      ui.reports = reports; ui.byReport = new Map(reports.map((r) => [r.id, r]));
      for (const r of results) { const c = classifyRow(r, ui.byReport.get(r.report_id)); r._c = c; r.status = c.status; }
      ui.results = results; ui.series = buildSeries(results); ui.loaded = true;
      if (!ui.selId || !ui.byReport.has(ui.selId)) ui.selId = reports[0]?.id || null;
    } catch (e) { ui.error = e.message || 'Could not load My Health.'; }
    ui.loading = false; render();
  }

  // ---------- rendering helpers
  const pillHtml = (s) => `<span class="mh-pill s-${s}">${STATUS_LABEL[s] || s}</span>`;
  function sourceTag(c) {
    if (c.source === 'lab') return '<span class="mh-tag">Lab range</span>';
    if (c.source === 'builtin') return `<span class="mh-tag">${c.type === 'target' ? 'General adult target, not a diagnostic threshold' : 'General adult range (fallback)'}</span>`;
    return '';
  }
  function changeHtml(r) {
    const s = ui.series.get(seriesId(r)); if (!s) return '';
    const i = s.points.findIndex((p) => p.resultId === r.id); if (i <= 0) return '';
    const ch = s.changes[i - 1];
    if (!ch.available) return `<div class="mh-sm">Earlier result uses a different unit, so a direct comparison is unavailable.</div>`;
    if (ch.direction === 'same') return `<div class="mh-sm">Unchanged since ${fmtDate(ch.from)}</div>`;
    const arrow = ch.direction === 'up' ? '▲' : '▼';
    return `<div class="mh-sm">${arrow} ${fmtNum(Math.abs(ch.delta))} ${esc(s.unit)}${ch.pct != null ? ` (${Math.abs(ch.pct).toFixed(1)}%)` : ''} since ${fmtDate(ch.from)}${ch.qualified ? ' (one value is a limit)' : ''}</div>`;
  }
  function rowHtml(r) {
    const c = r._c; const s = r.status;
    const val = `${r.qualifier || ''}${r.value_num != null ? fmtNum(r.value_num) : esc(r.value_text || '')}`;
    return `<div class="mh-row">
      <div data-l="Parameter"><strong>${esc(r.standard_name)}</strong>${r.original_name && r.original_name !== r.standard_name ? `<span class="mh-orig">As printed: ${esc(r.original_name)}</span>` : ''}</div>
      <div data-l="Result"><span class="mh-val s-${s}">${esc(val)}</span><span class="mh-unit">${esc(r.unit || '')}</span>${changeHtml(r)}</div>
      <div data-l="Reference range">${c.rangeText ? esc(c.rangeText) : '<span class="mh-sm">Not available</span>'}<br>${sourceTag(c)}</div>
      <div data-l="Status">${pillHtml(s)}${c.reason ? `<div class="mh-sm">${esc(c.reason)}</div>` : ''}${r.extraction_source === 'ocr' ? '<div class="mh-sm">Read from an image</div>' : ''}</div>
      <div data-l="Test date">${fmtDate(r.test_date)}</div></div>`;
  }
  function groupsHtml(rows, searching) {
    const q = ui.search.trim().toLowerCase();
    const list = q ? rows.filter((r) => `${r.standard_name} ${r.original_name}`.toLowerCase().includes(q)) : rows;
    if (!list.length) return `<div class="mh-note">${q ? 'No parameter matches your search.' : 'No results in this report.'}</div>`;
    return GROUPS.map((g) => {
      const items = list.filter((r) => r.grp === g.id); if (!items.length) return '';
      const out = items.filter((r) => r.status === 'low' || r.status === 'high').length;
      return `<details class="mh-group"${searching || g.id === 'cbc' || items.length <= 12 ? ' open' : ''}><summary>${esc(g.label)} <span class="mh-cnt">${items.length} result${items.length === 1 ? '' : 's'}</span>${out ? `<span class="mh-badge">${out} outside range</span>` : ''}</summary>
        <div class="mh-thead"><div>Parameter</div><div>Result</div><div>Reference range</div><div>Status</div><div>Test date</div></div>${items.map(rowHtml).join('')}</details>`;
    }).join('');
  }

  // ---------- trends chart (SVG)
  function chartSvg(s) {
    const pts = s.points.filter((p) => p.converted !== null); if (!pts.length) return '';
    const W = 640, H = 270, L = 54, R = 16, T = 16, B = 40;
    const latest = pts[pts.length - 1]; const rep = ui.byReport.get(latest.reportId);
    let band = null;
    const lastRes = ui.results.find((r) => r.id === latest.resultId);
    if (lastRes && lastRes.ref_text && latest.unit === s.unit) { const pr = parseRefText(lastRes.ref_text, rep?.sex_context); if (pr && pr.kind === 'range') band = { low: pr.low, high: pr.high, src: 'Lab range' }; }
    if (!band && s.key && rep?.adult_confirmed) { const b = builtinRange(s.key, rep.sex_context); if (b && !b.needsSex) band = { low: b.low, high: b.high, src: b.type === 'target' ? 'General adult target' : 'General adult range' }; }
    const vals = pts.map((p) => p.converted); if (band) { if (band.low != null) vals.push(band.low); if (band.high != null) vals.push(band.high); }
    let lo = Math.min(...vals), hi = Math.max(...vals); if (lo === hi) { lo -= 1; hi += 1; } const padv = (hi - lo) * 0.12; lo -= padv; hi += padv;
    const t = pts.map((p) => +new Date(`${p.date}T00:00:00`)); const t0 = Math.min(...t), t1 = Math.max(...t);
    const X = (ms) => (t1 === t0 ? (L + W - R) / 2 : L + ((ms - t0) / (t1 - t0)) * (W - L - R));
    const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let g = '';
    if (band) { const y1 = Y(band.high ?? hi), y2 = Y(band.low ?? lo); g += `<rect x="${L}" y="${Math.min(y1, y2)}" width="${W - L - R}" height="${Math.abs(y2 - y1)}" fill="#1a7f4b" opacity=".10"/>`; }
    for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4; g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5ebe8"/><text x="${L - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#6b7873">${esc(fmtNum(Math.round(v * 100) / 100))}</text>`; }
    if (pts.length > 1) g += `<polyline fill="none" stroke="#7a8a84" stroke-width="2" points="${pts.map((p, i) => `${X(t[i])},${Y(p.converted)}`).join(' ')}"/>`;
    const col = { normal: '#1a7f4b', low: '#c0392b', high: '#c0392b', verify: '#6b7280' };
    pts.forEach((p, i) => {
      g += `<circle cx="${X(t[i])}" cy="${Y(p.converted)}" r="5.5" fill="${col[p.status] || col.verify}" stroke="#fff" stroke-width="2"><title>${esc(fmtDate(p.date))}: ${esc(fmtNum(p.converted))} ${esc(s.unit)}</title></circle>`;
      if (pts.length <= 6 || i === 0 || i === pts.length - 1) g += `<text x="${X(t[i])}" y="${H - 14}" font-size="11" text-anchor="${pts.length === 1 ? 'middle' : i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}" fill="#55635d">${esc(fmtDate(p.date))}</text>`;
    });
    return `<svg class="mh-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend of ${esc(s.name)}">${g}</svg>${band ? `<div class="mh-sm">Shaded area: ${band.src}${band.src.startsWith('General') ? ' (informational only)' : ''}.</div>` : ''}`;
  }
  function trendsHtml() {
    const all = [...ui.series.values()]; if (!all.length) return '<div class="mh-note">Trends appear here after you save a report with numeric results.</div>';
    const order = (s) => { const k = s.key ? GROUPS.findIndex((g) => g.id === BY_KEY[s.key].group) : 99; return k; };
    all.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    if (!ui.trendId || !ui.series.has(ui.trendId)) ui.trendId = all.find((s) => s.points.length > 1)?.id || all[0].id;
    const s = ui.series.get(ui.trendId);
    const opts = all.map((x) => `<option value="${esc(x.id)}"${x.id === ui.trendId ? ' selected' : ''}>${esc(x.name)} (${x.points.length})</option>`).join('');
    const rows = s.points.map((p, i) => {
      const ch = i ? s.changes[i - 1] : null;
      const chT = !ch ? '—' : !ch.available ? 'Unit differs: comparison unavailable' : ch.direction === 'same' ? 'No change' : `${ch.direction === 'up' ? '▲' : '▼'} ${fmtNum(Math.abs(ch.delta))} ${esc(s.unit)}${ch.pct != null ? ` (${Math.abs(ch.pct).toFixed(1)}%)` : ''}`;
      return `<tr><td>${fmtDate(p.date)}</td><td><strong class="s-${p.status}">${esc(p.qualifier || '')}${esc(fmtNum(p.value))}</strong> ${esc(p.unit)}</td><td>${pillHtml(p.status)}</td><td>${chT}</td></tr>`;
    }).join('');
    return `<label class="mh-f">Parameter<select id="mh-trend">${opts}</select></label>
      ${s.points.length === 1 ? '<div class="mh-note">Only one dated result so far. Upload more reports to see a trend.</div>' : ''}
      ${s.comparable ? chartSvg(s) : '<div class="mh-warn">These results use units that cannot be converted reliably, so a direct comparison and graph are unavailable. The values are listed below with their own units.</div>'}
      <table class="mh-tbl"><thead><tr><th>Test date</th><th>Result</th><th>Status</th><th>Change from previous</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------- views
  function homeHtml() {
    if (!getUser()) return `<h2 class="mh-title">My Health</h2><div class="mh-note">Please log in to use My Health. Your reports are private to your account.</div>`;
    const sel = ui.byReport.get(ui.selId); const rows = ui.results.filter((r) => r.report_id === ui.selId);
    const outside = rows.filter((r) => r.status === 'low' || r.status === 'high').length;
    const chips = ui.reports.map((r) => `<button type="button" class="mh-chip${r.id === ui.selId ? ' on' : ''}" data-mh="sel" data-id="${esc(r.id)}">${esc(fmtDate(r.test_date))}${r.lab_name ? ' · ' + esc(r.lab_name.slice(0, 26)) : ''}</button>`).join('');
    let body = '';
    if (ui.loading) body = '<div class="mh-note">Loading your reports...</div>';
    else if (!ui.reports.length) body = '<div class="mh-note">No reports yet. Upload a blood-test report above to build your dashboard. Nothing is shown until you add a report.</div>';
    else if (ui.tab === 'trends') body = trendsHtml();
    else body = `<div class="mh-box"><div class="mh-row2" style="justify-content:space-between"><div><strong>${esc(fmtDate(sel?.test_date))}</strong>${sel?.lab_name ? ' · ' + esc(sel.lab_name) : ''}<div class="mh-sm">${rows.length} result${rows.length === 1 ? '' : 's'}${sel?.extraction_method === 'ocr' || sel?.extraction_method === 'mixed' ? ' · read from an image' : ''}</div></div>
        <div class="mh-row2">${sel?.file_path ? '<button type="button" class="mh-btn sec" data-mh="orig">View original</button>' : ''}<button type="button" class="mh-btn danger" data-mh="del">Delete report</button></div></div></div>
      ${outside ? `<div class="mh-note">${outside} result${outside === 1 ? ' is' : 's are'} outside the range used. This does not by itself mean something is wrong; please discuss it with a doctor.</div>` : ''}
      <label class="mh-f">Search parameters<input type="search" id="mh-search" placeholder="e.g. haemoglobin, TSH, cholesterol" value="${esc(ui.search)}"></label>
      <div id="mh-groups">${groupsHtml(rows, !!ui.search.trim())}</div>`;
    return `<button type="button" class="mh-back" data-mh="back">← Back</button>
      <h2 class="mh-title">My Health</h2><div class="mh-sub">Your blood-test results, organised by date.</div>
      ${ui.error ? `<div class="mh-err">${esc(ui.error)}</div>` : ''}${ui.notice ? `<div class="mh-ok">${esc(ui.notice)}</div>` : ''}
      <div class="mh-box"><div class="mh-drop" id="mh-drop"><strong>Upload a blood-test report</strong><div class="mh-sm" style="margin-bottom:10px">PDF, scanned PDF, JPG or PNG, up to 15 MB</div>
        <button type="button" class="mh-btn" data-mh="pick">Choose file</button><input type="file" id="mh-file" accept="${ACCEPT}" hidden></div>
        <div class="mh-note" style="margin-bottom:0">Privacy: the report is read on your device (text reading and OCR run in your browser) and is not sent to any AI service. After you confirm, it is saved to your own private storage that only you can open. You can delete it at any time.</div></div>
      ${ui.reports.length ? `<div class="mh-row2" style="margin-top:6px">${chips}</div><div class="mh-tabs"><button type="button" class="mh-tab${ui.tab === 'results' ? ' on' : ''}" data-mh="tab" data-t="results">Results</button><button type="button" class="mh-tab${ui.tab === 'trends' ? ' on' : ''}" data-mh="tab" data-t="trends">Trends</button></div>` : ''}
      ${body}<div class="mh-note">${esc(DISCLAIMER)}</div>`;
  }
  const processingHtml = () => `<h2 class="mh-title">Reading your report</h2><div class="mh-note" role="status" aria-live="polite" id="mh-progress">${esc(ui.progress || 'Starting...')}</div><div class="mh-row2"><button type="button" class="mh-btn sec" data-mh="cancel">Cancel</button></div><div class="mh-sm">Scanned reports can take a minute. Nothing is saved yet.</div>`;

  // ---------- verification
  const KEY_OPTIONS = REFERENCE.slice().sort((a, b) => GROUPS.findIndex((g) => g.id === a.group) - GROUPS.findIndex((g) => g.id === b.group)).map((e) => `<option value="${e.key}">${esc(e.name)}</option>`).join('');
  function parseValueInput(s) {
    const t = String(s ?? '').trim().replace(/[–−]/g, '-');
    if (!t) return { ok: false };
    const m = t.match(/^(<=|>=|<|>|≤|≥)?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d*\.?\d+)$/);
    if (m) { const q = m[1] === '≤' ? '<=' : m[1] === '≥' ? '>=' : m[1] || null; return { ok: true, qualifier: q, value_num: Number(m[2].replace(/,/g, '')), value_text: m[2] }; }
    if (/^[A-Za-z][A-Za-z .+\-/()]{0,40}$/.test(t)) return { ok: true, qualifier: null, value_num: null, value_text: t };
    return { ok: false };
  }
  function rowIssues(r) {
    const out = [];
    const pv = parseValueInput(r.value_text);
    if (pv.ok && pv.value_num != null && !r.unit.trim() && !(r.standard_key && BY_KEY[r.standard_key]?.unit === 'ratio')) out.push('Unit is missing');
    if (r.ref_text.trim() && !parseRefText(r.ref_text, draftCtx().sex)) out.push('Reference range could not be read');
    for (const x of r.reasons || []) if (!DATE_REASON.test(x)) out.push(x);
    return out;
  }
  const draftCtx = () => ({ sex: ui.draft?.sex || null, adult: !!ui.draft?.adult });
  function rowPreview(r) {
    const pv = parseValueInput(r.value_text);
    if (!pv.ok) return { html: '<span class="mh-pill s-verify">Check the result</span> <span class="mh-sm">Enter a number (for example 12.5, &lt;0.5) or a word such as Negative.</span>', valid: false };
    const c = classify({ key: r.standard_key, value: pv.value_num, qualifier: pv.qualifier, unit: r.unit, refText: r.ref_text, flag: r.flag }, draftCtx());
    return { html: `${pillHtml(c.status)} <span class="mh-sm">${esc(c.rangeText || 'No reference range')} ${c.source === 'lab' ? '(lab range)' : c.source === 'builtin' ? '(general adult range)' : ''}${c.reason ? ' · ' + esc(c.reason) : ''}</span>`, valid: true };
  }
  function dateGroups() {
    const m = new Map();
    for (const r of ui.draft.rows) { const k = r.test_date || ''; if (!m.has(k)) m.set(k, { date: k, ambiguous: false, count: 0 }); const g = m.get(k); g.count++; if (r.test_date_ambiguous) g.ambiguous = true; }
    return [...m.values()];
  }
  function blockers() {
    const d = ui.draft; const out = [];
    if (!d.rows.length) out.push('There are no results to save. Add at least one parameter.');
    let badName = 0, badVal = 0, unchecked = 0;
    for (const r of d.rows) { if (!r.original_name.trim()) badName++; if (!parseValueInput(r.value_text).ok) badVal++; if (rowIssues(r).length && !r.verified) unchecked++; }
    if (badName) out.push(`${badName} row${badName > 1 ? 's have' : ' has'} no parameter name.`);
    if (badVal) out.push(`${badVal} row${badVal > 1 ? 's have' : ' has'} an unreadable result.`);
    if (unchecked) out.push(`${unchecked} flagged row${unchecked > 1 ? 's' : ''} still need${unchecked > 1 ? '' : 's'} your check (tick the box on each, or fix or remove the row).`);
    for (const g of dateGroups()) {
      if (!g.date) out.push('Enter the actual test date for the rows that have none.');
      else if (g.date > todayIso()) out.push(`The date ${fmtDate(g.date)} is in the future.`);
      else if (g.ambiguous && !d.dateConfirmed[g.date]) out.push(`Confirm the test date ${fmtDate(g.date)}: it could be day/month or month/day.`);
    }
    if (d.rows.some((r) => r.source === 'ocr') && !d.ocrAttested) out.push('Confirm that you compared the values read from the image with your report.');
    return out;
  }
  function verifyHtml() {
    const d = ui.draft; const rowsHtml = d.rows.map((r, i) => {
      const iss = rowIssues(r); const pv = rowPreview(r);
      return `<div class="mh-erow${iss.length && !r.verified ? ' bad' : ''}" data-id="${esc(r.id)}"><div class="mh-ehead"><div><strong>#${i + 1}</strong> <span class="mh-src ${r.source === 'ocr' ? 'ocr' : ''}">${r.source === 'ocr' ? 'Read from image' : r.source === 'manual' ? 'Added by you' : 'Read from text'}</span> <span class="mh-sm" data-role="date">${r.test_date ? fmtDate(r.test_date) : 'No date'}</span></div><button type="button" class="mh-btn danger" data-mh="rowdel" data-id="${esc(r.id)}" style="padding:6px 12px">Remove</button></div>
        <div class="mh-egrid">
          <label class="mh-f">Name in the report<input type="text" data-f="original_name" value="${esc(r.original_name)}"></label>
          <label class="mh-f">Standard test<select data-f="standard_key"><option value="">Other (no standard name)</option>${KEY_OPTIONS.replace(`value="${r.standard_key}"`, `value="${r.standard_key}" selected`)}</select></label>
          <label class="mh-f">Result<input type="text" inputmode="decimal" data-f="value_text" value="${esc(r.value_text)}"></label>
          <label class="mh-f">Unit<input type="text" data-f="unit" value="${esc(r.unit)}"></label>
          <label class="mh-f">Reference range (as printed)<input type="text" data-f="ref_text" value="${esc(r.ref_text)}" placeholder="e.g. 13.0 - 17.0"></label>
        </div><div class="mh-sm" data-role="prev" style="margin-top:8px">${pv.html}</div>
        <div data-role="issues">${iss.length ? `<div class="mh-check"><input type="checkbox" data-f="verified" id="v-${esc(r.id)}"${r.verified ? ' checked' : ''}><label for="v-${esc(r.id)}">${esc(iss.join('; '))}. I checked this row against my report.</label></div>` : ''}</div></div>`;
    }).join('');
    const dg = dateGroups().map((g) => `<div class="mh-box" data-gdate="${esc(g.date)}"><div class="mh-egrid"><label class="mh-f">Actual test (collection) date for ${g.count} result${g.count > 1 ? 's' : ''}<input type="date" max="${todayIso()}" data-gd="${esc(g.date)}" value="${esc(g.date)}"></label></div>
      ${g.ambiguous && g.date ? `<div class="mh-check"><input type="checkbox" id="dc-${esc(g.date)}" data-dc="${esc(g.date)}"${d.dateConfirmed[g.date] ? ' checked' : ''}><label for="dc-${esc(g.date)}">The report shows this as day/month/year. I confirm ${esc(fmtDate(g.date))} is correct.</label></div>` : ''}
      ${!g.date ? '<div class="mh-warn" style="margin-bottom:0">No collection date was found. Enter the date the blood sample was taken. The report print date is not used automatically.</div>' : ''}</div>`).join('');
    return `<button type="button" class="mh-back" data-mh="cancelverify">← Cancel (nothing is saved)</button><h2 class="mh-title">Check your results</h2>
      <div class="mh-sub">${esc(d.file ? d.file.name : 'Manual entry')} · ${d.pageCount ? d.pageCount + ' page' + (d.pageCount > 1 ? 's' : '') + ' · ' : ''}${d.method === 'text' ? 'read from the PDF text' : d.method === 'ocr' ? 'read from an image (OCR)' : d.method === 'mixed' ? 'text and OCR' : 'manual'}</div>
      ${d.warnings.map((w) => `<div class="mh-warn">${esc(w)}</div>`).join('')}${ui.error ? `<div class="mh-err">${esc(ui.error)}</div>` : ''}
      <div class="mh-box"><div class="mh-egrid"><label class="mh-f">Laboratory<input type="text" id="mh-lab" value="${esc(d.labName || '')}" placeholder="Optional"></label>
        <label class="mh-f">Sex used for reference ranges<select id="mh-sex"><option value="">Not specified</option><option value="male"${d.sex === 'male' ? ' selected' : ''}>Male</option><option value="female"${d.sex === 'female' ? ' selected' : ''}>Female</option></select></label></div>
        <div class="mh-check" style="color:#1c2521"><input type="checkbox" id="mh-adult"${d.adult ? ' checked' : ''}><label for="mh-adult">The report is for an adult (18 or older)</label></div>
        <div class="mh-sm">Built-in general ranges are only a fallback for adults and are used only when the report prints no range. Lab ranges always take priority. For children, teenagers or pregnancy, leave this unchecked and rely on the lab range.</div></div>
      ${dg}
      ${d.rows.some((r) => r.source === 'ocr') ? `<div class="mh-warn">Some values were read from an image and can contain mistakes (for example 5 and 6, or a missing decimal point). Compare every row with your report.<div class="mh-check"><input type="checkbox" id="mh-ocr"${d.ocrAttested ? ' checked' : ''}><label for="mh-ocr">I compared the values with my report.</label></div></div>` : ''}
      <div id="mh-rows">${rowsHtml}</div>
      <div class="mh-row2"><button type="button" class="mh-btn sec" data-mh="addrow">+ Add a parameter</button></div>
      <div id="mh-blockers"></div><div class="mh-row2" style="margin-top:12px"><button type="button" class="mh-btn" data-mh="save" id="mh-save">Confirm and save</button><button type="button" class="mh-btn sec" data-mh="cancelverify">Cancel</button></div>
      <div class="mh-note">${esc(DISCLAIMER)}</div>`;
  }
  function refreshBlockers() {
    const b = blockers(); const el = root.querySelector('#mh-blockers'); const btn = root.querySelector('#mh-save');
    if (el) el.innerHTML = b.length ? `<div class="mh-warn"><strong>Before you can save:</strong><ul style="margin:6px 0 0 18px;padding:0">${b.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '<div class="mh-ok">Everything is checked. You can save.</div>';
    if (btn) btn.disabled = b.length > 0 || ui.saving;
  }
  function refreshRow(id) {
    const r = ui.draft.rows.find((x) => x.id === id); const el = root.querySelector(`.mh-erow[data-id="${CSS_ESC(id)}"]`); if (!r || !el) return;
    const iss = rowIssues(r); el.classList.toggle('bad', iss.length > 0 && !r.verified);
    el.querySelector('[data-role="prev"]').innerHTML = rowPreview(r).html;
    el.querySelector('[data-role="issues"]').innerHTML = iss.length ? `<div class="mh-check"><input type="checkbox" data-f="verified" id="v-${esc(id)}"${r.verified ? ' checked' : ''}><label for="v-${esc(id)}">${esc(iss.join('; '))}. I checked this row against my report.</label></div>` : '';
    const dt = el.querySelector('[data-role="date"]'); if (dt) dt.textContent = r.test_date ? fmtDate(r.test_date) : 'No date';
  }
  const CSS_ESC = (s) => (win.CSS && win.CSS.escape ? win.CSS.escape(s) : String(s).replace(/"/g, '\\"'));

  function render() {
    if (ui.view === 'processing') root.innerHTML = processingHtml();
    else if (ui.view === 'verify' && ui.draft) { root.innerHTML = verifyHtml(); refreshBlockers(); }
    else root.innerHTML = homeHtml();
    wireHome();
  }
  function wireHome() {
    const drop = root.querySelector('#mh-drop'); if (!drop) return;
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); });
    const inp = root.querySelector('#mh-file'); inp?.addEventListener('change', () => { const f = inp.files?.[0]; inp.value = ''; if (f) handleFile(f); });
  }

  // ---------- upload flow
  async function handleFile(file) {
    ui.error = ''; ui.notice = '';
    if (!getUser()) { ui.error = 'Please log in first.'; render(); return; }
    if (!fileKind(file)) { ui.error = 'Please choose a PDF, JPG or PNG file.'; render(); return; }
    const token = ++ui.token; ui.view = 'processing'; ui.progress = 'Starting...'; render();
    try {
      const read = await readFile(file, (m) => { if (token !== ui.token) return; ui.progress = m; const el = root.querySelector('#mh-progress'); if (el) el.textContent = m; });
      if (token !== ui.token) return;
      ui.progress = 'Finding the results...'; const p = parseReport(read.pages, { today: todayIso() });
      const warnings = [...p.warnings]; if (read.truncated) warnings.push('Only the first scanned pages were read. Upload the remaining pages separately.');
      const hintAdult = p.patient.ageYears != null ? p.patient.ageYears >= 18 : null;
      ui.draft = {
        file, method: read.method, pageCount: read.pageCount, warnings, labName: p.labName || '',
        sex: p.patient.sex || prefs.sex || '', adult: hintAdult != null ? hintAdult : !!prefs.adult, ocrAttested: false, dateConfirmed: {},
        rows: p.results.map((r) => ({ id: r.id, original_name: r.original_name, standard_key: r.standard_key || '', standardLocked: false, value_text: `${r.qualifier || ''}${r.value_text ?? ''}`, unit: r.unit || '', ref_text: r.ref_text || '', flag: r.flag || '', test_date: r.test_date || '', test_date_ambiguous: !!r.test_date_ambiguous, source: r.source, reasons: r.reasons || [], verified: false })),
      };
      ui.view = 'verify'; render(); win.scrollTo?.(0, 0);
    } catch (e) { if (token !== ui.token) return; ui.view = 'home'; ui.error = e.message || 'This file could not be read.'; render(); }
    finally { stopOcr(); }
  }
  function newRow() { return { id: `m${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`, original_name: '', standard_key: '', standardLocked: false, value_text: '', unit: '', ref_text: '', flag: '', test_date: ui.draft.rows[0]?.test_date || '', test_date_ambiguous: false, source: 'manual', reasons: [], verified: false }; }

  async function save() {
    const d = ui.draft; if (!d || ui.saving || blockers().length) return;
    ui.saving = true; ui.error = ''; const btn = root.querySelector('#mh-save'); if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    prefs.sex = d.sex || null; prefs.adult = !!d.adult; savePrefs();
    try {
      const byDate = new Map();
      for (const r of d.rows) {
        const pv = parseValueInput(r.value_text); const key = r.standard_key || null;
        const c = classify({ key, value: pv.value_num, qualifier: pv.qualifier, unit: r.unit.trim(), refText: r.ref_text, flag: r.flag }, draftCtx());
        const rec = { standard_key: key, standard_name: key ? BY_KEY[key].name : r.original_name.trim(), original_name: r.original_name.trim(), grp: key ? BY_KEY[key].group : 'other', value_num: pv.value_num, value_text: pv.value_text, qualifier: pv.qualifier, unit: r.unit.trim() || null, ref_text: r.ref_text.trim() || null, flag: r.flag || null, status: c.status, extraction_source: r.source, user_verified: true };
        if (!byDate.has(r.test_date)) byDate.set(r.test_date, []); byDate.get(r.test_date).push(rec);
      }
      const ids = await store.saveReports({ groups: [...byDate].map(([testDate, rows]) => ({ testDate, rows })), meta: { labName: d.labName.trim(), sex: d.sex || null, adult: d.adult, method: d.method, file: d.file } });
      const firstDate = [...byDate.keys()].sort().pop();
      ui.draft = null; ui.view = 'home'; ui.tab = 'results'; ui.search = ''; ui.notice = `Saved ${ids.length} dated record${ids.length > 1 ? 's' : ''}. Statuses below compare each value with the range shown.`;
      await loadData(); const rep = ui.reports.find((r) => ids.includes(r.id) && r.test_date === firstDate); if (rep) { ui.selId = rep.id; render(); }
    } catch (e) { ui.error = e.message || 'Could not save. Nothing was saved. Please try again.'; if (btn) btn.textContent = 'Confirm and save'; }
    ui.saving = false; if (ui.view === 'verify') render();
  }

  // ---------- events
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-mh]'); if (!t) return;
    switch (t.dataset.mh) {
      case 'back': win.goToScreen('home'); break;
      case 'pick': root.querySelector('#mh-file')?.click(); break;
      case 'sel': ui.selId = t.dataset.id; ui.tab = 'results'; ui.notice = ''; render(); break;
      case 'tab': ui.tab = t.dataset.t; render(); break;
      case 'cancel': ui.token++; ui.view = 'home'; stopOcr(); render(); break;
      case 'cancelverify': ui.draft = null; ui.view = 'home'; ui.error = ''; render(); break;
      case 'addrow': { ui.draft.rows.push(newRow()); render(); const last = root.querySelector('.mh-erow:last-child input'); last?.focus(); break; }
      case 'rowdel': ui.draft.rows = ui.draft.rows.filter((r) => r.id !== t.dataset.id); render(); break;
      case 'save': save(); break;
      case 'orig': {
        const rep = ui.byReport.get(ui.selId); if (!rep?.file_path) break;
        try { const url = await store.signedUrl(rep.file_path); const w = win.open(url, '_blank', 'noopener'); if (!w) { ui.notice = ''; ui.error = 'Your browser blocked the pop-up. Allow pop-ups for this site and try again.'; render(); } }
        catch (err) { ui.error = err.message; render(); }
        break;
      }
      case 'del': {
        const rep = ui.byReport.get(ui.selId); if (!rep) break;
        if (!win.confirm(`Delete the report from ${fmtDate(rep.test_date)}? This permanently removes its results${rep.file_path ? ' and the stored original file' : ''}. This cannot be undone.`)) break;
        try { await store.deleteReport(rep.id); ui.notice = 'Report deleted.'; ui.selId = null; await loadData(); } catch (err) { ui.error = err.message; render(); }
        break;
      }
      default: break;
    }
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'mh-search') { ui.search = t.value; const g = root.querySelector('#mh-groups'); if (g) g.innerHTML = groupsHtml(ui.results.filter((r) => r.report_id === ui.selId), !!ui.search.trim()); return; }
    if (ui.view !== 'verify' || !ui.draft) return;
    const rowEl = t.closest('.mh-erow'); const f = t.dataset.f;
    if (t.id === 'mh-lab') { ui.draft.labName = t.value; return; }
    if (!rowEl || !f) return;
    const r = ui.draft.rows.find((x) => x.id === rowEl.dataset.id); if (!r) return;
    if (f === 'verified') r.verified = t.checked;
    else if (f === 'standard_key') { r.standard_key = t.value; r.standardLocked = true; }
    else {
      r[f] = t.value;
      if (f === 'original_name' && !r.standardLocked) { r.standard_key = findKey(t.value) || ''; const sel = rowEl.querySelector('select[data-f="standard_key"]'); if (sel) sel.value = r.standard_key; }
      if (f !== 'verified') r.verified = false;                          // editing a row means it must be checked again
    }
    refreshRow(r.id); refreshBlockers();
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'mh-trend') { ui.trendId = t.value; render(); return; }
    if (ui.view !== 'verify' || !ui.draft) return;
    if (t.dataset.gd !== undefined) {                                   // change a date group
      const old = t.dataset.gd, val = t.value;
      for (const r of ui.draft.rows) if ((r.test_date || '') === old) { r.test_date = val; if (val !== old) r.test_date_ambiguous = false; }
      render(); return;
    }
    if (t.id === 'mh-sex') { ui.draft.sex = t.value; ui.draft.rows.forEach((r) => refreshRow(r.id)); refreshBlockers(); }
    else if (t.id === 'mh-adult') { ui.draft.adult = t.checked; ui.draft.rows.forEach((r) => refreshRow(r.id)); refreshBlockers(); }
    else if (t.id === 'mh-ocr') { ui.draft.ocrAttested = t.checked; refreshBlockers(); }
    else if (t.dataset.dc !== undefined) { ui.draft.dateConfirmed[t.dataset.dc] = t.checked; refreshBlockers(); }
    else if (t.dataset.f === 'standard_key' || t.dataset.f === 'verified') { /* handled by input listener */ }
  });

  win.showMyHealth = function showMyHealth() {
    win.goToScreen('myhealth'); if (ui.view === 'processing') { render(); return; }
    if (ui.view !== 'verify') ui.view = 'home';
    ui.notice = ''; ui.error = ''; render(); loadData();
  };
  return { ui, store };
}
