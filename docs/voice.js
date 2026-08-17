// Voice conversation feature: tap the mic button, talk, get spoken replies,
// interrupt whenever you want. This is a separate module (only loaded on
// pages that include <script type="module" src="./voice.js">) so the
// mic/audio machinery never runs unless someone actually opens voice mode.
//
// Architecture (see README section added by this change for the long
// version):
//   - STT: the recorded utterance is sent to POST /api/voice/transcribe,
//     a new backend route that forwards it to Groq's hosted Whisper Large
//     v3 Turbo — the same GROQ_API_KEY already used for chat, so no new
//     credential and no key ever reaches the browser.
//   - Reasoning: the transcript is handed to sendMessage() from app.js —
//     the exact same function the text composer uses. Same history, same
//     project context, same system prompt/model. Voice never talks to a
//     "simpler" pipeline.
//   - TTS: Groq's hosted TTS (PlayAI/Orpheus) only covers English and
//     Arabic today — no Spanish — which doesn't fit an app whose users
//     regularly speak Spanish. Rather than silently ship English-only
//     voice output, this uses the browser's native SpeechSynthesis API:
//     it covers far more languages (including Spanish), has zero added
//     network latency (nothing to wait on before audio starts), and needs
//     no API key at all. Sentences are spoken as soon as they finish
//     streaming in, so the reply starts being read out loud well before
//     the model has finished generating it.
//   - Barge-in: the mic stays live (via a Web Audio analyser) the entire
//     time the assistant is thinking or speaking. If it detects the user
//     talking, it immediately cancels playback (and aborts the in-flight
//     reply if one is still streaming) and starts listening again.

import { API_BASE, sendMessage, isBackendConfigured } from "./app.js";

const voiceBtn = document.getElementById("voiceBtn"),
  voiceOverlay = document.getElementById("voiceOverlay"),
  voiceClose = document.getElementById("voiceClose"),
  voiceOrb = document.getElementById("voiceOrb"),
  voiceBars = document.getElementById("voiceBars"),
  voiceStatus = document.getElementById("voiceStatus"),
  voiceCaption = document.getElementById("voiceCaption"),
  voiceMuteBtn = document.getElementById("voiceMuteBtn"),
  voiceEndBtn = document.getElementById("voiceEndBtn");

const barEls = voiceBars ? Array.from(voiceBars.children) : [];

const voiceSupported =
  Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  typeof MediaRecorder !== "undefined" &&
  "speechSynthesis" in window;

if (voiceBtn) {
  if (!voiceSupported) {
    voiceBtn.disabled = true;
    voiceBtn.classList.add("unavailable");
    voiceBtn.title = "Voice conversation isn't supported in this browser.";
  } else if (!isBackendConfigured()) {
    voiceBtn.disabled = true;
    voiceBtn.classList.add("unavailable");
    voiceBtn.title = "Connect a backend (see README) to use voice.";
  }
}

// Tuning knobs for the voice-activity detection (VAD). Levels are RMS of
// the time-domain signal, roughly 0–1.
const SILENCE_MS = 900; // how long to wait after speech stops before sending the utterance
const MAX_UTTERANCE_MS = 30000; // hard cap so a stuck-open mic can't record forever
const SPEECH_LEVEL_THRESHOLD = 0.035; // above this = "the user is talking" while listening
const BARGE_IN_LEVEL_THRESHOLD = 0.05; // above this = "the user wants to interrupt" while AI is talking/thinking
const BARGE_IN_SUSTAIN_MS = 180; // must stay above threshold this long (filters out brief noise/clicks)

const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];
function pickMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  return CANDIDATE_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

let sessionActive = false;
let state = "idle"; // idle | activating | listening | processing | thinking | speaking | error | denied
let micStream = null;
let audioCtx = null;
let analyser = null;
let dataArray = null;
let rafId = null;

let mediaRecorder = null;
let recordedChunks = [];
let hasDetectedSpeechInUtterance = false;
let silenceTimer = null;
let maxUtteranceTimer = null;
let sustainedAboveSince = null;

let mutedByUser = false;
let currentAbortController = null;
let ttsBuffer = "";
let assistantCaption = "";
let speakingUtteranceCount = 0;
let cachedVoices = [];

/* ---------- state / UI ---------- */
function setState(next, statusMessage) {
  state = next;
  if (voiceOverlay) {
    voiceOverlay.classList.remove(
      "state-activating",
      "state-listening",
      "state-processing",
      "state-thinking",
      "state-speaking",
      "state-error",
      "state-denied"
    );
    voiceOverlay.classList.add(`state-${next}`);
  }
  if (voiceStatus) voiceStatus.textContent = statusMessage || "";
  if (next === "listening") {
    assistantCaption = "";
    setCaption("");
  }
}

function setCaption(text) {
  if (voiceCaption) voiceCaption.textContent = text || "";
}

function updateBars(level) {
  if (!barEls.length) return;
  const active = state !== "idle" && state !== "activating";
  const boosted = Math.min(1, level * 6);
  const now = Date.now();
  barEls.forEach((el, i) => {
    const jitter = 0.75 + 0.25 * Math.sin(now / 130 + i * 0.9);
    const scale = active ? Math.max(0.12, boosted * jitter) : 0.2;
    el.style.setProperty("--bar-scale", scale.toFixed(2));
  });
}

/* ---------- mic / audio graph ---------- */
function getRms() {
  analyser.getByteTimeDomainData(dataArray);
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / dataArray.length);
}

function setupAudioGraph() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  dataArray = new Uint8Array(analyser.fftSize);
  monitorLoop();
}

function monitorLoop() {
  if (!sessionActive) return;
  const level = mutedByUser ? 0 : getRms();
  updateBars(level);

  if (state === "listening") {
    if (level > SPEECH_LEVEL_THRESHOLD) {
      hasDetectedSpeechInUtterance = true;
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (state === "listening" && hasDetectedSpeechInUtterance) finishListening();
      }, SILENCE_MS);
    }
  } else if (state === "thinking" || state === "speaking") {
    // Barge-in: the mic keeps listening the whole time the assistant is
    // generating or speaking, so the user can cut in without pressing
    // anything.
    if (!mutedByUser && level > BARGE_IN_LEVEL_THRESHOLD) {
      if (sustainedAboveSince == null) sustainedAboveSince = performance.now();
      else if (performance.now() - sustainedAboveSince > BARGE_IN_SUSTAIN_MS) {
        sustainedAboveSince = null;
        interrupt();
      }
    } else {
      sustainedAboveSince = null;
    }
  }

  rafId = requestAnimationFrame(monitorLoop);
}

/* ---------- listening / recording an utterance ---------- */
function beginListening() {
  if (!sessionActive) return;
  hasDetectedSpeechInUtterance = false;
  clearTimeout(silenceTimer);
  clearTimeout(maxUtteranceTimer);
  recordedChunks = [];

  const mimeType = pickMimeType();
  try {
    mediaRecorder = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
  } catch (err) {
    console.error("Voice: couldn't start MediaRecorder:", err);
    setState("error", "The microphone couldn't be started. Tap to try again.");
    return;
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = handleUtteranceRecorded;
  mediaRecorder.start();

  setState("listening", "Listening…");
  maxUtteranceTimer = setTimeout(() => {
    if (state === "listening") finishListening();
  }, MAX_UTTERANCE_MS);
}

function finishListening() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  clearTimeout(silenceTimer);
  clearTimeout(maxUtteranceTimer);
  setState("processing", "Processing…");
  mediaRecorder.stop();
}

async function handleUtteranceRecorded() {
  if (!sessionActive) return;
  const blob = new Blob(recordedChunks, { type: (mediaRecorder && mediaRecorder.mimeType) || "audio/webm" });
  recordedChunks = [];

  if (!blob.size || !hasDetectedSpeechInUtterance) {
    // Silence-only (e.g. the tail end after the real speech already got
    // caught) — nothing to send, just keep listening.
    beginListening();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/voice/transcribe`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) {
      let msg = "Couldn't transcribe the audio.";
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(msg);
    }
    const { text } = await res.json();
    if (!text || !text.trim()) {
      // Whisper heard only noise/silence — resume listening instead of
      // sending an empty message.
      beginListening();
      return;
    }
    submitTranscript(text.trim());
  } catch (err) {
    console.error("Voice transcription failed:", err);
    setState("error", "Couldn't understand that. Tap to try again.");
  }
}

/* ---------- talking to the AI (reuses sendMessage from app.js) ---------- */
function submitTranscript(text) {
  setCaption(`You: “${text}”`);
  setState("thinking", "Thinking…");
  ttsBuffer = "";
  assistantCaption = "";
  currentAbortController = new AbortController();

  sendMessage(text, {
    voice: true,
    signal: currentAbortController.signal,
    onDelta: handleAssistantDelta,
    onDone: handleAssistantDone,
    onError: handleAssistantError,
    onAborted: handleAssistantAborted,
  });
}

function handleAssistantDelta(chunk) {
  if (!sessionActive) return;
  if (state === "thinking") setState("speaking", "Speaking…");
  ttsBuffer += chunk;
  assistantCaption += chunk;
  setCaption(assistantCaption);
  flushSpeakableSentences(false);
}

function handleAssistantDone() {
  currentAbortController = null;
  flushSpeakableSentences(true);
  maybeResumeAfterSpeech();
}

function handleAssistantError(err) {
  currentAbortController = null;
  console.error("Voice: assistant reply failed:", err);
  setState("error", "Something went wrong generating the reply. Tap to try again.");
}

function handleAssistantAborted() {
  // interrupt() already cancelled speech and moved us back to listening —
  // just clear the controller reference.
  currentAbortController = null;
}

// Splits the buffered streamed text on sentence boundaries and queues each
// complete sentence for speech as soon as it's ready, instead of waiting
// for the whole reply — this is what makes the reply start being spoken
// while the model is still generating the rest of it.
function flushSpeakableSentences(final) {
  const matcher = /[^.!?…\n]+[.!?…]+(?:\s|$)|[^.!?…\n]+\n+/g;
  let match;
  let lastIndex = 0;
  while ((match = matcher.exec(ttsBuffer))) {
    speakSentence(match[0].trim());
    lastIndex = matcher.lastIndex;
  }
  ttsBuffer = ttsBuffer.slice(lastIndex);
  if (final && ttsBuffer.trim()) {
    speakSentence(ttsBuffer.trim());
    ttsBuffer = "";
  }
}

/* ---------- text-to-speech ---------- */
function loadVoicesWhenReady() {
  const populate = () => {
    cachedVoices = speechSynthesis.getVoices();
  };
  populate();
  if (!cachedVoices.length) speechSynthesis.onvoiceschanged = populate;
}

function replyLangHint() {
  return (navigator.language || "en").split("-")[0].toLowerCase();
}

function pickVoiceFor(langCode) {
  if (!cachedVoices.length) cachedVoices = speechSynthesis.getVoices();
  const inLang = cachedVoices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(langCode));
  const premium = inLang.find((v) => /google|natural|neural|premium/i.test(v.name));
  return premium || inLang[0] || cachedVoices.find((v) => v.default) || cachedVoices[0] || null;
}

function speakSentence(text) {
  if (!text || !sessionActive) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoiceFor(replyLangHint());
  if (voice) utterance.voice = voice;
  utterance.rate = 1.02;
  utterance.pitch = 1;
  speakingUtteranceCount++;
  const settle = () => {
    speakingUtteranceCount = Math.max(0, speakingUtteranceCount - 1);
    maybeResumeAfterSpeech();
  };
  utterance.onend = settle;
  utterance.onerror = settle;
  speechSynthesis.speak(utterance);
}

// Only go back to listening once the reply has fully finished generating
// AND every queued sentence has finished playing — otherwise we'd start
// recording the mic over the tail end of the AI's own voice.
function maybeResumeAfterSpeech() {
  if (!sessionActive) return;
  if (currentAbortController) return; // still generating
  if (speechSynthesis.speaking || speechSynthesis.pending || speakingUtteranceCount > 0) return;
  if (state === "speaking" || state === "thinking") beginListening();
}

/* ---------- barge-in ---------- */
function interrupt() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  speechSynthesis.cancel();
  speakingUtteranceCount = 0;
  ttsBuffer = "";
  assistantCaption = "";
  beginListening();
}

/* ---------- permissions / errors ---------- */
function handleMicError(err) {
  console.error("Voice: microphone error:", err);
  if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError" || err.name === "SecurityError") {
    setState("denied", "Microphone access was denied. Allow it in your browser settings, then tap to retry.");
  } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
    setState("error", "No microphone was found on this device.");
  } else if (err.name === "NotReadableError") {
    setState("error", "The microphone is being used by another app.");
  } else {
    setState("error", "Couldn't access the microphone. Tap to try again.");
  }
}

/* ---------- open / close ---------- */
async function openVoiceMode() {
  if (!voiceOverlay || sessionActive) return;
  voiceOverlay.hidden = false;
  document.body.classList.add("voice-locked");
  sessionActive = true;
  mutedByUser = false;
  voiceMuteBtn?.classList.remove("muted");
  setState("activating", "Activating microphone…");

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    handleMicError(err);
    return;
  }

  setupAudioGraph();
  loadVoicesWhenReady();
  beginListening();
}

function closeVoiceMode() {
  sessionActive = false;
  cancelAnimationFrame(rafId);
  clearTimeout(silenceTimer);
  clearTimeout(maxUtteranceTimer);
  speechSynthesis.cancel();
  speakingUtteranceCount = 0;
  ttsBuffer = "";
  assistantCaption = "";

  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (voiceOverlay) voiceOverlay.hidden = true;
  document.body.classList.remove("voice-locked");
  setState("idle", "");
}

function toggleMute() {
  mutedByUser = !mutedByUser;
  if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = !mutedByUser));
  voiceMuteBtn?.classList.toggle("muted", mutedByUser);
}

/* ---------- wiring ---------- */
voiceBtn?.addEventListener("click", () => {
  if (!voiceBtn.disabled) openVoiceMode();
});
voiceClose?.addEventListener("click", closeVoiceMode);
voiceEndBtn?.addEventListener("click", closeVoiceMode);
voiceMuteBtn?.addEventListener("click", toggleMute);
voiceOrb?.addEventListener("click", () => {
  if (state === "error") beginListening();
  else if (state === "denied") {
    closeVoiceMode();
    openVoiceMode();
  }
});
window.addEventListener("beforeunload", () => {
  if (sessionActive) closeVoiceMode();
});
