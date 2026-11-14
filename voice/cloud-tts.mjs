// cloud-tts.mjs — OPTIONAL natural AI voice. Not active until a TTS endpoint exists (see voice-ui / index hook `ttsUrl`).
// Expects: POST { text }  ->  audio bytes (Content-Type audio/*). Anything else = fall back to the browser voice.
// Fixed phrases ("Paused.", "Yes?") are cached in memory so they cost nothing the second time.

export function createCloudTTS({ url, timeoutMs = 8000, cacheMax = 40 }) {
  const cache = new Map();
  return async function tts(text) {
    const key = text.trim();
    if (cache.has(key)) return cache.get(key);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({ text: key.slice(0, 600) }),
      });
      if (!res.ok || !(res.headers.get('content-type') || '').startsWith('audio/')) return null;
      const blob = await res.blob();
      if (key.length <= 80) {
        if (cache.size >= cacheMax) cache.delete(cache.keys().next().value);
        cache.set(key, blob);
      }
      return blob;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
