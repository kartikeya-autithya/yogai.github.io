// voice-ui.mjs — Google-search-style mic button. Tap once, say one thing, YogAI answers, the mic switches off.
// Nothing listens in the background: the mic is only on between your tap and the end of your sentence.

import { VoiceAssistant } from './voice-core.mjs';
import { createVoiceBindings } from './voice-bridge.mjs';
import { createCloudTTS } from './cloud-tts.mjs';

export function mountVoice(api) {
  if (!VoiceAssistant.supported || document.getElementById('yogai-voice')) return null;

  const { actions, ask } = createVoiceBindings(api);
  const va = new VoiceAssistant({ actions, ask, wakeWord: false, tts: api.ttsUrl ? createCloudTTS({ url: api.ttsUrl }) : null });
  try { localStorage.removeItem('yogai.voice.on'); } catch {} // old "stay on" setting from earlier versions

  const style = document.createElement('style');
  style.textContent = `
    #yogai-voice{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;
      display:flex;align-items:center;gap:8px;font:14px system-ui,sans-serif}
    #yv-mic{width:48px;height:48px;display:grid;place-items:center;padding:0;border-radius:999px;cursor:pointer;
      border:1px solid #7dd3a0;background:#1b2230;color:#e8eef7}
    #yogai-voice.listening #yv-mic{background:#2f7d5b;animation:yvpulse 1.2s ease-out infinite}
    @keyframes yvpulse{0%{box-shadow:0 0 0 0 rgba(125,211,160,.6)}100%{box-shadow:0 0 0 14px rgba(125,211,160,0)}}
    @media (prefers-reduced-motion:reduce){#yogai-voice.listening #yv-mic{animation:none}}
    #yv-pill{max-width:min(65vw,340px);padding:8px 12px;border-radius:14px;background:rgba(27,34,48,.94);
      color:#e8eef7;border:1px solid #33405a;display:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #yogai-voice.on #yv-pill{display:block}
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'yogai-voice';
  const mic = document.createElement('button');
  mic.id = 'yv-mic'; mic.type = 'button'; mic.setAttribute('aria-pressed', 'false');
  mic.setAttribute('aria-label', 'Talk to YogAI');
  mic.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const pill = document.createElement('div');
  pill.id = 'yv-pill'; pill.setAttribute('role', 'status'); pill.setAttribute('aria-live', 'polite');
  root.append(mic, pill);
  document.body.appendChild(root);

  let hideTimer = null;
  const show = (t) => { clearTimeout(hideTimer); pill.textContent = t; root.classList.add('on'); };
  const hideSoon = (ms = 4500) => { clearTimeout(hideTimer); hideTimer = setTimeout(() => root.classList.remove('on'), ms); };

  va.addEventListener('state', (e) => {
    const s = e.detail.state;
    root.classList.toggle('listening', s === 'awake');
    mic.setAttribute('aria-pressed', String(s !== 'off'));
    if (s === 'awake') show('Listening…');
    else if (s === 'thinking') show('Thinking…');
    else if (s === 'off') hideSoon();
  });
  va.addEventListener('interim', (e) => show('“' + e.detail.text.slice(0, 70) + '”'));
  va.addEventListener('heard', (e) => show('“' + e.detail.text.slice(0, 70) + '”'));
  va.addEventListener('reply', (e) => show(e.detail.text.slice(0, 140)));
  va.addEventListener('timeout', () => show("I didn't hear anything."));
  va.addEventListener('error', (e) => { show(e.detail.message); hideSoon(5500); });

  // Tap to talk. Tap again while it's listening or speaking to stop.
  mic.addEventListener('click', () => { va.state === 'off' ? va.listenOnce() : va.cancel(); });

  window.YogaiVoice = va; // handy for testing in the browser console
  return va;
}
