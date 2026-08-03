# Azyvion AI — MVP

Azyvion-branded chat UI with conversation context and a server-side API key.

## Why two parts

GitHub Pages only serves static files — it can't run Node.js or keep an API
key secret. So this project is split:

- **`/docs`** — the static frontend. This is what you deploy to GitHub Pages.
- **`server.js`** (root) — the Express backend that talks to OpenAI. This
  needs a real Node host (Render, Railway, Fly.io, a VPS, etc.) — anywhere
  that runs a persistent Node process and lets you set environment
  variables.

They talk to each other over HTTP; `docs/config.js` is where the frontend is
told where the backend lives.

## Run everything locally (frontend + backend together)

1. Install Node.js 20+.
2. `npm install`
3. Copy `.env.example` to `.env` and add `OPENAI_API_KEY=...`
4. `npm start`
5. Open `http://localhost:3000` — `server.js` serves `/docs` itself, so this
   works standalone with no extra config. Leave `API_BASE_URL` in
   `docs/config.js` as `""`.

## Deploy the frontend to GitHub Pages

1. Push this repo to GitHub.
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch:
   `main`, folder: **`/docs`** → Save.
3. Your site will be live at `https://<your-username>.github.io/<repo-name>/`.

On its own this gives you a working UI in **demo mode**: it loads, looks
right, and replies with a message explaining no backend is connected yet —
it won't silently break or hang on "Checking system".

## Connect a live backend to the GitHub Pages site

1. Deploy `server.js` to a Node host (Render, Railway, Fly.io, etc.):
   - Build/start command: `npm install && npm start`
   - Environment variables: `OPENAI_API_KEY` (required), `OPENAI_MODEL`
     (optional), `ALLOWED_ORIGINS` (recommended — set it to your GitHub
     Pages URL from step above, e.g. `https://yourname.github.io`)
2. Copy the URL your host gives you (e.g. `https://azyvion-ai.onrender.com`).
3. Edit `docs/config.js`:
   ```js
   window.AZYVION_CONFIG = {
     API_BASE_URL: "https://azyvion-ai.onrender.com",
   };
   ```
4. Commit and push — GitHub Pages picks up the change automatically.

## Project structure

```
azyvion-ai/
├── docs/              # Static frontend — served by GitHub Pages
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── config.js      # Points the frontend at the backend URL
│   ├── logo.png
│   └── favicon.ico
├── server.js           # Express backend — deploy separately
├── package.json
├── .env.example
└── .gitignore
```

## Notes

- Never expose `OPENAI_API_KEY` in frontend code or commit `.env` — it's
  already listed in `.gitignore`.
- `OPENAI_MODEL` in `.env` lets you change models without touching code;
  defaults to the model this project was originally configured with.
- `ALLOWED_ORIGINS` restricts which domains may call `/api/chat` — set it
  once you know your GitHub Pages URL so random sites can't ride on your key.
