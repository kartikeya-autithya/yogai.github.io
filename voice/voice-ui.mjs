// voice-ui.mjs — a small floating mic button + status pill. Adds its own elements; changes no existing HTML.
// The mic is OFF until the user taps the button. While on, the pill is always visible (privacy indicator).

import { VoiceAssistant } from './voice-core.mjs';
import { createVoiceBindings } from './voice-bridge.mjs';
import { createCloudTTS } from './cloud-tts.mjs';

export function mountVoice(api) {
  if (!VoiceAssistant.supported || document.getElementById('yogai-voice')) return null;

  const { actions, ask } = createVoiceBindings(api);
  const va = new VoiceAssistant({ actions, ask, tts: api.ttsUrl ? createCloudTTS({ url: api.ttsUrl }) : null });

  const style = document.createElement('style');
  style.textContent = `
    #yogai-voice{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;
      display:flex;align-items:center;gap:8px;font:14px system-ui,sans-serif}
    #yogai-voice button{border:1px solid #7dd3a0;background:#1b2230;color:#e8eef7;border-radius:999px;cursor:pointer;font:inherit}
    #yv-mic{width:48px;height:48px;display:grid;place-items:center;padding:0}
    #yv-mic[aria-pressed="true"]{background:#2f7d5b;border-color:#7dd3a0}
    #yv-talk{padding:8px 12px;display:none}
    #yv-pill{max-width:min(60vw,320px);padding:8px 12px;border-radius:14px;background:rgba(27,34,48,.92);
      color:#e8eef7;border:1px solid #33405a;display:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #yogai-voice.on #yv-talk,#yogai-voice.on #yv-pill{display:block}
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'yogai-voice';
  const mic = document.createElement('button');
  mic.id = 'yv-mic'; mic.type = 'button'; mic.setAttribute('aria-pressed', 'false');
  mic.setAttribute('aria-label', 'Turn voice control on or off');
  mic.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const talk = document.createElement('button');
  talk.id = 'yv-talk'; talk.type = 'button'; talk.textContent = 'Talk';
  const pill = document.createElement('div');
  pill.id = 'yv-pill'; pill.setAttribute('role', 'status'); pill.setAttribute('aria-live', 'polite');
  root.append(mic, talk, pill);
  document.body.appendChild(root);

  const say = (t) => { pill.textContent = t; };
  const idleText = 'Say “Hey YogAI” or “Hey Jarvis”';

  va.addEventListener('state', (e) => {
    const s = e.detail.state;
    const on = s !== 'off';
    root.classList.toggle('on', on);
    mic.setAttribute('aria-pressed', String(on));
    if (s === 'idle') say(idleText);
    else if (s === 'awake') say('Listening…');
    else if (s === 'thinking') say('Thinking…');
  });
  va.addEventListener('heard', (e) => say('“' + e.detail.text.slice(0, 60) + '”'));
  va.addEventListener('reply', (e) => say(e.detail.text.slice(0, 90)));
  va.addEventListener('error', (e) => {
    // Show the message even if the error also switched voice off (e.g. mic permission denied).
    const msg = (e.detail.code === 'permission' && autoStarting) ? 'Tap the mic to turn voice back on.' : e.detail.message;
    if (e.detail.code === 'permission') flag(false);
    setTimeout(() => {
      root.classList.add('on'); say(msg);
      if (va.state === 'off') setTimeout(() => root.classList.remove('on'), 5000);
    }, 0);
  });

  const FLAG = 'yogai.voice.on';
  const flag = (on) => { try { on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch {} };
  let autoStarting = false;

  mic.addEventListener('click', () => {
    if (va.state === 'off') { flag(true); va.start(); } else { flag(false); va.stop(); }
  });
  talk.addEventListener('click', () => va.listenNow());

  // If voice was on last time, try to resume (browsers may still require a tap; then the pill says so).
  try {
    if (localStorage.getItem(FLAG) === '1') { autoStarting = true; va.start(); setTimeout(() => { autoStarting = false; }, 4000); }
  } catch {}

  window.YogaiVoice = va; // handy for testing in the browser console
  return va;
}
