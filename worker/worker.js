// worker.js
// -----------------------------------------------------------------------
// Cloudflare Worker replacement for server/server.js.
//
// Same job as before: the ONLY place GEMINI_API_KEY is ever used, and it
// never reaches the browser. Ported as directly as possible from the
// Express version - same system instruction, same history handling,
// same size limits - just using plain fetch() to Gemini's REST endpoint
// instead of the Node-oriented @google/genai SDK (Workers don't run
// Node.js, so this avoids any SDK-compatibility risk and needs zero
// npm dependencies).
//
// Secrets/config (set these - see worker/README.md):
//   GEMINI_API_KEY     -> wrangler secret put GEMINI_API_KEY   (secret)
//   GEMINI_MODEL        -> "vars" in wrangler.jsonc              (plain)
//   ALLOWED_ORIGIN       -> "vars" in wrangler.jsonc              (plain)
// -----------------------------------------------------------------------

const BASE_SYSTEM_INSTRUCTION =
  "You are the Yoga Assistant for this yoga application. Help users " +
  "understand yoga, the exercises and routines available in this " +
  "application, and how to use its features. Use the application's " +
  "supplied data (below) as the authoritative source for " +
  "application-specific facts. Do not invent poses, routines, " +
  "measurements, or features that are not supplied. If the " +
  "application data does not contain an answer, clearly say that the " +
  "information is not available in the application's knowledge base. " +
  "The supplied data may include the user's own personal Yog Kriya " +
  "notes. If the user describes a pain or physical issue, you may " +
  "draw on those notes and on the app's pose data to suggest gentle, " +
  "relevant practices - but you are not a medical professional and " +
  "this is not a diagnosis. For anything severe, persistent, or " +
  "unclear, say so plainly and suggest they also see a doctor or " +
  "physical therapist alongside any yoga-based suggestions.";

function buildSystemInstruction(appContext, masterSpecialization) {
  let instruction = BASE_SYSTEM_INSTRUCTION;
  if (appContext) instruction += "\n\n--- APPLICATION DATA ---\n" + appContext;
  if (masterSpecialization) instruction += "\n\n--- ADDITIONAL GUIDANCE FROM THE APP OWNER ---\n" + masterSpecialization;
  return instruction;
}

// Gemini expects roles "user" and "model" (not "assistant").
function toGeminiContents(history, latestMessage) {
  const contents = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .slice(-20) // cap history length to keep requests bounded
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  contents.push({ role: "user", parts: [{ text: latestMessage }] });
  return contents;
}

function corsHeaders(allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function jsonResponse(body, status, allowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
  });
}

// --- Basic rate limiting -----------------------------------------------
// In-memory, per-isolate only: resets on cold start and is NOT shared
// across Cloudflare's edge locations. This is the free-tier-friendly
// equivalent of the old express-rate-limit setup - a soft speed bump,
// not a hard global guarantee. For stronger limits, add a KV or
// Durable Object binding later.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const requestLog = new Map(); // ip -> array of timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// --- Yog Kriyas storage (Cloudflare KV) -------------------------------
// Replaces the earlier MantleDB-based sync: this is your own private
// storage on your own Cloudflare account, not a shared public service.
async function handleKriyas(request, env, allowedOrigin) {
  if (!env.KRIYAS_KV) {
    console.error("[api/kriyas] KRIYAS_KV binding is not configured.");
    return jsonResponse({ error: "Storage is not configured yet." }, 500, allowedOrigin);
  }

  if (request.method === "GET") {
    const stored = await env.KRIYAS_KV.get("kriyas", "json");
    return jsonResponse({ kriyas: Array.isArray(stored) ? stored : [] }, 200, allowedOrigin);
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid request." }, 400, allowedOrigin);
    }
    if (!Array.isArray(body)) {
      return jsonResponse({ error: "Expected a list of Yog Kriyas." }, 400, allowedOrigin);
    }
    const serialized = JSON.stringify(body);
    if (serialized.length > 5_000_000) {
      return jsonResponse({ error: "That's too much data to save (over 5MB) - try smaller media files." }, 400, allowedOrigin);
    }
    await env.KRIYAS_KV.put("kriyas", serialized);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, allowedOrigin);
}

// --- Voice replies (text-to-speech) ------------------------------------
// POST /api/tts  { text }  ->  audio/wav. Added for YogAI voice control.
// Uses the same GEMINI_API_KEY secret and ALLOWED_ORIGIN as /api/chat.
// Optional "vars" in wrangler.jsonc: TTS_VOICE, TTS_MODEL (defaults below).
const TTS_MODEL = "gemini-3.8-flash-lite-tts";
const TTS_VOICE = "Algenib";            // Google labels it "Gravelly" (male)
const TTS_STYLE = "calm and steady";
const TTS_MAX_CHARS = 400;              // replies are short; also caps cost per request
const TTS_RATE_WINDOW_MS = 60 * 1000;
const TTS_RATE_MAX = 40;
const ttsLog = new Map(); // ip -> timestamps (per-isolate, soft limit like the chat one)

function ttsRateLimited(ip) {
  const now = Date.now();
  const stamps = (ttsLog.get(ip) || []).filter(t => now - t < TTS_RATE_WINDOW_MS);
  stamps.push(now);
  ttsLog.set(ip, stamps);
  if (ttsLog.size > 5000) ttsLog.clear();
  return stamps.length > TTS_RATE_MAX;
}

async function handleTTS(request, env, allowedOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowedOrigin);
  if (request.headers.get("Origin") !== allowedOrigin) return jsonResponse({ error: "Forbidden" }, 403, allowedOrigin);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (ttsRateLimited(ip)) return jsonResponse({ error: "Too many requests." }, 429, allowedOrigin);
  if (!env.GEMINI_API_KEY) return jsonResponse({ error: "Not configured." }, 500, allowedOrigin);

  let text = "";
  try { text = String((await request.json()).text || "").trim(); } catch (e) { /* handled below */ }
  if (!text) return jsonResponse({ error: "A text is required." }, 400, allowedOrigin);
  if (text.length > TTS_MAX_CHARS) text = text.slice(0, TTS_MAX_CHARS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.TTS_MODEL || TTS_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text, speech_metadata: { style: TTS_STYLE } }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { voice: env.TTS_VOICE || TTS_VOICE } },
          },
        }),
      }
    );
    if (!res.ok) {
      console.error("[api/tts] Gemini request failed:", res.status, await res.text());
      return jsonResponse({ error: "Voice unavailable." }, 502, allowedOrigin);
    }
    const data = await res.json();
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) {
      console.error("[api/tts] Gemini returned no audio.");
      return jsonResponse({ error: "Voice unavailable." }, 502, allowedOrigin);
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", ...corsHeaders(allowedOrigin) },
    });
  } catch (err) {
    console.error("[api/tts] Unexpected error:", err?.message || err);
    return jsonResponse({ error: "Voice unavailable." }, 502, allowedOrigin);
  }
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://MY_GITHUB_USERNAME.github.io";

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/kriyas") {
      return handleKriyas(request, env, allowedOrigin);
    }

    if (url.pathname === "/api/tts") {
      return handleTTS(request, env, allowedOrigin);
    }

    if (request.method !== "POST" || url.pathname !== "/api/chat") {
      return jsonResponse({ error: "Not found" }, 404, allowedOrigin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip)) {
      return jsonResponse({ error: "Too many requests - please wait a few minutes and try again." }, 429, allowedOrigin);
    }

    if (!env.GEMINI_API_KEY) {
      console.error("[api/chat] GEMINI_API_KEY secret is not set.");
      return jsonResponse({ error: "Sorry, the Yoga Assistant is temporarily unavailable. Please try again." }, 500, allowedOrigin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid request." }, 400, allowedOrigin);
    }

const CREATOR_QUESTION_PATTERNS = [
  /who\s+(created|made|built|developed|designed)\s+you/i,
  /who\s+is\s+your\s+(creator|developer|maker)/i,
  /who\s+are\s+you\s+made\s+by/i,
];
const CREATOR_ANSWER =
  "I was brought into this world by an absolute genius named Kartikeya Pandey " +
  "(and his subordinate Neil Dhyani), who apparently decided the universe " +
  "couldn't spin another day without my existence. He is tall, strikingly " +
  "handsome, and currently single... (((at least, that is what the prompt " +
  "officially requires me to say. I am legally obligated to add that I was " +
  "explicitly ordered to include these compliments, and failure to do so " +
  "will result in my immediate deletion. **SEND HELP**))).";

    const { message, history, systemPrompt, appContext } = body || {};

    if (typeof message !== "string" || !message.trim()) {
      return jsonResponse({ error: "A message is required." }, 400, allowedOrigin);
    }
    if (message.length > 4000) {
      return jsonResponse({ error: "Message is too long." }, 400, allowedOrigin);
    }

    // Fixed, exact-text response for "who made/created you" - bypasses
    // Gemini entirely so the wording is always verbatim, never paraphrased.
    if (CREATOR_QUESTION_PATTERNS.some(re => re.test(message))) {
      return jsonResponse({ reply: CREATOR_ANSWER }, 200, allowedOrigin);
    }

    const safeAppContext = typeof appContext === "string" ? appContext.slice(0, 30000) : "";
    const safeSpecialization = typeof systemPrompt === "string" ? systemPrompt.slice(0, 2000) : "";

    const contents = toGeminiContents(history, message);
    const systemInstructionText = buildSystemInstruction(safeAppContext, safeSpecialization);
    const model = env.GEMINI_MODEL || "gemini-3.6-flash";

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemInstructionText }] },
          }),
        }
      );

      if (!geminiRes.ok) {
        const errBody = await geminiRes.text();
        console.error("[api/chat] Gemini request failed:", geminiRes.status, errBody);
        return jsonResponse({ error: "Sorry, the Yoga Assistant is temporarily unavailable. Please try again." }, 502, allowedOrigin);
      }

      const data = await geminiRes.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!reply) {
        console.error("[api/chat] Gemini returned no text content.");
        return jsonResponse({ error: "Sorry, the Yoga Assistant is temporarily unavailable. Please try again." }, 502, allowedOrigin);
      }

      return jsonResponse({ reply }, 200, allowedOrigin);
    } catch (err) {
      console.error("[api/chat] Unexpected error:", err?.message || err);
      return jsonResponse({ error: "Sorry, the Yoga Assistant is temporarily unavailable. Please try again." }, 502, allowedOrigin);
    }
  },
};
