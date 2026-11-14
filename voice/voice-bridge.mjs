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
//   showProgress(), showHistory(), showSettings()
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

const STATS_RE = /\b(consisten\w*|streak|how many (sessions|days|times)|how often|how much (time|have i)|total time|have i (practi[cs]ed|done))\b/;

/** Answers "how consistent have I been this month?" etc. from the user's own saved data. Returns null if not a stats question. */
export function answerStats(text, api) {
  if (!STATS_RE.test(text)) return null;
  if (!api.isLoggedIn?.()) return 'Please log in and I can tell you about your practice.';
  if (!api.dataReady?.()) return "I can't see your history right now.";

  const today = api.today();
  const all = api.getSessions() || [];
  const st = api.getStats?.() || {};
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

    show_progress: async () => {
      if (!api.isLoggedIn?.()) return 'Please log in to see your progress.';
      api.showProgress(); return 'Here is your progress.';
    },
    open_history: async () => {
      if (!api.isLoggedIn?.()) return 'Please log in to see your history.';
      api.showHistory(); return 'Opening your history.';
    },
    open_settings: async () => { api.showSettings(); return 'Opening settings.'; },
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
