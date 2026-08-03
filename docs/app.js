const API_BASE = (window.AZYVION_CONFIG && window.AZYVION_CONFIG.API_BASE_URL) || "";

const input = document.getElementById("input"),
  composer = document.getElementById("composer"),
  messages = document.getElementById("messages"),
  send = document.getElementById("send"),
  statusText = document.getElementById("statusText"),
  statusDot = document.getElementById("statusDot"),
  suggestions = document.getElementById("suggestions");

const history = [];
let demoMode = false;

function addMessage(role, text) {
  const w = document.createElement("div");
  w.className = `message ${role}`;
  w.innerHTML = `<div class="avatar">${role === "assistant" ? "A" : "YOU"}</div><div class="bubble"><span class="label">${role === "assistant" ? "AZYVION AI" : "YOU"}</span><p></p></div>`;
  w.querySelector("p").textContent = text;
  messages.appendChild(w);
  messages.scrollTop = messages.scrollHeight;
  return w;
}

function typing() {
  const w = document.createElement("div");
  w.className = "message assistant";
  w.innerHTML = '<div class="avatar">A</div><div class="bubble"><span class="label">AZYVION AI</span><p class="typing"><span></span><span></span><span></span></p></div>';
  messages.appendChild(w);
  messages.scrollTop = messages.scrollHeight;
  return w;
}

async function checkStatus() {
  // No backend configured at all (e.g. this is a standalone GitHub Pages
  // deploy with no API_BASE_URL set) — go straight to demo mode instead of
  // firing a request that can only fail.
  if (!API_BASE && window.location.protocol !== "http:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    enterDemoMode("No backend configured for this deployment.");
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/api/status`);
    const d = await r.json();
    if (d.configured) {
      statusText.textContent = "System online";
      statusDot.parentElement.classList.add("ready");
    } else {
      statusText.textContent = "API key required";
      statusDot.parentElement.classList.add("error");
    }
  } catch {
    enterDemoMode("Couldn't reach the Azyvion AI backend.");
  }
}

function enterDemoMode(reason) {
  demoMode = true;
  statusText.textContent = "Demo mode — backend not connected";
  statusDot.parentElement.classList.add("error");
  console.info(`Azyvion AI: ${reason} Set API_BASE_URL in config.js to connect a live backend.`);
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || send.disabled) return;

  addMessage("user", text);
  history.push({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";
  suggestions.style.display = "none";

  if (demoMode) {
    addMessage(
      "assistant",
      "This is a static preview — no backend is connected here. Deploy server.js (see README) and set API_BASE_URL in config.js to enable real responses."
    );
    return;
  }

  send.disabled = true;
  const t = typing();
  try {
    const r = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const d = await r.json();
    t.remove();
    if (!r.ok) throw new Error(d.error || "Request failed");
    addMessage("assistant", d.text);
    history.push({ role: "assistant", content: d.text });
  } catch (e) {
    t.remove();
    addMessage("assistant", `I couldn't connect right now. ${e.message}`);
  } finally {
    send.disabled = false;
    input.focus();
  }
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(input.value);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
});

document.querySelectorAll(".suggestions button").forEach((b) =>
  b.addEventListener("click", () => sendMessage(b.textContent))
);

checkStatus();
