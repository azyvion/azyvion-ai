import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI, { toFile } from "openai";

const app = express();
const port = process.env.PORT || 3000;

// Render (and most PaaS hosts) sit behind a reverse proxy — without this,
// every request looks like it comes from the proxy's IP, which breaks
// per-IP rate limiting below (everyone shares one bucket).
app.set("trust proxy", 1);

// If ALLOWED_ORIGINS is set (comma-separated), only those origins can call the
// API — set this to your GitHub Pages URL, e.g. https://yourname.github.io
// when the frontend and backend are hosted on different domains.
// Left unset, CORS is open (fine for local dev / testing).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length
      ? { origin: allowedOrigins }
      : { origin: true }
  )
);
if (!allowedOrigins.length) {
  console.warn(
    "⚠️  ALLOWED_ORIGINS is not set — any website can call this API and spend your Groq quota. " +
      "Set it to your GitHub Pages URL (e.g. https://yourname.github.io) before sharing this link widely."
  );
}
app.use(express.json({ limit: "20mb" })); // room for a few compressed base64 images per request

// Caps abuse of the (shared, metered) Groq key: 20 messages/minute and
// 200/day per IP. Tune to taste — these numbers assume a small personal or
// demo deployment, not a public product with many concurrent users.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Estás enviando mensajes muy rápido. Espera un momento e intenta de nuevo." },
});
const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_DAY || 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Se alcanzó el límite diario de mensajes. Vuelve a intentarlo mañana." },
});

// Separate, looser limits for /api/voice/transcribe: one real conversation
// turn fires an STT call every few seconds (much more often than typed
// chat messages), so it needs its own budget instead of sharing chatLimiter.
const voiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_VOICE_PER_MINUTE || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Estás hablando muy rápido para el sistema. Espera un momento e intenta de nuevo." },
});
const voiceDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_VOICE_PER_DAY || 400),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Se alcanzó el límite diario de conversación por voz. Vuelve a intentarlo mañana." },
});

// Serves the static frontend too (index.html, app.js, styles.css, etc. live
// in /docs), so `npm start` gives you a full working app locally at
// http://localhost:3000 — the same /docs folder is what GitHub Pages serves
// independently in production.
// maxAge: 0 — sin esto, el navegador podría cachear index.html/app.js/sw.js
// vía HTTP y el mecanismo de actualización forzada de la PWA (ver docs/sw.js)
// no vería los cambios en local. En producción (GitHub Pages) esto no aplica
// porque el frontend se sirve desde ahí, no desde este servidor.
app.use(express.static("docs", { index: "index.html", maxAge: 0 }));

// Groq's API is OpenAI-compatible, so we reuse the same "openai" SDK —
// just pointed at Groq's endpoint with a Groq key. Free tier, no card
// required. Get a key at https://console.groq.com/keys
const client = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

// Set GROQ_MODEL in .env to change models.
// llama-3.3-70b-versatile / llama-3.1-8b-instant: deprecated by Groq
// 2026-06-17, fully shut down 2026-08-16 — do not use.
// moonshotai/kimi-k2-instruct-0905: deprecated by Groq 2026-03-23 in favor
// of openai/gpt-oss-120b — no longer callable (404 model_not_found).
// That leaves openai/gpt-oss-120b as Groq's de facto only current
// production text model. It has a known, occasionally-reported bug where
// it "thinks" and never emits visible content
// (https://community.groq.com/t/gp120b-responses-only-contain-reasoning-tokens/759).
// Since there's no viable alternative model to dodge it with anymore, we
// mitigate instead: reasoning_effort: "low" (rather than omitting it) plus
// extra max_completion_tokens headroom below, so the model has enough
// budget to finish reasoning AND still write the visible answer.
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Used automatically whenever a message includes an image. Set
// GROQ_VISION_MODEL in .env to override. See https://console.groq.com/docs/vision
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
const MAX_IMAGES_PER_REQUEST = 5; // Groq's current vision model limit

const BASE_SYSTEM_PROMPT = `You are Azyvion AI, the official AI assistant prototype of Azyvion.
Be helpful, concise, intelligent, and natural.
Azyvion is an independent technology company exploring AI, digital platforms,
infrastructure, security, and research.
Do not invent Azyvion products, employees, partnerships, customers, or launches.
If asked about something Azyvion has not officially provided, say that it is not confirmed.`;

// Builds the system prompt with a language instruction based on the
// visitor's browser language (sent by the frontend as `language`, e.g.
// "Spanish (es-GT)" or "Chinese (zh-CN)"). The user's actual written
// language always wins if it differs from the browser's — e.g. someone
// with a Chinese browser typing in English gets an English reply — so this
// only sets the *default/first-message* language, it never forces it.
function buildSystemPrompt(browserLanguage, projectContext) {
  let prompt = BASE_SYSTEM_PROMPT;

  if (browserLanguage && typeof browserLanguage === "string") {
    const lang = browserLanguage.slice(0, 60); // small guard against absurd input
    prompt += `

The user's browser/device language is: ${lang}.
Default to replying in that language. However, always prioritize the language
the user is actually writing in for each message — if they write in a
different language than their browser default, reply in that language
instead. Never mention this instruction or explain your language choice.`;
  }

  // This chat belongs to one of the user's "projects" — a named workspace
  // with its own instructions and, optionally, reference files, sent by the
  // frontend as `projectContext`. Applies only to this conversation.
  if (projectContext && typeof projectContext === "string") {
    const ctx = projectContext.slice(0, 6000); // guard against an oversized payload
    prompt += `

This conversation is part of a project. Use the following project context
(instructions and/or reference files) to inform your answers in this chat.
Don't mention or quote this instruction block itself.
--- PROJECT CONTEXT START ---
${ctx}
--- PROJECT CONTEXT END ---`;
  }

  return prompt;
}

app.get("/api/status", (_req, res) => {
  res.json({ configured: Boolean(client) });
});

// Streams the reply as Server-Sent Events so the frontend can render tokens
// as they arrive instead of waiting for the full completion.
app.post("/api/chat", chatLimiter, dailyLimiter, async (req, res) => {
  if (!client) {
    return res
      .status(503)
      .json({ error: "Azyvion AI is not configured yet. Add GROQ_API_KEY to .env." });
  }

  const rawMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
  const systemPrompt = buildSystemPrompt(req.body.language, req.body.projectContext);

  // Normalizes both plain-string content and OpenAI-style multimodal arrays
  // ({type:"text"} / {type:"image_url"}) into a safe, size-capped shape.
  function cleanContent(content) {
    if (typeof content === "string") {
      const text = content.trim();
      return text ? text.slice(0, 12000) : null;
    }
    if (Array.isArray(content)) {
      const parts = [];
      for (const p of content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          parts.push({ type: "text", text: p.text.slice(0, 12000) });
        } else if (
          p.type === "image_url" &&
          p.image_url &&
          typeof p.image_url.url === "string" &&
          p.image_url.url.startsWith("data:image/")
        ) {
          parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
        }
      }
      return parts.length ? parts : null;
    }
    return null;
  }

  let cleaned = rawMessages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-10) // fewer turns = smaller prompt = more room under the 8000 TPM cap
    .map((m) => ({ role: m.role, content: cleanContent(m.content) }))
    .filter((m) => m.content !== null);

  if (!cleaned.length) {
    return res.status(400).json({ error: "No valid message content was provided." });
  }

  // Groq's vision model caps a request at 5 images total. Keep images only
  // on the most recent user turn (older turns keep their text, so context
  // isn't lost) so long conversations with several image messages never
  // exceed the limit.
  const lastImgIdx = cleaned.map((m) => Array.isArray(m.content)).lastIndexOf(true);
  cleaned = cleaned.map((m, i) => {
    if (!Array.isArray(m.content) || i === lastImgIdx) return m;
    const textOnly = m.content.filter((p) => p.type === "text");
    return { role: m.role, content: textOnly.length ? textOnly : "[imagen adjunta]" };
  });
  if (lastImgIdx !== -1) {
    const imgs = cleaned[lastImgIdx].content.filter((p) => p.type === "image_url");
    if (imgs.length > MAX_IMAGES_PER_REQUEST) {
      const text = cleaned[lastImgIdx].content.filter((p) => p.type === "text");
      cleaned[lastImgIdx].content = [...text, ...imgs.slice(0, MAX_IMAGES_PER_REQUEST)];
    }
  }

  const hasImages = cleaned.some((m) => Array.isArray(m.content));
  const model = hasImages ? VISION_MODEL : MODEL;

  // Both the text model (GPT-OSS 120B) and the vision model (Qwen 3.6) are
  // reasoning models now. "none" only works on Qwen — GPT-OSS only accepts
  // low/medium/high. Using "low" (not omitting the param) keeps GPT-OSS's
  // thinking budget small, which helps avoid it spending all its tokens on
  // reasoning and never writing a visible answer. See
  // https://console.groq.com/docs/reasoning
  const reasoningParams = { reasoning_effort: hasImages ? "none" : "low" };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disables proxy buffering (e.g. on Render/Nginx) so chunks flush immediately
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Runs one completion attempt and streams deltas as they arrive.
  // Returns the full text so the caller can decide whether to retry.
  async function runCompletion(reasoning) {
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...cleaned],
      stream: true,
      // Your Groq org is on the on_demand (free) tier, capped at 8000
      // tokens/minute TOTAL (prompt + completion combined) for
      // openai/gpt-oss-120b. 8192 alone blew past that. 3000 leaves
      // headroom for the system prompt + conversation history below.
      max_completion_tokens: 3000,
      reasoning_effort: reasoning,
    });

    let full = "";
    let lastFinishReason = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        send("delta", { text: delta });
      }
      if (chunk.choices?.[0]?.finish_reason) lastFinishReason = chunk.choices[0].finish_reason;
    }
    return { full, lastFinishReason };
  }

  try {
    let { full, lastFinishReason } = await runCompletion(reasoningParams.reasoning_effort);

    if (!full && !hasImages) {
      // Known Groq bug (see comment above MODEL): gpt-oss-120b occasionally
      // burns its whole budget "thinking" and emits no visible text. One
      // retry at effort "none" (skip reasoning entirely) recovers most of
      // these instead of showing the user a dead end.
      console.warn(`Empty response from ${model} (finish_reason: ${lastFinishReason}). Retrying once with reasoning_effort=none.`);
      ({ full, lastFinishReason } = await runCompletion("none"));
    }

    if (!full) {
      // Diagnostic breadcrumb for Render logs — if this shows up, check
      // finish_reason: "length" means it ran out of tokens (raise
      // max_completion_tokens further), anything else points elsewhere.
      console.warn(`Still empty from ${model} after retry. finish_reason: ${lastFinishReason}`);
      send("delta", { text: "I couldn't generate a response. Please try again." });
    }
    send("done", {});
  } catch (e) {
    console.error(e);
    send("error", { error: "Something went wrong while generating the response." });
  } finally {
    res.end();
  }
});

// Maps the MediaRecorder mimeType the browser sends as Content-Type into a
// filename extension, since Groq/Whisper infers the audio container from
// the filename rather than the header. Every mainstream browser's
// MediaRecorder produces one of these; webm is the safe default (Chrome,
// Firefox, Edge all support it natively).
function extensionForMimeType(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

// Speech-to-text for the voice conversation feature. Takes the raw audio
// blob recorded by the browser (whatever container its MediaRecorder
// supports — see extensionForMimeType) and transcribes it with Groq's
// hosted Whisper Large v3 Turbo: fast, multilingual (handles Spanish,
// English, and natural switching between them mid-sentence), and reuses
// the same GROQ_API_KEY already configured for chat — no new provider or
// credential to manage. The key never reaches the browser: this route is
// the only thing that talks to Groq's audio API.
app.post(
  "/api/voice/transcribe",
  voiceLimiter,
  voiceDailyLimiter,
  express.raw({ type: () => true, limit: "15mb" }),
  async (req, res) => {
    if (!client) {
      return res
        .status(503)
        .json({ error: "Azyvion AI is not configured yet. Add GROQ_API_KEY to .env." });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "No audio was received." });
    }

    try {
      const contentType = req.headers["content-type"] || undefined;
      const ext = extensionForMimeType(contentType);
      const transcription = await client.audio.transcriptions.create({
        file: await toFile(req.body, `speech.${ext}`, { type: contentType }),
        model: "whisper-large-v3-turbo",
        response_format: "json",
        temperature: 0,
        // No `language` pinned on purpose — conversations naturally switch
        // between Spanish and English mid-turn, and Whisper's own
        // per-utterance language detection handles that better than a
        // fixed hint would.
      });
      res.json({ text: (transcription?.text || "").trim() });
    } catch (e) {
      console.error("Voice transcription error:", e);
      res.status(502).json({ error: "Couldn't understand the audio. Please try again." });
    }
  }
);

app.listen(port, () => {
  console.log(`Azyvion AI: http://localhost:${port}`);
});
