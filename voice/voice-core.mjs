// voice-core.mjs — YogAI voice assistant core (Phase 1).
//
// Pipeline: browser speech recognition → wake phrase → local intent match
//           → (optional) LLM fallback → app action → spoken reply.
//
// This file does NOT touch the rest of YogAI. The app hands it an `actions` object
// and (optionally) an `ask` function; see demo.html for a working example.
//
// States: off → idle (waiting for "Hey YogAI") → awake (taking commands)
//         → thinking → speaking → awake → (idle after followUpMs of silence)

import { matchWake, matchIntent, normalize } from './intents.mjs';

const DEFAULT_REPLIES = {
  start_practice: 'Starting your practice.',
  pause: 'Paused.',
  resume: 'Resuming.',
  skip: 'Skipping to the next exercise.',
  previous: 'Going back.',
  end_session: 'Ending the session.',
  start_pose_detection: 'Starting pose detection.',
  stop_pose_detection: 'Pose detection stopped.',
  explain_pose: 'Here is how to do it.',
  show_progress: 'Here is your progress.',
  open_history: 'Opening your history.',
  open_settings: 'Opening settings.',
};

const HELP_TEXT =
  'You can say: start my practice, pause, resume, skip, show my progress, open my history, ' +
  'start pose detection, explain this pose, or open settings. You can also ask me questions.';

export class VoiceAssistant extends EventTarget {
  /**
   * @param {object}   opts
   * @param {object}   opts.actions     map of intentName -> async ({text,intent}) => string|void
   * @param {function} [opts.ask]       async (text, ctx) => string   (LLM fallback; omit to disable)
   * @param {function} [opts.getContext] () => object  extra app state passed to `ask`
   * @param {string}   [opts.lang]      BCP-47, default 'en-US'
   * @param {boolean}  [opts.wakeWord]  true: need "Hey YogAI". false: tap-to-talk only (see listenNow()).
   * @param {number}   [opts.followUpMs] stay "awake" this long after a reply (default 8000)
   * @param {boolean}  [opts.speak]     speak replies aloud (default true)
   */
  constructor({
    actions = {},
    ask = null,
    getContext = () => ({}),
    lang = 'en-US',
    wakeWord = true,
    followUpMs = 8000,
    speak = true,
  } = {}) {
    super();
    Object.assign(this, { actions, ask, getContext, lang, wakeWord, followUpMs, speakReplies: speak });
    this.state = 'off';
    this._want = false;          // user wants the mic on
    this._speaking = false;
    this._rec = null;
    this._restartTimer = null;
    this._awakeTimer = null;
    this._failCount = 0;
    this._lastText = '';
    this._lastTextAt = 0;
    this._wakeLock = null;
    this._lastReply = '';
    this._onVis = () => {
      if (document.visibilityState === 'visible' && this._want) this._requestWakeLock();
    };
  }

  static get supported() {
    return typeof window !== 'undefined' &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // ---------- public API ----------

  /** Call from a user gesture (button tap) — browsers require it for mic access. */
  async start() {
    if (!VoiceAssistant.supported) {
      this._emit('error', { code: 'unsupported', message: 'Speech recognition is not supported in this browser.' });
      return false;
    }
    if (this._want) return true;
    this._want = true;
    document.addEventListener('visibilitychange', this._onVis);
    this._requestWakeLock();
    this._setState('idle');
    this._startRec();
    return true;
  }

  stop() {
    this._want = false;
    clearTimeout(this._restartTimer);
    clearTimeout(this._awakeTimer);
    document.removeEventListener('visibilitychange', this._onVis);
    try { this._rec?.abort(); } catch {}
    this._rec = null;
    this._releaseWakeLock();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this._setState('off');
  }

  /** Tap-to-talk / "mic button": skip the wake phrase and listen for one command now. */
  listenNow() {
    if (!this._want) return this.start().then(() => this._wake(''));
    this._wake('');
  }

  /** Feed text as if it had been spoken (typed testing, or accessibility input). */
  async handleText(text) {
    await this._process(normalize(text));
  }

  async say(text) { return this._speak(text); }

  // ---------- recognition ----------

  _startRec() {
    if (!this._want || this._speaking) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      this._failCount = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) this._onTranscript(e.results[i][0].transcript);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this._want = false;
        this._emit('error', { code: 'permission', message: 'Microphone permission was denied.' });
        this.stop();
      } else if (e.error === 'audio-capture') {
        this._emit('error', { code: 'no-mic', message: 'No microphone found.' });
      } else if (e.error === 'network') {
        this._failCount++;
        this._emit('error', { code: 'network', message: 'Speech service unreachable; retrying.' });
      }
      // 'no-speech' and 'aborted' are normal; onend restarts.
    };
    rec.onend = () => {
      if (this._rec === rec) this._rec = null;
      if (!this._want || this._speaking) return;
      // Recognition ends on its own every so often (esp. mobile). Restart with backoff.
      const delay = Math.min(250 * 2 ** this._failCount, 5000);
      this._failCount = Math.min(this._failCount + 1, 5);
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => this._startRec(), delay);
    };

    this._rec = rec;
    try { rec.start(); } catch { /* already started */ }
  }

  _onTranscript(raw) {
    const text = normalize(raw);
    if (!text) return;
    const now = Date.now();
    if (text === this._lastText && now - this._lastTextAt < 1500) return; // duplicate final
    this._lastText = text; this._lastTextAt = now;

    if (this.state === 'idle') {
      if (!this.wakeWord) return;              // tap-to-talk mode: ignore everything until tapped
      const w = matchWake(text);
      if (!w) return;                           // not for us: discarded, never stored or sent anywhere
      this._wake(w.rest);
    } else if (this.state === 'awake') {
      this._process(text);
    }
  }

  async _wake(rest) {
    this._setState('awake');
    this._armAwakeTimer();
    if (rest) await this._process(rest);
    else await this._speak('Yes?');
  }

  _armAwakeTimer() {
    clearTimeout(this._awakeTimer);
    this._awakeTimer = setTimeout(() => {
      if (this.state === 'awake') this._setState('idle');
    }, this.followUpMs);
  }

  // ---------- understanding + acting ----------

  async _process(text) {
    this._setState('thinking');
    let reply = '';
    try {
      const intent = matchIntent(text);
      this._emit('heard', { text, intent: intent?.name ?? null });
      if (intent) {
        reply = await this._run(intent, text);
      } else if (this.ask) {
        reply = await this.ask(text, this.getContext());
      } else {
        reply = "Sorry, I didn't catch that.";
      }
    } catch (err) {
      this._emit('error', { code: 'action', message: String(err?.message ?? err) });
      reply = 'Sorry, something went wrong.';
    }
    if (this.state === 'off') return;
    if (reply === '__sleep__') { this._setState('idle'); return; }
    this._setState('awake');
    this._armAwakeTimer();
    if (reply) await this._speak(reply);
    this._armAwakeTimer(); // window starts after the reply finishes
  }

  async _run(intent, text) {
    if (intent.name === 'stop_listening') { await this._speak('Okay, going quiet.'); return '__sleep__'; }
    if (intent.name === 'help') return HELP_TEXT;
    const fn = this.actions[intent.name];
    if (!fn) return "I can't do that yet.";
    const r = await fn({ text, intent });
    return typeof r === 'string' ? r : DEFAULT_REPLIES[intent.name] ?? '';
  }

  // ---------- speech output (with echo guard) ----------

  _speak(text) {
    this._lastReply = text;
    this._emit('reply', { text });
    if (!this.speakReplies || typeof speechSynthesis === 'undefined') return Promise.resolve();
    return new Promise((resolve) => {
      // Stop the mic while we talk so YogAI never hears (and acts on) its own voice.
      this._speaking = true;
      clearTimeout(this._restartTimer);
      try { this._rec?.abort(); } catch {}
      this._rec = null;
      speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      const v = speechSynthesis.getVoices().find((x) => x.lang === this.lang && x.localService) ||
                speechSynthesis.getVoices().find((x) => x.lang?.startsWith(this.lang.slice(0, 2)));
      if (v) u.voice = v;
      const done = () => {
        this._speaking = false;
        if (this._want) setTimeout(() => this._startRec(), 300); // small gap so the tail isn't heard
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  // ---------- misc ----------

  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !this._wakeLock) {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      }
    } catch { /* not critical */ }
  }
  _releaseWakeLock() { try { this._wakeLock?.release(); } catch {} this._wakeLock = null; }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this._emit('state', { state: s });
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
