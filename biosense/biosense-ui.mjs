/*
 * biosense-ui.mjs: the BioSense tab.
 *
 *   Connect  ->  Processing (ring, up to 30 s)  ->  Result (stress gauge, vitals, recommended pranayama, trend)
 *
 * The tab adds itself to the app: a card on the home screen and a #biosense-screen next to the other screens, so index.html
 * only needs one import and one call. Styling uses the app's own CSS variables.
 */
import {
  createBioSense, createPollSource, createSocketSource, demoSample, PRANAYAMA, READY_SECONDS,
} from './biosense-core.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const BAND_STYLE = {
  calm: { color: '#7fe08a', glow: 'rgba(63,160,80,.55)' },
  balanced: { color: '#7fe08a', glow: 'rgba(63,160,80,.5)' },
  elevated: { color: '#f4a259', glow: 'rgba(200,120,40,.5)' },
  high: { color: '#f0786a', glow: 'rgba(200,60,40,.55)' },
};

// ------------------------------------------------------------------------------------------------ pure SVG helpers
/** Radial tick ring like the "processing" screen: coral ticks for the finished part, fading grey ticks for the rest. */
export function ringSvg(progress, ticks = 72) {
  const p = Math.min(1, Math.max(0, progress));
  const cx = 150; const cy = 150; const r0 = 98; const r1 = 138;
  let out = '';
  for (let i = 0; i < ticks; i += 1) {
    const f = i / ticks; const a = (f * 360 - 90) * (Math.PI / 180);
    const x0 = cx + r0 * Math.cos(a); const y0 = cy + r0 * Math.sin(a); const x1 = cx + r1 * Math.cos(a); const y1 = cy + r1 * Math.sin(a);
    let stroke; let op;
    if (f < p) { stroke = '#e8785a'; op = 0.5 + 0.5 * (p > 0 ? f / p : 1); }
    else { stroke = '#c9cdd1'; op = 0.12 + 0.6 * (1 - (f - p) / Math.max(1 - p, 0.0001)); }
    out += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${stroke}" stroke-opacity="${op.toFixed(2)}" stroke-width="3.2" stroke-linecap="round"/>`;
  }
  return `<svg class="bs-ring" viewBox="0 0 300 300" role="img" aria-label="${Math.round(p * 100)} percent processed">${out}</svg>`;
}

const ARC = { x0: 0, y0: 122, cx: 180, cy: -30, x1: 360, y1: 122 };
export function arcPoint(score) {          // point on the gauge arc for a 0..100 score (quadratic Bezier)
  const t = Math.min(1, Math.max(0, score / 100)); const u = 1 - t;
  return { x: u * u * ARC.x0 + 2 * u * t * ARC.cx + t * t * ARC.x1, y: u * u * ARC.y0 + 2 * u * t * ARC.cy + t * t * ARC.y1 };
}
export function gaugeSvg(score, color) {
  const pt = arcPoint(score);
  const d = `M${ARC.x0},${ARC.y0} Q${ARC.cx},${ARC.cy} ${ARC.x1},${ARC.y1}`;
  return `<svg class="bs-gauge" viewBox="0 0 360 150" preserveAspectRatio="none" aria-hidden="true">
    <defs><filter id="bs-blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs>
    <path d="${d}" pathLength="100" fill="none" stroke="${color}" stroke-opacity=".22" stroke-width="3" stroke-linecap="round"/>
    <path d="${d}" pathLength="100" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${score.toFixed(1)} 100" filter="url(#bs-blur)" opacity=".55"/>
    <path d="${d}" pathLength="100" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${score.toFixed(1)} 100"/>
    <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="9" fill="${color}" opacity=".35"/>
    <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="5.5" fill="${color}"/>
  </svg>`;
}
export function sparkSvg(points, color) {
  if (points.length < 2) return '<div class="bs-dim">Collecting your trend…</div>';
  const w = 300; const h = 54; const t0 = points[0].t; const span = Math.max(points[points.length - 1].t - t0, 1);
  const pts = points.map((p) => `${(((p.t - t0) / span) * w).toFixed(1)},${(h - 4 - (p.score / 100) * (h - 8)).toFixed(1)}`).join(' ');
  return `<svg class="bs-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ------------------------------------------------------------------------------------------------ styles
const CSS = `
#biosense-screen .bs-sub{color:var(--text-dim);font-size:.92rem;margin:-4px 0 18px}
.bs-chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 14px}
.bs-chip{background:#0f1612;border:1px solid var(--border);color:var(--text);border-radius:999px;padding:8px 14px;font-size:.88rem;cursor:pointer}
.bs-chip.on{border-color:var(--accent);color:var(--accent);background:#15201b}
.bs-input{width:100%;box-sizing:border-box;background:#0f1612;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px 12px;font-size:.92rem;margin:4px 0 10px}
.bs-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.bs-row button{flex:1 1 150px}
.bs-note{color:var(--text-dim);font-size:.82rem;line-height:1.45;margin-top:10px}
.bs-err{color:var(--danger);font-size:.88rem;margin-top:10px}
.bs-label{font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin:16px 0 6px}
.bs-check{display:flex;gap:8px;align-items:flex-start;font-size:.85rem;color:var(--text-dim);margin:6px 0}
details.bs-det{background:#0f1612;border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-top:10px;font-size:.85rem;color:var(--text-dim)}
details.bs-det summary{cursor:pointer;color:var(--text)}
details.bs-det pre{white-space:pre-wrap;word-break:break-word;font-size:.78rem;margin:8px 0 0;color:#b9c7be}
.bs-proc{background:#0d0d0d;border-radius:22px;padding:26px 16px 24px;text-align:center;color:#fff;position:relative;border:1px solid #1c1c1c}
.bs-ringwrap{position:relative;width:min(300px,78vw);aspect-ratio:1;margin:0 auto}
.bs-ring{width:100%;height:100%;display:block}
.bs-ringtxt{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.bs-pct{font-size:3.4rem;font-weight:300;letter-spacing:-.02em;line-height:1}
.bs-pctsub{color:#9aa0a6;font-size:1.02rem;margin-top:6px}
.bs-proc h3{color:#fff;font-size:1.08rem;margin:22px 0 6px}
.bs-proc p{color:#8d9399;font-size:.92rem;margin:0 auto;max-width:300px;line-height:1.45}
.bs-stress{position:relative;overflow:hidden;border-radius:26px;padding:18px 20px 20px;color:#fff;border:1px solid #2c2c2c;
  background:radial-gradient(circle at 78% 22%,var(--bs-glow,rgba(63,160,80,.5)),transparent 58%),linear-gradient(135deg,#2e2e2e,#1b1b1b);box-shadow:0 8px 28px rgba(0,0,0,.35)}
.bs-stress-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:1.05rem;position:relative;z-index:2}
.bs-stress-head span{display:flex;align-items:center;gap:8px}
.bs-gauge{position:absolute;left:0;right:0;top:34px;width:100%;height:150px;z-index:1}
.bs-stress-body{position:relative;z-index:2;text-align:center;padding-top:70px}
.bs-stress-body .lbl{font-size:.82rem;color:#d9d9d9}
.bs-big{font-size:3rem;font-weight:400;line-height:1.1;margin:8px 0 10px;color:var(--bs-color,#7fe08a)}
.bs-pill{display:inline-block;padding:7px 22px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.12);color:var(--bs-color,#7fe08a);font-size:.95rem}
.bs-conf{font-size:.78rem;color:#bdbdbd;margin-top:10px}
.bs-vitals{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:14px}
.bs-tile{background:#0f1612;border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.bs-tile .k{font-size:.74rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}
.bs-tile .v{font-size:1.35rem;margin-top:4px}
.bs-tile .v small{font-size:.78rem;color:var(--text-dim);margin-left:3px}
.bs-rec{background:#0f1612;border:1px solid var(--border);border-radius:16px;padding:16px;margin-top:14px}
.bs-rec h3{margin:0 0 8px;color:var(--text-dim);font-size:.78rem;letter-spacing:.06em;text-transform:uppercase}
.bs-rec-name{font-size:1.18rem;font-weight:600}
.bs-rec-time{display:inline-block;margin:8px 0 2px;background:var(--accent);color:#10241a;border-radius:999px;padding:4px 14px;font-weight:700}
.bs-rec ul{margin:8px 0 0;padding-left:18px;color:var(--text-dim);font-size:.88rem;line-height:1.5}
.bs-rec ol{margin:6px 0 0;padding-left:20px;color:var(--text);font-size:.88rem;line-height:1.5}
.bs-caution{font-size:.76rem;color:var(--text-dim);margin-top:12px;line-height:1.45}
.bs-warn{background:#2a1f12;border:1px solid #5a4020;color:#f0c890;border-radius:10px;padding:10px 12px;font-size:.85rem;margin-top:12px;line-height:1.45}
.bs-spark{width:100%;height:54px;display:block;margin-top:6px}
.bs-dim{color:var(--text-dim);font-size:.85rem;padding:12px 0}
.bs-banner{background:#2a1f12;border:1px solid #5a4020;color:#f0c890;border-radius:10px;padding:8px 12px;font-size:.85rem;margin-bottom:12px}
`;

// ------------------------------------------------------------------------------------------------ the tab
const PULSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>';
const STRESS_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 3.2l.9 2 .1-.1-.5-2.3zM6.4 5.6l1.6 1.4-.2-.2L6 5zM17.6 5.6L16 7l.2-.2L18 5zM12 8a4 4 0 0 0-4 4v1H6.5A1.5 1.5 0 0 0 5 14.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5.5a1.5 1.5 0 0 0-1.5-1.5H16v-1a4 4 0 0 0-4-4z"/></svg>';
const ARROW_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';

export function initBioSense({ document: doc = document, storage = (typeof localStorage !== 'undefined' ? localStorage : null), win = window, now = () => Date.now() } = {}) {
  if (!doc || doc.getElementById('biosense-screen')) return null;
  const bio = createBioSense({ now, storage });
  const cfgKey = 'yogai.biosense.ui.v1';
  const saved = (() => { try { return JSON.parse(storage?.getItem(cfgKey) || 'null') || {}; } catch { return {}; } })();
  const ui = { source: saved.source || 'demo-mixed', url: saved.url || '', running: false, view: '', error: '', srcObj: null, demoTimer: null, tickTimer: null, override: null, baselineRun: false, demoT0: 0, notice: '' };
  const persist = () => { try { storage?.setItem(cfgKey, JSON.stringify({ source: ui.source, url: ui.url })); } catch { /* ignore */ } };

  // ---- DOM: style, screen, home card
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
  const screen = doc.createElement('div'); screen.id = 'biosense-screen'; screen.className = 'screen';
  screen.innerHTML = `<div class="card"><button class="back-link" type="button" data-bs="back"><span class="back-link-icon" aria-hidden="true">←</span><span>Back</span></button>
    <h2>BioSense</h2><div class="bs-sub">Your body's signals, turned into a stress level and a breathing practice.</div><div id="bs-view"></div></div>`;
  const anchor = doc.getElementById('home-screen');
  (anchor && anchor.parentElement ? anchor.parentElement : doc.body).appendChild(screen);
  const view = screen.querySelector('#bs-view');

  const grid = doc.querySelector('.ya-mod-grid');
  if (grid) {
    const card = doc.createElement('div'); card.className = 'home-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
    card.innerHTML = `<span class="ico">${PULSE_ICON}</span><div class="title">BioSense</div><div class="desc">Headband sensors: pulse, temperature and skin conductance, a stress level and a pranayama for you</div>`;
    const open = () => win.showBioSense();
    card.addEventListener('click', open); card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    const med = [...grid.querySelectorAll('.home-card .title')].find((t) => /meditation/i.test(t.textContent));
    const after = med ? med.closest('.home-card') : null;
    if (after && after.nextSibling) grid.insertBefore(card, after.nextSibling); else grid.appendChild(card);
  }

  // ---- data source
  function ingestList(list) { for (const s of list) bio.ingest(s); }
  function startSource() {
    stopSource(); ui.error = '';
    if (ui.source.startsWith('demo')) {
      const sc = ui.source.split('-')[1] || 'mixed'; ui.demoT0 = now();
      ui.demoTimer = setInterval(() => bio.ingest(demoSample((now() - ui.demoT0) / 1000, sc)), 250);
    } else if (ui.source === 'poll') {
      ui.srcObj = createPollSource(ui.url, { onSamples: ingestList, onError: (e) => { ui.error = explain(e); } }); ui.srcObj.start();
    } else if (ui.source === 'socket') {
      ui.srcObj = createSocketSource(ui.url, { onSamples: ingestList, onError: (e) => { ui.error = explain(e); }, onClose: () => { if (ui.running) ui.error = 'The connection to the band closed.'; } }); ui.srcObj.start();
    }
  }
  function stopSource() { if (ui.demoTimer) { clearInterval(ui.demoTimer); ui.demoTimer = null; } if (ui.srcObj) { ui.srcObj.stop(); ui.srcObj = null; } }
  function explain(e) {
    const m = e && e.message ? e.message : String(e);
    if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Cannot reach the band. This page is secure (https), so the band address must be https:// (or wss:// for WebSocket); a plain http:// or local address is blocked by the browser.';
    return m;
  }

  function begin(baseline) {
    if (!ui.source.startsWith('demo') && !/^(https|wss):\/\//i.test(ui.url.trim())) { ui.notice = 'Enter an https:// (or wss://) address for the band first.'; renderConnect(); return; }
    ui.notice = ''; ui.running = true; ui.baselineRun = !!baseline; ui.override = null;
    bio.start(); if (baseline) bio.startBaseline();
    startSource(); ui.view = ''; render();
    clearInterval(ui.tickTimer); ui.tickTimer = setInterval(render, 1000);
  }
  function stop() { ui.running = false; ui.baselineRun = false; clearInterval(ui.tickTimer); ui.tickTimer = null; stopSource(); bio.stop(); ui.view = ''; render(); }

  // ---- views
  function renderConnect() {
    ui.view = 'connect';
    const b = bio.getBaseline(); const cfg = bio.getConfig();
    const ago = b ? Math.max(1, Math.round((now() - b.at) / 3600000)) : 0;
    view.innerHTML = `
      <div class="bs-label">Band</div>
      <div class="bs-chips" role="group" aria-label="Data source">
        ${[['demo-mixed', 'Demo (mixed)'], ['demo-calm', 'Demo (calm)'], ['demo-stressed', 'Demo (stressed)'], ['poll', 'Live (https link)'], ['socket', 'Live (WebSocket)']]
    .map(([k, l]) => `<button type="button" class="bs-chip${ui.source === k ? ' on' : ''}" data-bs-src="${k}">${l}</button>`).join('')}
      </div>
      ${ui.source === 'poll' || ui.source === 'socket' ? `<input class="bs-input" id="bs-url" inputmode="url" autocomplete="off" placeholder="${ui.source === 'poll' ? 'https://your-band-address/data' : 'wss://your-band-address'}" value="${esc(ui.url)}" aria-label="Band address">` : ''}
      <label class="bs-check"><input type="checkbox" id="bs-invert" ${cfg.invertGsr ? 'checked' : ''}><span>My skin-conductance reading goes <b>down</b> when the skin is more conductive (reverses the signal)</span></label>
      <div class="bs-label">Your baseline</div>
      <div class="bs-note" style="margin-top:0">${b ? `Saved ${ago} hour${ago === 1 ? '' : 's'} ago. Stress is measured against it.` : 'Not recorded yet. Without it the estimate is rougher. Sit relaxed for 2 minutes with the band on.'}</div>
      ${ui.notice ? `<div class="bs-err">${esc(ui.notice)}</div>` : ''}
      <div class="bs-row"><button type="button" class="btn-primary" data-bs="start">Measure now</button><button type="button" class="btn-secondary" data-bs="baseline">${b ? 'Re-record baseline (2 min)' : 'Record baseline (2 min)'}</button></div>
      <details class="bs-det"><summary>What the band sends</summary>
        <div style="margin-top:8px">Send JSON from the band, one object or a list, a few times per second. Any subset of fields works:</div>
        <pre>{"hr": 72, "ibi": 830, "temp": 34.1, "gsr": 412}</pre>
        <div>hr: beats per minute · ibi: beat-to-beat interval in ms (needed for heart-rate variability) · temp: skin °C · gsr: skin conductance, any unit where higher means more conductive. The address must be https:// or wss://.</div></details>
      <div class="bs-note">BioSense is a wellness estimate from simple sensors, not a medical device or a diagnosis.</div>`;
  }

  function renderProcessing(st, label) {
    const baseline = ui.baselineRun;
    const p = baseline ? bio.baselineProgress() : st.progress;
    if (ui.view !== 'proc') {
      ui.view = 'proc';
      view.innerHTML = `<div class="bs-proc"><div class="bs-ringwrap"><div id="bs-ring"></div><div class="bs-ringtxt"><div class="bs-pct" id="bs-pct">0%</div><div class="bs-pctsub" id="bs-pctsub">processing</div></div></div>
        <h3 id="bs-ptitle"></h3><p id="bs-ptext"></p><div class="bs-err" id="bs-perr"></div></div>
        <div class="bs-row"><button type="button" class="btn-secondary" data-bs="stop">Cancel</button></div>`;
    }
    view.querySelector('#bs-ring').innerHTML = ringSvg(p);
    view.querySelector('#bs-pct').textContent = Math.round(p * 100) + '%';
    view.querySelector('#bs-pctsub').textContent = label.sub;
    view.querySelector('#bs-ptitle').textContent = label.title;
    view.querySelector('#bs-ptext').textContent = label.text;
    view.querySelector('#bs-perr').textContent = ui.error;
  }

  function tile(k, v, unit) { return `<div class="bs-tile"><div class="k">${k}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div></div>`; }

  function renderResult(st) {
    const r = bio.analyze();
    const rec = r.recommendation;
    if (!fin(r.score) || !r.band) { renderProcessing({ progress: st.progress }, { title: 'Reading your signals', text: 'Not enough signal yet. Keep the band snug and still.', sub: 'processing' }); return; }
    const bs = BAND_STYLE[r.band.id];
    const pct = Math.round(r.score);
    const f = r.features;
    const conf = r.confidence >= 0.75 ? 'High' : r.confidence >= 0.45 ? 'Medium' : 'Low';
    const alt = rec && ui.override ? rec.alternatives.find((a) => a.id === ui.override) : null;
    const shownId = alt ? alt.id : rec?.id;
    const shown = shownId ? PRANAYAMA[shownId] : null;
    const sclTxt = fin(r.sclChangePct) ? `${r.sclChangePct >= 0 ? '+' : ''}${Math.round(r.sclChangePct)}<small>% vs baseline</small>` : (fin(f.scl) ? '<small>record a baseline</small>' : '—');
    const tempArrow = fin(f.tempSlope) ? (f.tempSlope < -0.05 ? ' ↓' : f.tempSlope > 0.05 ? ' ↑' : '') : '';
    const html = `
      ${st.state === 'lost' ? '<div class="bs-banner">Signal lost. Showing your last reading. Check the band and its connection.</div>' : ''}
      <div class="bs-stress" style="--bs-glow:${bs.glow};--bs-color:${bs.color}">
        <div class="bs-stress-head"><span>${STRESS_ICON}Stress</span><span aria-hidden="true">${ARROW_ICON}</span></div>
        ${gaugeSvg(r.score, bs.color)}
        <div class="bs-stress-body"><div class="lbl">Your stress level</div><div class="bs-big" id="bs-big">${pct}%</div><div class="bs-pill" id="bs-pill">${r.band.label}</div>
          <div class="bs-conf">Confidence: ${conf}${r.hasBaseline ? '' : ' · record a baseline to improve it'}</div></div>
      </div>
      <div class="bs-vitals">
        ${tile('Heart rate', fin(f.hr) ? Math.round(f.hr) : '—', fin(f.hr) ? 'bpm' : '')}
        ${tile('Variability (HRV)', fin(f.rmssd) ? Math.round(f.rmssd) : '—', fin(f.rmssd) ? 'ms' : '')}
        ${tile('Skin temperature', fin(f.temp) ? f.temp.toFixed(1) + tempArrow : '—', fin(f.temp) ? '°C' : '')}
        ${tile('Skin conductance', sclTxt, '')}
      </div>
      ${r.issues.map((i) => `<div class="bs-warn">${esc(i.text)}</div>`).join('')}
      ${rec && shown ? `<div class="bs-rec">
        <h3>Recommended for you</h3>
        <div class="bs-rec-name" id="bs-rec-name">${esc(shown.name)}</div>
        <div class="bs-rec-time" id="bs-rec-time">${rec.minutes} min</div> <span class="bs-dim" style="padding:0">${esc(rec.when)}</span>
        <ul>${rec.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
        <details class="bs-det"><summary>How to do it</summary><ol>${shown.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
        <div class="bs-label">Other options</div>
        <div class="bs-chips">${rec.alternatives.concat(alt ? [{ id: rec.id, name: rec.name }] : []).filter((a) => a.id !== shownId).map((a) => `<button type="button" class="bs-chip" data-bs-alt="${a.id}">${esc(a.name)}</button>`).join('')}</div>
        <div class="bs-row"><button type="button" class="btn-primary" data-bs-practice="${shownId}" data-min="${rec.minutes}">Start in Meditation</button><button type="button" class="btn-secondary" data-bs="again">Measure again</button></div>
        <div class="bs-caution">${esc(rec.caution)}</div></div>` : ''}
      <div class="bs-rec"><h3>Trend</h3>${sparkSvg(bio.getHistory(), bs.color)}</div>
      <div class="bs-row"><button type="button" class="btn-secondary" data-bs="baseline">${r.hasBaseline ? 'Re-record baseline (2 min)' : 'Record baseline (2 min)'}</button><button type="button" class="btn-secondary" data-bs="stop">Stop</button></div>
      ${ui.error ? `<div class="bs-err">${esc(ui.error)}</div>` : ''}`;
    // Keep the "how to do it" section open and the page scroll steady across the 1 s refresh.
    const det = view.querySelector('details.bs-det'); const wasOpen = det ? det.open : false;
    view.innerHTML = html; ui.view = 'result';
    if (wasOpen) { const d2 = view.querySelector('details.bs-det'); if (d2) d2.open = true; }
  }

  function render() {
    if (!screen.classList.contains('active') && ui.view) return;      // nothing to draw while the tab is not visible
    if (!ui.running) { if (ui.view !== 'connect') renderConnect(); return; }
    const st = bio.status();
    if (ui.baselineRun) {
      if (bio.baselineProgress() >= 1) {
        const b = bio.finishBaseline(); ui.baselineRun = false;
        ui.notice = b ? 'Baseline saved.' : 'Not enough signal to save a baseline. Check the band and try again.';
        if (!b) { stop(); renderConnect(); return; }
        ui.view = ''; render(); return;
      }
      renderProcessing(st, { title: 'Recording your baseline', text: 'Sit still, breathe normally and relax for 2 minutes. This becomes your personal reference.', sub: 'recording' }); return;
    }
    if (st.state === 'waiting') { renderProcessing(st, { title: 'Waiting for your band', text: 'No data yet. Check that the band is on and connected.', sub: 'waiting' }); return; }
    if (st.state === 'processing' || (st.state === 'lost' && st.progress < 1)) { renderProcessing(st, { title: 'Reading your signals', text: `Sit tight and relax, this will take up to ${READY_SECONDS} seconds`, sub: 'processing' }); return; }
    renderResult(st);
  }

  // ---- events (delegated)
  screen.addEventListener('click', (e) => {
    const t = e.target.closest('[data-bs],[data-bs-src],[data-bs-alt],[data-bs-practice]'); if (!t) return;
    if (t.dataset.bsSrc) { ui.source = t.dataset.bsSrc; persist(); renderConnect(); return; }
    if (t.dataset.bsAlt) { ui.override = t.dataset.bsAlt; ui.view = ''; render(); return; }
    if (t.dataset.bsPractice) {
      const p = PRANAYAMA[t.dataset.bsPractice]; const m = +t.dataset.min;
      if (typeof win.presetMeditation === 'function') win.presetMeditation(p.name, m); else if (typeof win.showMeditation === 'function') win.showMeditation();
      return;
    }
    switch (t.dataset.bs) {
      case 'back': win.goToScreen('home'); break;
      case 'start': { const u = view.querySelector('#bs-url'); if (u) ui.url = u.value.trim(); persist(); begin(false); break; }
      case 'baseline': { const u = view.querySelector('#bs-url'); if (u) ui.url = u.value.trim(); persist(); if (ui.running) stop(); begin(true); break; }
      case 'again': begin(false); break;
      case 'stop': stop(); break;
      default: break;
    }
  });
  screen.addEventListener('change', (e) => { if (e.target && e.target.id === 'bs-invert') bio.setConfig({ invertGsr: e.target.checked }); });
  screen.addEventListener('input', (e) => { if (e.target && e.target.id === 'bs-url') { ui.url = e.target.value; } });

  win.showBioSense = function showBioSense() { win.goToScreen('biosense'); ui.view = ''; render(); };
  return { bio, ui, render, begin, stop, screen };
}
