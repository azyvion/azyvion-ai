import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  serverTimestamp,
  query,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const API_BASE = (window.AZYVION_CONFIG && window.AZYVION_CONFIG.API_BASE_URL) || "";
const STORAGE_KEY = "azyvion_ai_chats_v1";
const FIREBASE_CONFIG = window.AZYVION_CONFIG?.FIREBASE || {};
const FIREBASE_ENABLED = Boolean(FIREBASE_CONFIG.apiKey && !String(FIREBASE_CONFIG.apiKey).startsWith("PASTE_"));

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
  suggestions = document.getElementById("suggestions"),
  welcomeGreeting = document.getElementById("welcomeGreeting"),
  authOverlay = document.getElementById("authOverlay"),
  googleSignInBtn = document.getElementById("googleSignIn"),
  authNote = document.getElementById("authNote"),
  accountAvatar = document.getElementById("accountAvatar"),
  accountName = document.getElementById("accountName"),
  accountEmail = document.getElementById("accountEmail"),
  accountMenu = document.getElementById("accountMenu"),
  accountPopover = document.getElementById("accountPopover"),
  signOutBtn = document.getElementById("signOutBtn");

const MAX_IMAGES = 5; // Groq's qwen3.6-27b vision model accepts up to 5 images per request
let pendingImages = []; // [{ dataUrl, name }] queued for the next message

let demoMode = false;
let firebaseApp = null;
let auth = null;
let db = null;
let currentUser = null;
let cloudSyncReady = false;
let authReady = false;
let authRequired = FIREBASE_ENABLED;
let chats = loadChats();
let activeId;
activeId = chats.length ? chats[0].id : createChat();

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
  queueCloudSync();
}

function createChat(projectId = null) {
  const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  chats.unshift({ id, title: "New chat", messages: [], projectId: projectId || null });
  saveChats();
  return id;
}

function getActiveChat() {
  return chats.find((c) => c.id === activeId);
}

/* ---------- authentication + cloud sync ---------- */
function firebaseIsConfigured() {
  return FIREBASE_ENABLED;
}

function showAuth(show, note = "Sign in with Google to sync your Azyvion AI conversations.") {
  if (!authOverlay) return;
  authOverlay.hidden = !show;
  document.body.classList.toggle("auth-locked", show);
  if (authNote) authNote.textContent = note;
}

function setAccount(user) {
  if (!user) {
    accountName.textContent = firebaseIsConfigured() ? "Signed out" : "Local mode";
    accountEmail.textContent = firebaseIsConfigured() ? "Sign in to sync" : "Firebase not configured";
    accountAvatar.textContent = "A";
    accountAvatar.style.backgroundImage = "";
    updateWelcomeGreeting(null);
    return;
  }
  accountName.textContent = user.displayName || "Azyvion user";
  accountEmail.textContent = user.email || "Google account";
  if (user.photoURL) {
    accountAvatar.textContent = "";
    accountAvatar.style.backgroundImage = `url(${JSON.stringify(user.photoURL)})`;
  } else {
    accountAvatar.style.backgroundImage = "";
    accountAvatar.textContent = (user.displayName || "A").trim().charAt(0).toUpperCase() || "A";
  }
  updateWelcomeGreeting(user);
}

function updateWelcomeGreeting(user) {
  if (!welcomeGreeting) return;
  if (!user) {
    welcomeGreeting.innerHTML = 'Welcome to <em>Azyvion AI</em>';
    return;
  }
  const firstName = (user.displayName || "").trim().split(/\s+/)[0];
  const hasHistory = chats.some((c) => (c.messages || []).length > 0);
  if (firstName && hasHistory) welcomeGreeting.innerHTML = `<em>${firstName}</em> is back!`;
  else if (firstName) welcomeGreeting.innerHTML = `Welcome, <em>${firstName}</em>!`;
  else welcomeGreeting.innerHTML = 'Welcome to <em>Azyvion AI</em>';
}

function cleanForCloud(content) {
  if (typeof content === "string") return content.slice(0, 120000);
  if (!Array.isArray(content)) return "";
  const text = content.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
  const imageCount = content.filter((p) => p && p.type === "image_url").length;
  return imageCount ? `${text}${text ? "\n\n" : ""}[${imageCount} image${imageCount > 1 ? "s" : ""} attached]` : text;
}

function cloudChat(chat) {
  return {
    title: (chat.title || "New chat").slice(0, 120),
    messages: (chat.messages || []).slice(-100).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: cleanForCloud(m.content),
    })),
    updatedAt: serverTimestamp(),
  };
}

let cloudSyncTimer = null;
const cloudSyncQueue = new Set();
function queueCloudSync(chatId = activeId) {
  if (!cloudSyncReady || !currentUser || !chatId) return;
  cloudSyncQueue.add(chatId);
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(flushCloudSync, 500);
}

async function flushCloudSync() {
  if (!cloudSyncReady || !currentUser || !db) return;
  const ids = [...cloudSyncQueue];
  cloudSyncQueue.clear();
  for (const id of ids) {
    const chat = chats.find((c) => c.id === id);
    if (!chat) continue;
    try {
      await setDoc(doc(db, "users", currentUser.uid, "chats", id), cloudChat(chat), { merge: true });
    } catch (err) {
      console.warn("Cloud sync failed", err);
    }
  }
}

async function deleteCloudChat(id) {
  if (!cloudSyncReady || !currentUser || !db) return;
  try {
    await deleteDoc(doc(db, "users", currentUser.uid, "chats", id));
  } catch (err) {
    console.warn("Cloud delete failed", err);
  }
}

async function loadCloudChats() {
  if (!cloudSyncReady || !currentUser || !db) return;
  try {
    const snap = await getDocs(query(collection(db, "users", currentUser.uid, "chats")));
    const cloud = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      cloud.push({
        id: d.id,
        title: data.title || "New chat",
        messages: Array.isArray(data.messages) ? data.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: typeof m.content === "string" ? m.content : "",
        })) : [],
      });
    });
    const byId = new Map(chats.map((c) => [c.id, c]));
    for (const c of cloud) byId.set(c.id, c);
    chats = [...byId.values()].sort((a, b) => (b.id || "").localeCompare(a.id || ""));
    if (!chats.length) activeId = createChat();
    else if (!chats.some((c) => c.id === activeId)) activeId = chats[0].id;
    saveChats();
    renderHistory();
    renderProjects();
    renderMessages();
  } catch (err) {
    console.warn("Cloud history unavailable", err);
  }
}

async function signInGoogle() {
  if (!auth) {
    showAuth(true, "Add your Firebase web configuration in docs/config.js first.");
    return;
  }
  googleSignInBtn.disabled = true;
  googleSignInBtn.classList.add("loading");
  authNote.textContent = "Opening Google sign-in…";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isMobile) await signInWithRedirect(auth, provider);
    else await signInWithPopup(auth, provider);
  } catch (err) {
    console.error(err);
    authNote.textContent = friendlyAuthError(err);
    googleSignInBtn.disabled = false;
    googleSignInBtn.classList.remove("loading");
  }
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("popup-closed-by-user")) return "Google sign-in was closed. Try again when you're ready.";
  if (code.includes("unauthorized-domain")) return "This domain is not authorized in Firebase. Add your GitHub Pages domain under Authentication → Settings → Authorized domains.";
  if (code.includes("operation-not-allowed")) return "Google sign-in is not enabled in your Firebase project yet.";
  return "Google sign-in failed. Check the Firebase setup and try again.";
}

async function initializeAuth() {
  if (!firebaseIsConfigured()) {
    authRequired = false;
    authReady = true;
    setAccount(null);
    return;
  }
  try {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
    await getRedirectResult(auth).catch((err) => console.warn("Redirect sign-in", err));
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      authReady = true;
      if (user) {
        cloudSyncReady = true;
        setAccount(user);
        showAuth(false);
        await loadCloudChats();
        updateWelcomeGreeting(user);
        setStatus("ready", "Signed in");
      } else {
        cloudSyncReady = false;
        setAccount(null);
        showAuth(true);
        setStatus("ready", "Sign in required");
      }
    });
  } catch (err) {
    console.error("Firebase initialization failed", err);
    authRequired = false;
    authReady = true;
    setAccount(null);
    authNote.textContent = "Firebase could not initialize. Local mode is still available.";
  }
}

googleSignInBtn?.addEventListener("click", signInGoogle);
accountMenu?.addEventListener("click", () => {
  accountPopover.hidden = !accountPopover.hidden;
});
signOutBtn?.addEventListener("click", async () => {
  accountPopover.hidden = true;
  if (auth) await firebaseSignOut(auth).catch(console.warn);
});
document.addEventListener("click", (event) => {
  if (!accountPopover.hidden && !accountPopover.contains(event.target) && event.target !== accountMenu) accountPopover.hidden = true;
});
initializeAuth();

/* ---------- sidebar rendering ---------- */
function renderHistory() {
  historyEl.innerHTML = "";
  const list = chats.filter((c) => !c.projectId);
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No conversations yet.";
    historyEl.appendChild(empty);
    return;
  }
  list.forEach((c) => {
    const item = document.createElement("div");
    item.className = `h-item${c.id === activeId ? " active" : ""}`;
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-current", c.id === activeId ? "true" : "false");
    const label = document.createElement("span");
    label.textContent = c.title || "New chat";
    const del = document.createElement("button");
    del.type = "button";
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
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        switchChat(c.id);
      }
    });
    historyEl.appendChild(item);
  });
}

function switchChat(id) {
  activeId = id;
  renderHistory();
  renderProjects();
  renderMessages();
  closeSidebarOnMobile();
}

function deleteChat(id) {
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return;
  chats.splice(idx, 1);
  saveChats();
  deleteCloudChat(id);
  if (activeId === id) {
    activeId = chats.length ? chats[0].id : createChat();
  }
  renderHistory();
  renderProjects();
  renderMessages();
}

newChatBtn.addEventListener("click", () => {
  activeId = createChat();
  renderHistory();
  renderProjects();
  renderMessages();
  closeSidebarOnMobile();
  input.focus();
});

/* ---------- mobile sidebar ---------- */
function openSidebar() {
  appEl.classList.add("sidebar-open");
  menuToggle.setAttribute("aria-expanded", "true");
}
function closeSidebar() {
  appEl.classList.remove("sidebar-open");
  menuToggle.setAttribute("aria-expanded", "false");
}
function closeSidebarOnMobile() {
  if (window.innerWidth <= 860) closeSidebar();
}
menuToggle.addEventListener("click", () => {
  appEl.classList.contains("sidebar-open") ? closeSidebar() : openSidebar();
});
scrim.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && appEl.classList.contains("sidebar-open")) closeSidebar();
});

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

/* ---------- lightweight markdown renderer ----------
   No CDN dependency (keeps this a zero-network-risk static file): a small,
   self-escaping parser covering what model replies actually use — fenced
   code blocks, inline code, bold/italic, links, lists, headings, quotes.
   Everything is escaped before any tag is added, so this is safe against
   HTML/script injection from model output. */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

function markdownToHtml(raw) {
  const text = (raw || "").replace(/\r\n/g, "\n");
  const blocks = [];
  const codeFence = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0,
    m;
  while ((m = codeFence.exec(text))) {
    if (m.index > last) blocks.push({ type: "text", content: text.slice(last, m.index) });
    blocks.push({ type: "code", lang: m[1], content: m[2].replace(/\n$/, "") });
    last = codeFence.lastIndex;
  }
  if (last < text.length) blocks.push({ type: "text", content: text.slice(last) });

  return blocks
    .map((b) => {
      if (b.type === "code") {
        const lang = (b.lang || "text").toLowerCase();
        const showArtifact = ARTIFACT_LANGS.has(lang) || b.content.split("\n").length > 8;
        const artifactBtn = showArtifact
          ? '<button type="button" class="open-artifact" aria-label="Open in panel">Open</button>'
          : "";
        return `<div class="code-block" data-lang="${escapeHtml(lang)}"><div class="code-bar"><span>${escapeHtml(lang)}</span><div class="code-bar-actions">${artifactBtn}<button type="button" class="copy-code" aria-label="Copy code">Copy</button></div></div><pre><code>${escapeHtml(b.content)}</code></pre></div>`;
      }
      return renderTextBlock(b.content);
    })
    .join("");
}

function renderTextBlock(text) {
  const lines = text.split("\n");
  const html = [];
  let list = null; // { type: 'ul' | 'ol', items: [] }
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${para.map(inlineMarkdown).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.type}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join("")}</${list.type}>`);
      list = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);

    if (!line) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length + 3; // h4-h6: stays subordinate to the UI's own headings
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (ul) {
      flushPara();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(ul[1]);
    } else if (ol) {
      flushPara();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ol[1]);
    } else if (quote) {
      flushPara();
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html.join("");
}

const ARTIFACT_LANGS = new Set([
  "html", "svg", "xml", "css", "javascript", "js", "jsx", "tsx", "typescript",
  "ts", "python", "py", "json", "markdown", "md", "react",
]);

function attachCodeCopyHandlers(root) {
  root.querySelectorAll(".copy-code").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.closest(".code-block").querySelector("code").textContent;
      navigator.clipboard.writeText(code).then(() => {
        const original = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1600);
      });
    });
  });
  root.querySelectorAll(".open-artifact").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".code-block");
      const lang = block.dataset.lang || "text";
      const code = block.querySelector("code").textContent;
      openArtifact(lang, code);
    });
  });
}

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
  const bodyHtml = role === "assistant" ? markdownToHtml(text) : `<p>${escapeHtml(text)}</p>`;
  const actionsHtml =
    role === "assistant" && text
      ? '<div class="msg-actions"><button type="button" class="copy-msg" aria-label="Copy message">Copy</button></div>'
      : "";
  w.innerHTML = `<div class="avatar">${role === "assistant" ? "A" : "YOU"}</div><div class="bubble"><span class="label">${role === "assistant" ? "AZYVION AI" : "YOU"}</span>${imagesHtml}<div class="content">${bodyHtml}</div>${actionsHtml}</div>`;
  attachCodeCopyHandlers(w);
  const copyMsgBtn = w.querySelector(".copy-msg");
  if (copyMsgBtn) {
    copyMsgBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        copyMsgBtn.textContent = "Copied";
        setTimeout(() => (copyMsgBtn.textContent = "Copy"), 1600);
      });
    });
  }
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
      const text = p.textContent;
      if (text) {
        p.outerHTML = `<div class="content">${markdownToHtml(text)}</div><div class="msg-actions"><button type="button" class="copy-msg" aria-label="Copy message">Copy</button></div>`;
        attachCodeCopyHandlers(w);
        const copyMsgBtn = w.querySelector(".copy-msg");
        copyMsgBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(text).then(() => {
            copyMsgBtn.textContent = "Copied";
            setTimeout(() => (copyMsgBtn.textContent = "Copy"), 1600);
          });
        });
      }
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

/* ---------- status ----------
   Render's free tier spins the backend down after inactivity, so the very
   first check on page load can legitimately fail while it wakes up (can
   take 30-50s). We used to lock into demo mode forever after one failed
   check — now we retry with backoff and keep re-checking in the
   background, so the moment the backend comes online the UI (and real
   sending) recovers automatically instead of staying stuck on the canned
   demo reply. */
let statusRetryTimer = null;

function setStatus(status, text) {
  statusText.textContent = text;
  statusWrap.classList.remove("ready", "error");
  if (status === "ready" || status === "error") statusWrap.classList.add(status);
}

async function checkStatus(isRetry = false) {
  if (!API_BASE && window.location.protocol !== "http:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    enterDemoMode("No backend configured for this deployment.", true);
    return;
  }

  if (!isRetry) {
    statusText.textContent = "Checking system";
    statusWrap.classList.remove("ready", "error");
  }

  try {
    const r = await fetch(`${API_BASE}/api/status`);
    const d = await r.json();
    clearTimeout(statusRetryTimer);
    if (d.configured) {
      demoMode = false;
      statusText.textContent = "System online";
      statusWrap.classList.remove("error");
      statusWrap.classList.add("ready");
    } else {
      statusText.textContent = "API key required";
      statusWrap.classList.remove("ready");
      statusWrap.classList.add("error");
    }
  } catch {
    enterDemoMode("Couldn't reach the Azyvion AI backend (it may be waking up).", false);
    // Keep retrying in the background — covers Render cold starts and
    // transient network blips — instead of giving up permanently.
    clearTimeout(statusRetryTimer);
    statusRetryTimer = setTimeout(() => checkStatus(true), 6000);
  }
}

function enterDemoMode(reason, permanent) {
  demoMode = true;
  statusText.textContent = permanent ? "Demo mode — backend not connected" : "Reconnecting…";
  statusWrap.classList.remove("ready");
  statusWrap.classList.add("error");
  console.info(`Azyvion AI: ${reason} Set API_BASE_URL in config.js to connect a live backend.`);
}

// A Render free-tier backend that's asleep can reject or drop the very
// first request while it spins up. One silent retry after a short pause
// turns that into "worked, just a bit slower" instead of a visible error.
async function fetchChatWithRetry(messages, context, attempt = 0) {
  try {
    return await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context }),
    });
  } catch (e) {
    if (attempt === 0) {
      await new Promise((res) => setTimeout(res, 2500));
      return fetchChatWithRetry(messages, context, attempt + 1);
    }
    throw e;
  }
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

  // demoMode is only a hint from the last background status check — it can
  // be stale (e.g. the Render backend just finished waking up). Rather than
  // trusting it blindly, only fall back to the canned reply if there's
  // truly no backend configured for this deployment at all. Everything
  // else gets a real attempt against /api/chat, so a backend that woke up
  // since page load still works without a manual refresh.
  const noBackendConfigured =
    !API_BASE &&
    window.location.protocol !== "http:" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";

  if (noBackendConfigured) {
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
    const r = await fetchChatWithRetry(chat.messages, buildContext(chat));
    if (!r.ok) {
      let msg = "Request failed";
      try {
        msg = (await r.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }

    demoMode = false;
    statusText.textContent = "System online";
    statusWrap.classList.remove("error");
    statusWrap.classList.add("ready");

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
        let payload;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          // A stray/partial chunk (network blip, proxy buffering during a
          // Render cold start) shouldn't kill the whole in-progress reply —
          // skip just this one event and keep streaming.
          continue;
        }
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
  if (e.key !== "Enter") return;
  if (settings.advanced.enterToSend) {
    if (!e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  } else if (e.ctrlKey || e.metaKey) {
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

/* =========================================================================
   Settings — Diseño (personalización visual) + Avanzado
   ========================================================================= */
const SETTINGS_KEY = "azyvion_ai_settings_v1";
const DESIGN_DEFAULTS = { blue: "#176eb1", cyan: "#00a9d9", bg: "#02080f", font: "DM Sans", radius: "default", density: "comfortable" };
const ADVANCED_DEFAULTS = { customInstructions: "", enterToSend: true };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      design: { ...DESIGN_DEFAULTS, ...(parsed.design || {}) },
      advanced: { ...ADVANCED_DEFAULTS, ...(parsed.advanced || {}) },
    };
  } catch {
    return { design: { ...DESIGN_DEFAULTS }, advanced: { ...ADVANCED_DEFAULTS } };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — settings still apply for this session */
  }
}

let settings = loadSettings();

function applyDesign() {
  const d = settings.design;
  const root = document.documentElement;
  root.style.setProperty("--blue", d.blue);
  root.style.setProperty("--cyan", d.cyan);
  root.style.setProperty("--bg", d.bg);
  root.style.setProperty("--font-ui", `"${d.font}",sans-serif`);
  document.body.dataset.radius = d.radius;
  document.body.dataset.density = d.density;
}
applyDesign();

function buildContext(chat) {
  const parts = [];
  if (settings.advanced.customInstructions && settings.advanced.customInstructions.trim()) {
    parts.push(`User custom instructions:\n${settings.advanced.customInstructions.trim()}`);
  }
  if (chat && chat.projectId) {
    const pc = projectContextFor(chat.projectId);
    if (pc) parts.push(pc);
  }
  return parts.join("\n\n").slice(0, 4000);
}

const settingsOverlay = document.getElementById("settingsOverlay");
const settingsBtn = document.getElementById("settingsBtn");

function refreshSettingsForm() {
  document.getElementById("designBlue").value = settings.design.blue;
  document.getElementById("designCyan").value = settings.design.cyan;
  document.getElementById("designBg").value = settings.design.bg;
  document.getElementById("designFont").value = settings.design.font;
  document.getElementById("designRadius").value = settings.design.radius;
  document.getElementById("designDensity").value = settings.design.density;
  document.getElementById("customInstructions").value = settings.advanced.customInstructions;
  document.getElementById("enterToSend").checked = settings.advanced.enterToSend;
}

settingsBtn?.addEventListener("click", () => {
  refreshSettingsForm();
  settingsOverlay.hidden = false;
});
document.getElementById("settingsClose")?.addEventListener("click", () => {
  settingsOverlay.hidden = true;
});
settingsOverlay?.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab").forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".settings-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    document.querySelector(`.settings-pane[data-pane="${tab.dataset.tab}"]`)?.classList.add("active");
  });
});

document.getElementById("designBlue")?.addEventListener("input", (e) => {
  settings.design.blue = e.target.value;
  applyDesign();
  saveSettings();
});
document.getElementById("designCyan")?.addEventListener("input", (e) => {
  settings.design.cyan = e.target.value;
  applyDesign();
  saveSettings();
});
document.getElementById("designBg")?.addEventListener("input", (e) => {
  settings.design.bg = e.target.value;
  applyDesign();
  saveSettings();
});
document.getElementById("designFont")?.addEventListener("change", (e) => {
  settings.design.font = e.target.value;
  applyDesign();
  saveSettings();
});
document.getElementById("designRadius")?.addEventListener("change", (e) => {
  settings.design.radius = e.target.value;
  applyDesign();
  saveSettings();
});
document.getElementById("designDensity")?.addEventListener("change", (e) => {
  settings.design.density = e.target.value;
  applyDesign();
  saveSettings();
});
document.getElementById("designReset")?.addEventListener("click", () => {
  settings.design = { ...DESIGN_DEFAULTS };
  applyDesign();
  saveSettings();
  refreshSettingsForm();
});

document.getElementById("customInstructions")?.addEventListener("input", (e) => {
  settings.advanced.customInstructions = e.target.value;
  saveSettings();
});
document.getElementById("enterToSend")?.addEventListener("change", (e) => {
  settings.advanced.enterToSend = e.target.checked;
  saveSettings();
});

document.getElementById("exportDataBtn")?.addEventListener("click", () => {
  const data = { chats, projects, settings, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `azyvion-ai-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importDataBtn")?.addEventListener("click", () => {
  document.getElementById("importFileInput").click();
});
document.getElementById("importFileInput")?.addEventListener("change", async () => {
  const fileInputEl = document.getElementById("importFileInput");
  const file = fileInputEl.files?.[0];
  fileInputEl.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (Array.isArray(data.chats)) {
      chats = data.chats;
      saveChats();
    }
    if (Array.isArray(data.projects)) {
      projects = data.projects;
      saveProjects();
    }
    if (data.settings) {
      settings = {
        design: { ...DESIGN_DEFAULTS, ...(data.settings.design || {}) },
        advanced: { ...ADVANCED_DEFAULTS, ...(data.settings.advanced || {}) },
      };
      applyDesign();
      saveSettings();
    }
    activeId = chats.length ? chats[0].id : createChat();
    renderHistory();
    renderProjects();
    renderMessages();
    refreshSettingsForm();
    alert("Datos importados correctamente.");
  } catch (err) {
    alert("No se pudo importar ese archivo: " + err.message);
  }
});

document.getElementById("clearDataBtn")?.addEventListener("click", () => {
  if (!confirm("Esto borrará permanentemente todos los chats, proyectos y ajustes guardados en este dispositivo. ¿Continuar?")) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROJECTS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* storage unavailable */
  }
  chats = [];
  projects = [];
  settings = loadSettings();
  applyDesign();
  activeId = createChat();
  renderHistory();
  renderProjects();
  renderMessages();
  refreshSettingsForm();
});

/* =========================================================================
   Proyectos — carpeta + instrucciones/contexto propio + archivos adjuntos
   ========================================================================= */
const PROJECTS_KEY = "azyvion_ai_projects_v1";

function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveProjects() {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    /* storage unavailable — projects still work for this session */
  }
}

let projects = loadProjects();

function projectContextFor(projectId) {
  const p = projects.find((x) => x.id === projectId);
  if (!p) return "";
  const parts = [];
  if (p.instructions && p.instructions.trim()) {
    parts.push(`Project instructions for "${p.name}":\n${p.instructions.trim()}`);
  }
  if (p.files && p.files.length) {
    const filesText = p.files.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n");
    parts.push(`Project files:\n${filesText}`);
  }
  return parts.join("\n\n");
}

const projectsListEl = document.getElementById("projectsList");

function renderProjects() {
  if (!projectsListEl) return;
  projectsListEl.innerHTML = "";
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No projects yet.";
    projectsListEl.appendChild(empty);
    return;
  }
  projects.forEach((p) => {
    const item = document.createElement("div");
    item.className = "project-item";

    const row = document.createElement("div");
    row.className = "project-row";
    row.innerHTML = `
      <button type="button" class="proj-toggle" aria-label="Toggle project">${p.expanded ? "▾" : "▸"}</button>
      <span class="proj-name">${escapeHtml(p.name || "Untitled project")}</span>
      <button type="button" class="proj-add" aria-label="New chat in project" title="New chat">+</button>
      <button type="button" class="proj-edit" aria-label="Edit project" title="Edit">⚙</button>
    `;
    row.querySelector(".proj-toggle").addEventListener("click", () => {
      p.expanded = !p.expanded;
      saveProjects();
      renderProjects();
    });
    row.querySelector(".proj-name").addEventListener("click", () => openProjectModal(p.id));
    row.querySelector(".proj-edit").addEventListener("click", () => openProjectModal(p.id));
    row.querySelector(".proj-add").addEventListener("click", () => {
      activeId = createChat(p.id);
      p.expanded = true;
      saveProjects();
      renderHistory();
      renderProjects();
      renderMessages();
      closeSidebarOnMobile();
      input.focus();
    });
    item.appendChild(row);

    if (p.expanded) {
      const projChats = chats.filter((c) => c.projectId === p.id);
      const chatsWrap = document.createElement("div");
      chatsWrap.className = "project-chats";
      if (!projChats.length) {
        const e = document.createElement("div");
        e.className = "history-empty";
        e.style.padding = "4px 10px";
        e.textContent = "No chats yet.";
        chatsWrap.appendChild(e);
      }
      projChats.forEach((c) => {
        const ci = document.createElement("div");
        ci.className = `h-item${c.id === activeId ? " active" : ""}`;
        ci.setAttribute("role", "button");
        ci.tabIndex = 0;
        const label = document.createElement("span");
        label.textContent = c.title || "New chat";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "del";
        del.setAttribute("aria-label", "Delete chat");
        del.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1.5 1.5L10.5 10.5M10.5 1.5L1.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteChat(c.id);
        });
        ci.appendChild(label);
        ci.appendChild(del);
        ci.addEventListener("click", () => switchChat(c.id));
        ci.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            switchChat(c.id);
          }
        });
        chatsWrap.appendChild(ci);
      });
      item.appendChild(chatsWrap);
    }
    projectsListEl.appendChild(item);
  });
}

let editingProjectId = null;
let pendingProjectFiles = [];
const projectOverlay = document.getElementById("projectOverlay");

function openProjectModal(id) {
  editingProjectId = id || null;
  const p = id ? projects.find((x) => x.id === id) : null;
  document.getElementById("projectModalTitle").textContent = p ? "Edit project" : "New project";
  document.getElementById("projectName").value = p ? p.name : "";
  document.getElementById("projectInstructions").value = p ? p.instructions || "" : "";
  pendingProjectFiles = p ? [...(p.files || [])] : [];
  renderProjectFilesList();
  document.getElementById("projectDeleteBtn").hidden = !p;
  projectOverlay.hidden = false;
}
function closeProjectModal() {
  projectOverlay.hidden = true;
  editingProjectId = null;
}

function renderProjectFilesList() {
  const wrap = document.getElementById("projectFilesList");
  wrap.innerHTML = "";
  pendingProjectFiles.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "project-file-row";
    row.innerHTML = `<span>${escapeHtml(f.name)}</span><button type="button" class="rm-file" aria-label="Remove file">✕</button>`;
    row.querySelector(".rm-file").addEventListener("click", () => {
      pendingProjectFiles.splice(i, 1);
      renderProjectFilesList();
    });
    wrap.appendChild(row);
  });
}

document.getElementById("newProjectBtn")?.addEventListener("click", () => openProjectModal(null));
document.getElementById("projectModalClose")?.addEventListener("click", closeProjectModal);
projectOverlay?.addEventListener("click", (e) => {
  if (e.target === projectOverlay) closeProjectModal();
});

document.getElementById("projectFileBtn")?.addEventListener("click", () => {
  document.getElementById("projectFileInput").click();
});
document.getElementById("projectFileInput")?.addEventListener("change", async () => {
  const el = document.getElementById("projectFileInput");
  const files = Array.from(el.files || []);
  el.value = "";
  for (const file of files) {
    if (pendingProjectFiles.length >= 10) break;
    try {
      const text = await file.text();
      pendingProjectFiles.push({ name: file.name, content: text.slice(0, 20000) });
    } catch {
      /* skip files that can't be read as text */
    }
  }
  renderProjectFilesList();
});

document.getElementById("projectSaveBtn")?.addEventListener("click", () => {
  const name = document.getElementById("projectName").value.trim() || "Untitled project";
  const instructions = document.getElementById("projectInstructions").value;
  if (editingProjectId) {
    const p = projects.find((x) => x.id === editingProjectId);
    if (p) {
      p.name = name;
      p.instructions = instructions;
      p.files = [...pendingProjectFiles];
    }
  } else {
    const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    projects.unshift({ id, name, instructions, files: [...pendingProjectFiles], expanded: true });
  }
  saveProjects();
  closeProjectModal();
  renderProjects();
});

document.getElementById("projectDeleteBtn")?.addEventListener("click", () => {
  if (!editingProjectId) return;
  if (!confirm("Delete this project? Its chats will move to Recientes.")) return;
  projects = projects.filter((p) => p.id !== editingProjectId);
  chats.forEach((c) => {
    if (c.projectId === editingProjectId) c.projectId = null;
  });
  saveProjects();
  saveChats();
  closeProjectModal();
  renderProjects();
  renderHistory();
});

/* =========================================================================
   Artefactos — panel lateral para código/HTML/SVG generado por el modelo
   ========================================================================= */
const artifactPanel = document.getElementById("artifactPanel");
const artifactCodeEl = document.getElementById("artifactCode");
const artifactFrameEl = document.getElementById("artifactFrame");
const artifactTitleEl = document.getElementById("artifactTitle");
const artifactPreviewToggle = document.getElementById("artifactPreviewToggle");
const PREVIEWABLE_ARTIFACTS = new Set(["html", "svg", "xml"]);
const ARTIFACT_EXT = {
  html: "html", svg: "svg", xml: "xml", css: "css", javascript: "js", js: "js",
  jsx: "jsx", tsx: "tsx", typescript: "ts", ts: "ts", python: "py", py: "py",
  json: "json", markdown: "md", md: "md", react: "jsx",
};
let currentArtifact = null;
let artifactPreviewMode = false;

function openArtifact(lang, code) {
  currentArtifact = { lang, code };
  artifactTitleEl.textContent = `Artifact · ${lang}`;
  artifactCodeEl.querySelector("code").textContent = code;
  const canPreview = PREVIEWABLE_ARTIFACTS.has(lang);
  artifactPreviewToggle.hidden = !canPreview;
  artifactPreviewMode = canPreview;
  renderArtifactView();
  artifactPanel.hidden = false;
}

function renderArtifactView() {
  if (artifactPreviewMode && currentArtifact && PREVIEWABLE_ARTIFACTS.has(currentArtifact.lang)) {
    artifactCodeEl.hidden = true;
    artifactFrameEl.hidden = false;
    const html =
      currentArtifact.lang === "svg" || currentArtifact.lang === "xml"
        ? `<!doctype html><html><body style="margin:0">${currentArtifact.code}</body></html>`
        : currentArtifact.code;
    artifactFrameEl.srcdoc = html;
    artifactPreviewToggle.textContent = "View code";
  } else {
    artifactCodeEl.hidden = false;
    artifactFrameEl.hidden = true;
    artifactPreviewToggle.textContent = "Preview";
  }
}

artifactPreviewToggle?.addEventListener("click", () => {
  artifactPreviewMode = !artifactPreviewMode;
  renderArtifactView();
});
document.getElementById("artifactCloseBtn")?.addEventListener("click", () => {
  artifactPanel.hidden = true;
});
document.getElementById("artifactCopyBtn")?.addEventListener("click", (e) => {
  if (!currentArtifact) return;
  navigator.clipboard.writeText(currentArtifact.code).then(() => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = original), 1600);
  });
});
document.getElementById("artifactDownloadBtn")?.addEventListener("click", () => {
  if (!currentArtifact) return;
  const ext = ARTIFACT_EXT[currentArtifact.lang] || "txt";
  const blob = new Blob([currentArtifact.code], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `artifact.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
});

renderHistory();
renderProjects();
renderMessages();
checkStatus();

/* =========================================================================
   PWA — instalación + actualización forzada
   ========================================================================= */

const APP_VERSION = (window.AZYVION_CONFIG && window.AZYVION_CONFIG.APP_VERSION) || "0";
const appVersionEl = document.getElementById("appVersion");
if (appVersionEl) appVersionEl.textContent = `v${APP_VERSION}`;

let swRegistration = null;
let reloadingForUpdate = false;

function isStandaloneApp() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true // iOS
  );
}

// Recarga forzada, en el mismo espíritu de un Ctrl+Shift+R: se dispara sola
// cuando detecta una versión nueva, sin pedirle nada al usuario.
function forceReload() {
  if (reloadingForUpdate) return;
  reloadingForUpdate = true;
  showUpdateToast();
  setTimeout(() => window.location.reload(), 700);
}

function showUpdateToast() {
  if (document.getElementById("updateToast")) return;
  const t = document.createElement("div");
  t.id = "updateToast";
  t.className = "update-toast";
  t.textContent = "Actualizando Azyvion AI a la nueva versión…";
  document.body.appendChild(t);
}

// Compara version.json (siempre pedido a la red, nunca a caché) contra la
// versión con la que se cargó esta pestaña. Es el respaldo que garantiza la
// actualización incluso si, por lo que sea, el service worker no llega a
// activarse a tiempo (primera visita, navegador sin soporte, etc).
async function checkForNewVersion() {
  try {
    const r = await fetch(`./version.json?_=${Date.now()}`, { cache: "no-store" });
    const d = await r.json();
    if (d.version && d.version !== APP_VERSION) forceReload();
  } catch {
    /* sin conexión o bloqueado — se reintenta en el siguiente chequeo */
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // updateViaCache: "none" evita que el navegador sirva un sw.js viejo
    // desde su propia caché HTTP — siempre pide el archivo real a la red.
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => {
        swRegistration = reg;
        reg.update().catch(() => {});
      })
      .catch(() => {});
  });

  // Se dispara cuando un service worker nuevo toma el control de la
  // página: es la señal de "ya hay versión nueva activa", y se recarga sola.
  navigator.serviceWorker.addEventListener("controllerchange", forceReload);

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SW_ACTIVATED" && event.data.version !== APP_VERSION) {
      forceReload();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (swRegistration) swRegistration.update().catch(() => {});
    checkForNewVersion();
  });

  // Revisión periódica mientras la app queda abierta en segundo plano.
  setInterval(() => {
    if (swRegistration) swRegistration.update().catch(() => {});
    checkForNewVersion();
  }, 5 * 60 * 1000);
}

checkForNewVersion();

/* ---------- banner de instalación ("agregar a inicio") ---------- */

let deferredInstallPrompt = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

function installDismissedThisSession() {
  try {
    return sessionStorage.getItem("azyvion_install_dismissed") === "1";
  } catch {
    return false;
  }
}
function markInstallDismissed() {
  try {
    sessionStorage.setItem("azyvion_install_dismissed", "1");
  } catch {
    /* sessionStorage no disponible — el banner podría repetirse, no es grave */
  }
}

function showInstallBanner(platform) {
  if (isStandaloneApp() || installDismissedThisSession()) return;
  if (document.getElementById("installBanner")) return;

  const banner = document.createElement("div");
  banner.id = "installBanner";
  banner.className = "install-banner";

  if (platform === "ios") {
    banner.innerHTML =
      '<div class="install-banner-text">' +
      "<strong>Instala Azyvion AI</strong>" +
      '<span>Toca <b>Compartir</b> y luego <b>“Agregar a inicio”</b>.</span>' +
      "</div>" +
      '<button type="button" class="install-close" aria-label="Cerrar">✕</button>';
  } else {
    banner.innerHTML =
      '<div class="install-banner-text">' +
      "<strong>Instala Azyvion AI</strong>" +
      "<span>Ábrela como app, más rápido, desde tu pantalla de inicio.</span>" +
      "</div>" +
      '<div class="install-banner-actions">' +
      '<button type="button" class="install-btn">Instalar</button>' +
      '<button type="button" class="install-close" aria-label="Cerrar">✕</button>' +
      "</div>";
  }

  document.body.appendChild(banner);

  banner.querySelector(".install-close").addEventListener("click", () => {
    banner.remove();
    markInstallDismissed();
  });

  const installBtn = banner.querySelector(".install-btn");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      banner.remove();
      markInstallDismissed();
    });
  }
}

// Android / Chrome / Edge: el navegador ofrece el evento de instalación.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner("android");
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  markInstallDismissed();
  const b = document.getElementById("installBanner");
  if (b) b.remove();
});

// iOS Safari no dispara beforeinstallprompt — se muestran instrucciones manuales.
if (isIOS && !isStandaloneApp()) {
  showInstallBanner("ios");
}
