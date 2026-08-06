import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

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

// Serves the static frontend too (index.html, app.js, styles.css, etc. all
// live right here in the project root), so `npm start` gives you a full
// working app locally at http://localhost:3000 — the same root folder is
// what GitHub Pages serves independently in production.
app.use(express.static(".", { index: "index.html" }));

// Groq's API is OpenAI-compatible, so we reuse the same "openai" SDK —
// just pointed at Groq's endpoint with a Groq key. Free tier, no card
// required. Get a key at https://console.groq.com/keys
const client = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

// Set GROQ_MODEL in .env to change models. llama-3.3-70b-versatile was
// deprecated by Groq on 2026-06-17. openai/gpt-oss-120b was tried next but
// has a known, unresolved Groq-side bug where it sometimes "thinks" and
// never emits visible content (see
// https://community.groq.com/t/gp120b-responses-only-contain-reasoning-tokens/759) —
// no combination of reasoning params fixes it reliably. moonshotai/kimi-k2-instruct-0905
// is a non-reasoning model, so this class of bug doesn't apply to it.
const MODEL = process.env.GROQ_MODEL || "moonshotai/kimi-k2-instruct-0905";

// Used automatically whenever a message includes an image. Set
// GROQ_VISION_MODEL in .env to override. See https://console.groq.com/docs/vision
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
const MAX_IMAGES_PER_REQUEST = 5; // Groq's current vision model limit

const SYSTEM_PROMPT = `You are Azyvion AI, the official AI assistant prototype of Azyvion.
Be helpful, concise, intelligent, and natural.
Azyvion is an independent technology company exploring AI, digital platforms,
infrastructure, security, and research.
Do not invent Azyvion products, employees, partnerships, customers, or launches.
If asked about something Azyvion has not officially provided, say that it is not confirmed.`;

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
    .slice(-20)
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

  // Only the vision model (Qwen 3.6) is a reasoning model now — "none" is
  // the value that disables its thinking mode. Note this value is ONLY
  // valid for Qwen; GPT-OSS models only accept low/medium/high, which is
  // part of why the previous default model needed replacing above.
  // See https://console.groq.com/docs/reasoning
  const reasoningParams = hasImages ? { reasoning_effort: "none" } : {};

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disables proxy buffering (e.g. on Render/Nginx) so chunks flush immediately
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...cleaned],
      stream: true,
      max_completion_tokens: 4096,
      ...reasoningParams,
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

    if (!full) {
      // Diagnostic breadcrumb for Render logs — if this shows up, check
      // finish_reason: "length" means it ran out of tokens (raise
      // max_completion_tokens further), anything else points elsewhere.
      console.warn(`Empty response from ${model}. finish_reason: ${lastFinishReason}`);
      send("delta", { text: "I couldn't generate a response." });
    }
    send("done", {});
  } catch (e) {
    console.error(e);
    send("error", { error: "Something went wrong while generating the response." });
  } finally {
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Azyvion AI: http://localhost:${port}`);
});
