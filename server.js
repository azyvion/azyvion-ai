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

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Set OPENAI_MODEL in .env to whichever model your OpenAI account has access
// to. Defaults to the model originally configured for this project.
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

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
        .json({ error: "Azyvion AI is not configured yet. Add OPENAI_API_KEY to .env." });
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

    const response = await client.responses.create({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: cleaned,
    });

    res.json({ text: response.output_text || "I couldn't generate a response." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Something went wrong while generating the response." });
  }
});

app.listen(port, () => {
  console.log(`Azyvion AI: http://localhost:${port}`);
});
