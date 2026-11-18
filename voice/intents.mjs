// intents.mjs — fast, offline, free command matching for YogAI voice control.
// Anything that returns null here is handed to the optional LLM fallback (see voice-core.mjs `ask`).

export const normalize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();

// Speech engines hear "YogAI" many ways: "yoga i", "yoga eye", "yogi", "yoga ai"...
const WAKE_RE =
  /\b(?:hey|hay|hi|ok|okay)\s+(?:yoga\s*a\s*i|yoga\s*ai|yogai|yoga\s*eye|yoga\s*i|yogi|yoga|jarvis|jarvas|jarvus|jarvice)\b/;

/** Returns { rest } if the text contains the wake phrase (rest = words after it), else null. */
export function matchWake(text) {
  const n = normalize(text);
  const m = WAKE_RE.exec(n);
  if (!m) return null;
  return { rest: n.slice(m.index + m[0].length).trim() };
}

// Order matters: more specific patterns come before general ones.
const INTENTS = [
  { name: 'stop_listening', re: /\b(stop listening|go to sleep|never mind|nevermind|cancel that)\b/ },
  { name: 'change_voice', re: /\b(change|switch|try|use|pick)\b.*\bvoice\b/ },
  { name: 'repeat', re: /\b(repeat that|say that again|what did you say|come again)\b/ },
  { name: 'mute_replies', re: /\b(mute|silence|turn off)\b.*\b(voice|replies|reply|yourself|speaking)\b|\bstop (replying|speaking) (out loud|aloud)\b|\btext only\b/ },
  { name: 'unmute_replies', re: /\b(unmute|turn on|enable)\b.*\b(voice|replies|reply|speaking)\b|\bspeak (out loud|aloud) again\b/ },
  { name: 'help', re: /\b(what can (you|i) (do|say)|list (the )?commands|voice help)\b/ },

  { name: 'stop_pose_detection', re: /\b(stop|end|turn off|disable|deactivate)\b.*\bpose\s*(detection|detector|tracking|check(ing)?)\b/ },
  { name: 'start_pose_detection', re: /\b(start|begin|turn on|enable|activate)\b.*\bpose\s*(detection|detector|tracking|check(ing)?)\b/ },

  { name: 'stop_meditation', re: /\b(stop|end|finish)\b.*\b(meditation|pranayama|breathing)\b/ },
  { name: 'end_session', re: /\b(stop|end|finish|quit|exit|cancel)\b.*\b(practice|session|workout|routine|class)\b/ },
  { name: 'start_practice', re: /\b(start|begin|launch|kick off|let'?s (go|start))\b.*\b(practice|session|workout|routine|yoga|class)\b/ },

  { name: 'hold_longer', re: /\b(hold|timer|time)\b.*\b(longer|more|increase|add)\b|\b(longer|increase|add|more)\b.*\b(hold|seconds)\b/ },
  { name: 'hold_shorter', re: /\b(hold|timer|time)\b.*\b(shorter|less|decrease|reduce|lower)\b|\b(shorter|decrease|reduce|less)\b.*\b(hold|seconds)\b/ },
  { name: 'reset_counter', re: /\b(reset|restart)\b.*\b(counter|count|reps)\b/ },
  { name: 'rep_count', re: /\bhow many (reps|repetitions)\b|\b(rep|reps) count\b/ },
  { name: 'which_pose', re: /\b(what|which)\b.*\b(pose|exercise|step)\b.*\b(is this|am i|now|on)\b|\bwhat am i (doing|on)\b|\bwhere am i\b/ },
  { name: 'pause', re: /\b(pause|hold on|hang on|take a (break|breather))\b/ },
  { name: 'resume', re: /\b(resume|continue|carry on|keep going|unpause|go on)\b/ },
  { name: 'skip', re: /\b(skip|next (exercise|pose)|move on|go to the next)\b/ },
  { name: 'previous', re: /\b(previous (exercise|pose|step|one)|go back|last (exercise|pose))\b/ },

  { name: 'explain_pose', re: /\b(explain|how (do|to|should) (i|you)|show me how|teach me|describe|tell me about)\b.*\b(pose|exercise|posture|this|it|move)\b/ },

  { name: 'open_history', re: /\b(show|open|see|view|go to|pull up)\b.*\b(history|past sessions|previous sessions|session log)\b/ },
  { name: 'show_progress', re: /\b(show|open|see|view|go to|pull up|check)\b.*\b(progress|stats|statistics|streak)\b/ },
  { name: 'open_preferences', re: /\b(open|show|edit|change|update|adjust)\b.*\b(preferences?|personali[sz]ation)\b/ },
  { name: 'open_meditation', re: /\b(open|show|start|go to)\b.*\b(meditation|pranayama|breathing exercises?)\b/ },
  { name: 'open_learn', re: /\b(open|show|go to)\b.*\b(learn|yog kriyas?|kriyas?|library)\b/ },
  { name: 'open_chat', re: /\b(open|show|go to)\b.*\b(chat|assistant|chatbot)\b/ },
  { name: 'open_messages', re: /\b(open|show|go to|check)\b.*\b(messages|inbox)\b/ },
  { name: 'open_favorites', re: /\b(open|show|go to)\b.*\b(favou?rites?)\b/ },
  { name: 'open_account', re: /\b(open|show|go to)\b.*\b(account|profile)\b/ },
  { name: 'go_home', re: /\b(go|take me|back|return)\b.*\b(home|main screen)\b|\bhome screen\b/ },
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
