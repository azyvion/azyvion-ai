import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3000;

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
app.use(express.json({ limit: "2mb" }));

// Serves the static frontend too, so `npm start` still gives you a full
// working app locally at http://localhost:3000 — the same /docs folder is
// what GitHub Pages serves independently in production.
app.use(express.static("docs"));

// Groq's API is OpenAI-compatible, so we reuse the same "openai" SDK —
// just pointed at Groq's endpoint with a Groq key. Free tier, no card
// required. Get a key at https://console.groq.com/keys
const client = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

// Set GROQ_MODEL in .env to change models. llama-3.3-70b-versatile is a
// solid free default; see https://console.groq.com/docs/models for others.
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are Azyvion AI, the official AI assistant prototype of Azyvion.
Be helpful, concise, intelligent, and natural.
Azyvion is an independent technology company exploring AI, digital platforms,
infrastructure, security, and research.
Do not invent Azyvion products, employees, partnerships, customers, or launches.
If asked about something Azyvion has not officially provided, say that it is not confirmed.`;

app.get("/api/status", (_req, res) => {
  res.json({ configured: Boolean(client) });
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!client) {
      return res
        .status(503)
        .json({ error: "Azyvion AI is not configured yet. Add GROQ_API_KEY to .env." });
    }

    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const cleaned = messages
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0
      )
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }));

    if (!cleaned.length) {
      return res.status(400).json({ error: "No valid message content was provided." });
    }

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...cleaned],
    });

    const text = completion.choices?.[0]?.message?.content || "I couldn't generate a response.";
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Something went wrong while generating the response." });
  }
});

app.listen(port, () => {
  console.log(`Azyvion AI: http://localhost:${port}`);
});
