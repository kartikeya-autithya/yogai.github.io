// voice-bridge.mjs — the ONLY place where voice meets YogAI.
//
// It never reaches into index.html. index.html hands it a small `api` object
// (window.YogaiVoiceAPI, a few lines you approve) and this file maps voice intents onto it.
// Any api function that is missing makes that command answer "not available yet" instead of failing.
//
// Expected api (all optional except where noted):
//   inPractice()            -> boolean  (practice screen active)
//   startDaily()            -> starts today's practice
//   stop()                  -> stops the running practice
//   skip(), previous()      -> next / previous exercise
//   pause(), resume()       -> NOT in YogAI yet (decision pending)
//   currentPose()           -> { name, info } where info = POSE_INFO[name]
//   showProgress(), showHistory(), showSettings(), showPreferences(), showMeditation(), showLearn(),
//   showChat(), showMessages(), showFavorites(), showAccount(), goHome(), endMeditation(), screen()
//   adjustHold(delta), resetCounter(), repCount(), currentStep(), sessionTitle(s), relDay(date, today)
//   isLoggedIn(), dataReady()
//   getSessions()           -> userData.sessions       today() -> todayStr()
//   getStats()              -> computeStats(...) result
//   workerUrl, systemPrompt(), appContext()   (for open-ended questions)

import { createWorkerAsk } from './llm-adapter.mjs';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return plural(m, 'minute');
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${plural(h, 'hour')} ${plural(r, 'minute')}` : plural(h, 'hour');
}

const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };

const TODAY_RE = /\b(have|did) i (practi[cs]ed?|done)\b.*\btoday\b|\btoday\b.*\b(practi[cs]ed?)\b/;
const LAST_RE = /\b(last|latest|most recent) (session|practice|workout)\b/;
const POSES_RE = /\bhow many (different |unique )?(poses|asanas)\b/;
const STATS_RE = /\b(consisten\w*|streak|how many (sessions|days|times)|how often|how much (time|have i)|total time|have i (practi[cs]ed|done))\b/;

/** Answers "how consistent have I been this month?" etc. from the user's own saved data. Returns null if not a stats question. */
export function answerStats(text, api) {
  if (!(STATS_RE.test(text) || TODAY_RE.test(text) || LAST_RE.test(text) || POSES_RE.test(text))) return null;
  if (!api.isLoggedIn?.()) return 'Please log in and I can tell you about your practice.';
  if (!api.dataReady?.()) return "I can't see your history right now.";

  const today = api.today();
  const all = api.getSessions() || [];
  const st = api.getStats?.() || {};

  if (TODAY_RE.test(text)) return st.practicedToday ? "Yes, you've practiced today." : 'Not yet today.';
  if (POSES_RE.test(text)) return `You've practiced ${plural(st.uniquePoses ?? 0, 'different pose')} so far.`;
  if (LAST_RE.test(text)) {
    const s0 = [...all].filter((x) => x.local_date).sort((a, b) => String(b.completed_at || b.local_date).localeCompare(String(a.completed_at || a.local_date)))[0];
    if (!s0) return "I don't see any saved sessions yet.";
    const title = api.sessionTitle?.(s0) || 'a session';
    const when = api.relDay?.(s0.local_date, today) || s0.local_date;
    return `Your last session was ${title}, ${fmtDuration(s0.duration_seconds || 0)}, ${when}.`;
  }
  let period = 'all', label = 'overall';
  let inPeriod = () => true, daysInPeriod = null;
  if (/\bmonth\b/.test(text)) {
    period = 'month'; label = 'this month';
    inPeriod = (s) => s.local_date.slice(0, 7) === today.slice(0, 7);
    daysInPeriod = parseInt(today.slice(8, 10), 10);
  } else if (/\bweek\b|\blast 7 days\b/.test(text)) {
    period = 'week'; label = 'in the last 7 days';
    inPeriod = (s) => { const d = dayNum(today) - dayNum(s.local_date); return d >= 0 && d <= 6; };
    daysInPeriod = 7;
  }
  const sessions = all.filter((s) => s.local_date && inPeriod(s));
  const days = new Set(sessions.filter((s) => s.counts_for_streak).map((s) => s.local_date)).size;
  const secs = sessions.reduce((t, s) => t + (s.duration_seconds || 0), 0);

  if (!sessions.length) {
    return period === 'all' ? "I don't see any saved sessions yet."
                            : `I don't see any sessions ${label} yet.`;
  }
  let out = daysInPeriod
    ? `${label[0].toUpperCase() + label.slice(1)} you practiced on ${days} of ${daysInPeriod} days, across ${plural(sessions.length, 'session')}, ${fmtDuration(secs)} in total.`
    : `Overall you have ${plural(sessions.length, 'saved session')}, ${fmtDuration(secs)} in total.`;
  if (typeof st.currentStreak === 'number') {
    out += ` Your current streak is ${plural(st.currentStreak, 'day')} and your longest is ${plural(st.longestStreak ?? 0, 'day')}.`;
  }
  return out;
}

function explainCurrentPose(api) {
  if (!api.inPractice?.()) return "Start a practice and I'll explain the pose you're on.";
  const cur = api.currentPose?.();
  const i = cur?.info;
  if (!cur?.name) return "I'm not sure which pose you're on.";
  if (!i || !i.enter) return `You're on ${cur.name}. I don't have written instructions for it yet.`;
  const parts = [`${cur.name}.`, `To enter: ${i.enter}`];
  if (i.hold) parts.push(`Hold: ${i.hold}`);
  if (i.modification) parts.push(`Easier option: ${i.modification}`);
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 600);
}

export function createVoiceBindings(api) {
  const missing = (name) => `${name} isn't available by voice yet.`;
  const needPractice = () => (api.inPractice?.() ? null : 'No practice is running.');
  // Leaving the practice screen ends/saves the session, so navigation by voice never does it silently.
  const nav = (fn, say, { login = false } = {}) => async () => {
    if (api.inPractice?.()) return 'Say end session first.';
    if (login && !api.isLoggedIn?.()) return 'Please log in first.';
    if (!fn) return "That isn't available by voice yet.";
    fn(); return say;
  };

  const holdChange = (d) => {
    const r = api.adjustHold?.(d);
    if (r === undefined) return missing('Changing the hold time');
    return r === false ? 'The hold time can only be changed on a timed pose.' : `Hold target is now ${plural(r, 'second')}.`;
  };

  const actions = {
    start_practice: async () => {
      if (api.inPractice?.()) return "You're already practicing. Say end session first.";
      if (!api.startDaily) return missing('Starting a practice');
      if (api.startDaily() === false) return "I can't build a practice yet. Update your preferences first.";
      return "Starting today's practice.";
    },
    end_session: async () => {
      const n = needPractice(); if (n) return n;
      api.stop(); return 'Ending your practice.';
    },
    stop_pose_detection: async () => {
      const n = needPractice(); if (n) return 'Pose detection is not running.';
      api.stop(); return 'Stopping your practice and the camera.';
    },
    start_pose_detection: async () => api.inPractice?.()
      ? 'Pose detection is already running.'
      : 'Pose detection starts with a practice. Say start my practice, or choose a pose on screen.',

    // api.skip()/previous() return false when the current mode can't do it (e.g. inside a routine for now).
    skip:     async () => needPractice() ?? (api.skip     ? (api.skip()     === false ? "Skipping isn't available in routines yet." : 'Skipping.') : missing('Skipping')),
    previous: async () => needPractice() ?? (api.previous ? (api.previous() === false ? "Going back isn't available in routines yet." : 'Going back.') : missing('Going back')),
    pause:    async () => needPractice() ?? (api.pause    ? (api.pause(),    'Paused.')   : missing('Pausing')),
    resume:   async () => needPractice() ?? (api.resume   ? (api.resume(),   'Resuming.') : missing('Resuming')),

    explain_pose: async () => explainCurrentPose(api),

    show_progress: nav(api.showProgress, 'Here is your progress.', { login: true }),
    open_history:  nav(api.showHistory, 'Opening your history.', { login: true }),
    open_settings: nav(api.showSettings, 'Opening settings.'),
    open_preferences: nav(api.showPreferences, 'Opening your preferences.', { login: true }),
    open_meditation:  nav(api.showMeditation, 'Opening meditation. Pick a breathing exercise, then tap start.'),
    open_learn:       nav(api.showLearn, 'Opening your Yog Kriyas.'),
    open_chat:        nav(api.showChat, 'Opening the chat.'),
    open_messages:    nav(api.showMessages, 'Opening messages.'),
    open_favorites:   nav(api.showFavorites, 'Opening your favorites.', { login: true }),
    open_account:     nav(api.showAccount, 'Opening your account.'),
    go_home:          nav(api.goHome, 'Going home.'),

    stop_meditation: async () => (api.screen?.() === 'meditation-screen' && api.endMeditation
      ? (api.endMeditation(), 'Meditation stopped.') : 'No meditation is running.'),

    hold_longer: async () => needPractice() ?? holdChange(+5),
    hold_shorter: async () => needPractice() ?? holdChange(-5),
    reset_counter: async () => needPractice() ?? (api.resetCounter?.() === false ? 'This exercise has no rep counter.' : (api.resetCounter ? 'Counter reset.' : missing('Resetting'))),
    rep_count: async () => {
      const n = needPractice(); if (n) return n;
      const r = api.repCount?.();
      return r === false || r === undefined ? "This exercise doesn't count reps." : `You're at ${plural(r, 'rep')}.`;
    },
    which_pose: async () => {
      const c = api.inPractice?.() ? api.currentStep?.() : null;
      if (!c) return 'No practice is running.';
      return c.total ? `You're on ${c.name}, step ${c.step} of ${c.total}.` : `You're on ${c.name}.`;
    },
  };

  const worker = api.workerUrl
    ? createWorkerAsk({ url: api.workerUrl, getSystemPrompt: () => api.systemPrompt?.() ?? '', getAppContext: () => api.appContext?.() ?? '' })
    : null;

  // Order: local data answers first (instant, free, exact), then the chat Worker for everything else.
  async function ask(text) {
    const local = answerStats(text, api);
    if (local) return local;
    if (worker) return worker(text);
    return "Sorry, I didn't catch that.";
  }

  return { actions, ask };
}
