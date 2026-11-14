// llm-adapter.mjs — open-ended voice questions, sent to YogAI's EXISTING chat Worker.
// Same request shape the Chat screen already uses: { message, history, systemPrompt, appContext }.
// Only already-transcribed text is sent. Audio never leaves the browser through this path.

// 380 keeps every spoken reply under the Worker's 400-character voice limit, so speech never cuts off mid-sentence.
export function toSpeech(raw, maxChars = 380) {
  let t = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/[*_`~>#]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…').trim();
}

export function createWorkerAsk({
  url,
  getSystemPrompt = () => '',
  getAppContext = () => '',
  timeoutMs = 15000,
  maxHistory = 8,
}) {
  const history = []; // voice conversation only; kept separate from the text Chat screen
  const HINT =
    ' (Voice answer: two to three short spoken sentences, plain words, no lists or markdown.' +
    ' You may answer general yoga, breathing, meditation and Ayurveda questions from general knowledge' +
    ' and say when something is general knowledge rather than app data.' +
    ' No medical advice: for health conditions, herbs or supplements, suggest a doctor or qualified practitioner.)';

  return async function ask(text) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          message: text + HINT,
          history: history.slice(-maxHistory),
          systemPrompt: getSystemPrompt(),
          appContext: getAppContext(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return "Sorry, the yoga assistant is unavailable right now.";
      const reply = toSpeech(data.reply) || "Sorry, I don't have an answer for that.";
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      return reply;
    } catch {
      return "Sorry, I couldn't reach the yoga assistant just now.";
    } finally {
      clearTimeout(timer);
    }
  };
}
