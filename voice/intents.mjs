// intents.mjs — fast, offline, free command matching for YogAI voice control.
// Anything that returns null here is handed to the optional LLM fallback (see voice-core.mjs `ask`).

export const normalize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();

// Speech engines hear "YogAI" many ways: "yoga i", "yoga eye", "yogi", "yoga ai"...
const WAKE_RE =
  /\b(?:hey|hay|hi|ok|okay)\s+(?:yoga\s*a\s*i|yoga\s*ai|yogai|yoga\s*eye|yoga\s*i|yogi|yoga)\b/;

/** Returns { rest } if the text contains the wake phrase (rest = words after it), else null. */
export function matchWake(text) {
  const n = normalize(text);
  const m = WAKE_RE.exec(n);
  if (!m) return null;
  return { rest: n.slice(m.index + m[0].length).trim() };
}

// Order matters: more specific patterns come before general ones.
const INTENTS = [
  { name: 'stop_listening', re: /\b(stop listening|go to sleep|mute (yourself|voice)|never mind|nevermind)\b/ },
  { name: 'help', re: /\b(what can (you|i) (do|say)|list (the )?commands|voice help)\b/ },

  { name: 'stop_pose_detection', re: /\b(stop|end|turn off|disable|deactivate)\b.*\bpose\s*(detection|detector|tracking|check(ing)?)\b/ },
  { name: 'start_pose_detection', re: /\b(start|begin|turn on|enable|activate)\b.*\bpose\s*(detection|detector|tracking|check(ing)?)\b/ },

  { name: 'end_session', re: /\b(stop|end|finish|quit|exit|cancel)\b.*\b(practice|session|workout|routine|class)\b/ },
  { name: 'start_practice', re: /\b(start|begin|launch|kick off|let'?s (go|start))\b.*\b(practice|session|workout|routine|yoga|class)\b/ },

  { name: 'pause', re: /\b(pause|hold on|hang on|take a (break|breather))\b/ },
  { name: 'resume', re: /\b(resume|continue|carry on|keep going|unpause|go on)\b/ },
  { name: 'skip', re: /\b(skip|next (exercise|pose)|move on|go to the next)\b/ },
  { name: 'previous', re: /\b(previous|go back|last (exercise|pose))\b/ },

  { name: 'explain_pose', re: /\b(explain|how (do|to|should) (i|you)|show me how|teach me|describe|tell me about)\b.*\b(pose|exercise|posture|this|it|move)\b/ },

  { name: 'open_history', re: /\b(show|open|see|view|go to|pull up)\b.*\b(history|past sessions|previous sessions|session log)\b/ },
  { name: 'show_progress', re: /\b(show|open|see|view|go to|pull up|check)\b.*\b(progress|stats|statistics|streak)\b/ },
  { name: 'open_settings', re: /\b(open|show|change|go to|update|adjust)\b.*\bsettings?\b/ },
];

/** Returns { name } for a recognised command, or null (→ LLM fallback / "didn't catch that"). */
export function matchIntent(text) {
  const n = normalize(text);
  if (!n) return null;
  for (const { name, re } of INTENTS) if (re.test(n)) return { name };
  return null;
}

export const INTENT_NAMES = INTENTS.map((i) => i.name);
