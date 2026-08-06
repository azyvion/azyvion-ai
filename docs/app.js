const API_BASE = (window.AZYVION_CONFIG && window.AZYVION_CONFIG.API_BASE_URL) || "";
const STORAGE_KEY = "azyvion_ai_chats_v1";

const appEl = document.querySelector(".app"),
  menuToggle = document.getElementById("menuToggle"),
  scrim = document.getElementById("scrim"),
  sidebarEl = document.getElementById("sidebar"),
  historyEl = document.getElementById("history"),
  newChatBtn = document.getElementById("newChat"),
  input = document.getElementById("input"),
  composer = document.getElementById("composer"),
  attachBtn = document.getElementById("attachBtn"),
  fileInput = document.getElementById("fileInput"),
  attachPreview = document.getElementById("attachPreview"),
  thread = document.getElementById("thread"),
  welcome = document.getElementById("welcome"),
  messagesEl = document.getElementById("messages"),
  send = document.getElementById("send"),
  statusText = document.getElementById("statusText"),
  statusWrap = document.getElementById("statusWrap"),
  suggestions = document.getElementById("suggestions");

const MAX_IMAGES = 5; // Groq's qwen3.6-27b vision model accepts up to 5 images per request
let pendingImages = []; // [{ dataUrl, name }] queued for the next message

let demoMode = false;
let chats = loadChats();
let activeId = chats.length ? chats[0].id : createChat();

/* ---------- persistence ---------- */
function loadChats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  } catch {
    /* storage unavailable — chat still works for this session */
  }
}

function createChat() {
  const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  chats.unshift({ id, title: "New chat", messages: [] });
  saveChats();
  return id;
}

function getActiveChat() {
  return chats.find((c) => c.id === activeId);
}

/* ---------- sidebar rendering ---------- */
function renderHistory() {
  historyEl.innerHTML = "";
  if (!chats.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No conversations yet.";
    historyEl.appendChild(empty);
    return;
  }
  chats.forEach((c) => {
    const item = document.createElement("div");
    item.className = `h-item${c.id === activeId ? " active" : ""}`;
    const label = document.createElement("span");
    label.textContent = c.title || "New chat";
    const del = document.createElement("span");
    del.className = "del";
    del.setAttribute("aria-label", "Delete chat");
    del.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(c.id);
    });
    item.appendChild(label);
    item.appendChild(del);
    item.addEventListener("click", () => switchChat(c.id));
    historyEl.appendChild(item);
  });
}

function switchChat(id) {
  activeId = id;
  renderHistory();
  renderMessages();
  closeSidebarOnMobile();
}

function deleteChat(id) {
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return;
  chats.splice(idx, 1);
  saveChats();
  if (activeId === id) {
    activeId = chats.length ? chats[0].id : createChat();
  }
  renderHistory();
  renderMessages();
}

newChatBtn.addEventListener("click", () => {
  activeId = createChat();
  renderHistory();
  renderMessages();
  closeSidebarOnMobile();
  input.focus();
});

/* ---------- mobile sidebar ---------- */
function openSidebar() {
  appEl.classList.add("sidebar-open");
}
function closeSidebar() {
  appEl.classList.remove("sidebar-open");
}
function closeSidebarOnMobile() {
  if (window.innerWidth <= 860) closeSidebar();
}
menuToggle.addEventListener("click", () => {
  appEl.classList.contains("sidebar-open") ? closeSidebar() : openSidebar();
});
scrim.addEventListener("click", closeSidebar);

/* ---------- image attachments ---------- */
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []).filter((f) => f.type.startsWith("image/"));
  fileInput.value = ""; // allow re-selecting the same file later
  for (const file of files) {
    if (pendingImages.length >= MAX_IMAGES) break;
    try {
      const dataUrl = await compressImage(file);
      pendingImages.push({ dataUrl, name: file.name });
    } catch {
      /* skip files the browser can't decode as an image */
    }
  }
  renderAttachPreview();
});

// Downscales + re-encodes as JPEG in the browser before it ever touches the
// network — keeps requests small and comfortably under Groq's 20MB/image
// limit even for large phone photos.
function compressImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderAttachPreview() {
  attachPreview.innerHTML = "";
  pendingImages.forEach((img, i) => {
    const t = document.createElement("div");
    t.className = "attach-thumb";
    t.innerHTML = `<img src="${img.dataUrl}" alt="${img.name}"><span class="rm">✕</span>`;
    t.querySelector(".rm").addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderAttachPreview();
    });
    attachPreview.appendChild(t);
  });
}

// Paste an image straight from the clipboard into the composer.
input.addEventListener("paste", async (e) => {
  const items = Array.from(e.clipboardData?.items || []).filter((it) => it.type.startsWith("image/"));
  if (!items.length || pendingImages.length >= MAX_IMAGES) return;
  e.preventDefault();
  for (const it of items) {
    if (pendingImages.length >= MAX_IMAGES) break;
    const file = it.getAsFile();
    if (!file) continue;
    try {
      const dataUrl = await compressImage(file);
      pendingImages.push({ dataUrl, name: "pasted-image" });
    } catch {}
  }
  renderAttachPreview();
});

/* ---------- message rendering ---------- */
function renderMessages() {
  const chat = getActiveChat();
  messagesEl.innerHTML = "";
  if (!chat || !chat.messages.length) {
    welcome.style.display = "";
    return;
  }
  welcome.style.display = "none";
  chat.messages.forEach((m) => appendMessageEl(m.role, m.content));
  scrollToBottom();
}

function appendMessageEl(role, content) {
  const { text, images } = splitContent(content);
  const w = document.createElement("div");
  w.className = `message ${role}`;
  const imagesHtml = images.length
    ? `<div class="msg-images">${images.map((u) => `<img src="${u}" alt="Imagen adjunta">`).join("")}</div>`
    : "";
  w.innerHTML = `<div class="avatar">${role === "assistant" ? "A" : "YOU"}</div><div class="bubble"><span class="label">${role === "assistant" ? "AZYVION AI" : "YOU"}</span>${imagesHtml}<p></p></div>`;
  w.querySelector("p").textContent = text;
  messagesEl.appendChild(w);
  return w;
}

// Message content can be a plain string or an OpenAI-style array of
// { type: "text" } / { type: "image_url" } parts — this normalizes either
// shape into { text, images } for rendering.
function splitContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (Array.isArray(content)) {
    const text = content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const images = content.filter((p) => p.type === "image_url").map((p) => p.image_url.url);
    return { text, images };
  }
  return { text: "", images: [] };
}

function typingEl() {
  const w = document.createElement("div");
  w.className = "message assistant";
  w.innerHTML = '<div class="avatar">A</div><div class="bubble"><span class="label">AZYVION AI</span><p class="typing"><span></span><span></span><span></span></p></div>';
  messagesEl.appendChild(w);
  scrollToBottom();
  return w;
}

/* ---------- streaming "materialize" renderer ----------
   Each incoming chunk is wrapped in its own span and enters blurred +
   cyan-tinted, then resolves to normal text — the reply "condenses" into
   view instead of just appearing. A pulsing cursor tracks the tail while
   live, and the assistant avatar glows while a response is in flight. */
function startStreamBubble() {
  const w = document.createElement("div");
  w.className = "message assistant streaming";
  w.innerHTML =
    '<div class="avatar">A</div><div class="bubble"><span class="label">AZYVION AI</span><p class="stream-text"></p></div>';
  messagesEl.appendChild(w);
  const p = w.querySelector(".stream-text");
  const cursor = document.createElement("span");
  cursor.className = "stream-cursor";
  p.appendChild(cursor);
  scrollToBottom();

  return {
    el: w,
    push(chunk) {
      const span = document.createElement("span");
      span.className = "mat-in";
      span.textContent = chunk;
      p.insertBefore(span, cursor);
      scrollToBottom();
    },
    finish() {
      w.classList.remove("streaming");
      cursor.remove();
    },
  };
}

function scrollToBottom() {
  thread.scrollTop = thread.scrollHeight;
}

function titleFrom(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > 42 ? clean.slice(0, 42) + "…" : clean;
}

/* ---------- status ---------- */
async function checkStatus() {
  if (!API_BASE && window.location.protocol !== "http:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    enterDemoMode("No backend configured for this deployment.");
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/api/status`);
    const d = await r.json();
    if (d.configured) {
      statusText.textContent = "System online";
      statusWrap.classList.add("ready");
    } else {
      statusText.textContent = "API key required";
      statusWrap.classList.add("error");
    }
  } catch {
    enterDemoMode("Couldn't reach the Azyvion AI backend.");
  }
}

function enterDemoMode(reason) {
  demoMode = true;
  statusText.textContent = "Demo mode — backend not connected";
  statusWrap.classList.add("error");
  console.info(`Azyvion AI: ${reason} Set API_BASE_URL in config.js to connect a live backend.`);
}

/* ---------- sending ---------- */
async function sendMessage(text) {
  text = (text || "").trim();
  const images = pendingImages.slice();
  if ((!text && !images.length) || send.disabled) return;

  const chat = getActiveChat();
  if (welcome.style.display !== "none") welcome.style.display = "none";

  const content = images.length
    ? [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
      ]
    : text;

  if (!chat.messages.length) chat.title = titleFrom(text || "Imagen adjunta");
  chat.messages.push({ role: "user", content });
  saveChats();
  renderHistory();
  appendMessageEl("user", content);
  scrollToBottom();

  input.value = "";
  input.style.height = "auto";
  pendingImages = [];
  renderAttachPreview();

  send.disabled = true;

  if (demoMode) {
    const reply = "This is a static preview — no backend is connected here. Deploy server.js (see README) and set API_BASE_URL in config.js to enable real responses.";
    await streamDemoReply(reply);
    chat.messages.push({ role: "assistant", content: reply });
    saveChats();
    send.disabled = false;
    input.focus();
    return;
  }

  const t = typingEl();
  let stream = null;
  let full = "";
  try {
    const r = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chat.messages }),
    });
    if (!r.ok) {
      let msg = "Request failed";
      try {
        msg = (await r.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    t.remove();
    stream = startStreamBubble();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop(); // keep the last, possibly-incomplete event
      for (const evt of events) {
        const lines = evt.split("\n");
        const eventType = (lines.find((l) => l.startsWith("event: ")) || "").slice(7).trim();
        const dataLine = (lines.find((l) => l.startsWith("data: ")) || "").slice(6).trim();
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine);
        if (eventType === "delta" && payload.text) {
          full += payload.text;
          stream.push(payload.text);
        } else if (eventType === "error") {
          throw new Error(payload.error || "Something went wrong.");
        }
      }
    }

    stream.finish();
    if (!full) {
      // Stream completed but the model returned no visible text — show the
      // fallback in the bubble immediately instead of leaving it blank
      // until the next reload.
      stream.el.querySelector(".stream-text").textContent = "I couldn't generate a response.";
    }
    chat.messages.push({ role: "assistant", content: full || "I couldn't generate a response." });
    saveChats();
  } catch (e) {
    if (!stream) {
      t.remove();
      appendMessageEl("assistant", `I couldn't connect right now. ${e.message}`);
    } else if (!full) {
      stream.finish();
      stream.el.querySelector(".stream-text").textContent = `I couldn't connect right now. ${e.message}`;
    } else {
      stream.finish();
    }
  } finally {
    scrollToBottom();
    send.disabled = false;
    input.focus();
  }
}

/* Demo mode has no backend, but streams the canned reply word-by-word
   through the same materialize renderer so the UX stays consistent. */
function streamDemoReply(text) {
  return new Promise((resolve) => {
    const t = typingEl();
    setTimeout(() => {
      t.remove();
      const stream = startStreamBubble();
      const words = text.split(" ");
      let i = 0;
      const tick = () => {
        if (i >= words.length) {
          stream.finish();
          resolve();
          return;
        }
        stream.push((i === 0 ? "" : " ") + words[i]);
        i++;
        setTimeout(tick, 35 + Math.random() * 40);
      };
      tick();
    }, 400);
  });
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
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

document.querySelectorAll(".suggestions button").forEach((b) =>
  b.addEventListener("click", () => sendMessage(b.textContent))
);

renderHistory();
renderMessages();
checkStatus();
