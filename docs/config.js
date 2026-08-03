// Where the Azyvion AI backend (server.js) is deployed.
//
// - Running locally with `npm start`, or hosting server.js somewhere that
//   also serves this /docs folder: leave this as "" (same origin).
// - Hosting this frontend on GitHub Pages with the backend deployed
//   separately (Render, Railway, Fly.io, etc.): set this to that backend's
//   full URL, e.g. "https://azyvion-ai.onrender.com" (no trailing slash).
window.AZYVION_CONFIG = {
  API_BASE_URL: "https://azyvion-ai.onrender.com",
};
