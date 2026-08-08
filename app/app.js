import { formatTimestamp, parseTimestamp, validateOffset } from "./timestamp.js";
import { RecordingRepository } from "./repository.js";
import { MicrophoneRecorder, SynchronizationController } from "./controllers.js";

const $ = (selector) => document.querySelector(selector);
const repository = new RecordingRepository();
const state = {
  file: null,
  objectUrl: null,
  duration: 0,
  audioContext: null,
  mediaSourceNode: null,
  microphone: null,
  synchronization: null,
  sessionActive: false,
  stopping: false,
  animationFrame: 0,
  sessionObjectUrls: [],
};

const elements = {
  fileInput: $("#audio-file"), filePicker: $("#file-picker"), sourceDetails: $("#source-details"),
  sourceName: $("#source-name"), sourceMeta: $("#source-meta"), audio: $("#source-audio"),
  changeFile: $("#change-file"), previewToggle: $("#preview-toggle"), seek: $("#seek"),
  currentTime: $("#current-time"), duration: $("#duration"), modeOptions: $("#mode-options"),
  timestampInput: $("#timestamp-input"), delayInput: $("#delay-input"), validation: $("#validation-message"),
  startButton: $("#start-session"), activeSession: $("#active-session"), activeSourceName: $("#active-source-name"),
  activeSourceTime: $("#active-source-time"), activeRecordingTime: $("#active-recording-time"),
  activeOffset: $("#active-offset"), activeProgressFill: $("#active-progress-fill"), sessionStatus: $("#session-status"),
  waitingMessage: $("#waiting-message"), pauseButton: $("#pause-session"), stopButton: $("#stop-session"),
  debugValues: $("#debug-values"), sessionsList: $("#sessions-list"), emptySessions: $("#empty-sessions"),
  sessionCount: $("#session-count"), storageEstimate: $("#storage-estimate"), toast: $("#toast"),
};

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  window.setTimeout(() => elements.toast.classList.remove("show"), 4200);
}

function bytesLabel(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function currentMode() { return document.querySelector('input[name="mode"]:checked').value; }

function configuredOffset() {
  const mode = currentMode();
  const sourceStart = elements.audio.currentTime;
  if (mode === "immediate") return validateOffset(sourceStart, state.duration);
  const raw = mode === "sourceTimestamp" ? elements.timestampInput.value : elements.delayInput.value;
  const configured = parseTimestamp(raw);
  const normalized = mode === "delay" ? sourceStart + configured : configured;
  if (mode === "sourceTimestamp" && normalized < sourceStart) throw new Error("The recording timestamp cannot be before the selected playback position.");
  return validateOffset(normalized, state.duration);
}

function validateConfiguration() {
  if (!state.file || !Number.isFinite(state.duration) || state.duration <= 0) {
    elements.startButton.disabled = true;
    return false;
  }
  try {
    configuredOffset();
    elements.validation.textContent = "";
    elements.startButton.disabled = state.sessionActive;
    return true;
  } catch (error) {
    elements.validation.textContent = error.message;
    elements.startButton.disabled = true;
    return false;
  }
}

function updateModeUI() {
  const mode = currentMode();
  document.querySelectorAll(".mode-card").forEach((card) => card.classList.toggle("selected", card.querySelector("input[type=radio]").checked));
  elements.timestampInput.disabled = state.sessionActive || mode !== "sourceTimestamp";
  elements.delayInput.disabled = state.sessionActive || mode !== "delay";
  validateConfiguration();
}

function setConfigurationLocked(locked) {
  elements.modeOptions.disabled = locked || !state.file;
  elements.fileInput.disabled = locked;
  elements.changeFile.disabled = locked;
  elements.seek.disabled = locked;
  elements.previewToggle.disabled = locked;
  updateModeUI();
}

function resetSelectedFile() {
  if (state.sessionActive) return;
  elements.audio.pause();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = null; state.objectUrl = null; state.duration = 0;
  elements.audio.removeAttribute("src");
  elements.audio.load();
  elements.fileInput.value = "";
  elements.filePicker.classList.remove("hidden");
  elements.sourceDetails.classList.add("hidden");
  elements.modeOptions.disabled = true;
  elements.startButton.disabled = true;
}

function selectFile(file) {
  if (!file || state.sessionActive) return;
  if (file.type && !file.type.startsWith("audio/")) {
    showToast("Choose an audio file that this browser can play.", true);
    return;
  }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = file;
  state.objectUrl = URL.createObjectURL(file);
  elements.audio.src = state.objectUrl;
  elements.sourceName.textContent = file.name;
  elements.sourceMeta.textContent = `${file.type || "Unknown audio type"} · ${bytesLabel(file.size)}`;
  elements.filePicker.classList.add("hidden");
  elements.sourceDetails.classList.remove("hidden");
  elements.audio.load();
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is not supported in this browser.");
    state.audioContext = new AudioContextClass();
    state.mediaSourceNode = state.audioContext.createMediaElementSource(elements.audio);
    state.mediaSourceNode.connect(state.audioContext.destination);
  }
  if (state.audioContext.state === "suspended") await state.audioContext.resume();
}

async function beginMicrophoneRecording() {
  if (!state.sessionActive || state.synchronization.recordingStarted) return;
  const sourceTime = elements.audio.currentTime;
  const clockTime = state.synchronization.markRecordingStarted(sourceTime);
  state.microphone.start(clockTime);
  elements.sessionStatus.textContent = "Recording";
  elements.waitingMessage.classList.add("hidden");
  elements.activeOffset.textContent = formatTimestamp(state.synchronization.recordingSourceOffsetSeconds);
}

function renderActiveSession() {
  if (!state.sessionActive) return;
  const sourceTime = elements.audio.currentTime;
  const sync = state.synchronization;
  if (!elements.audio.paused && sync.shouldStartRecording(sourceTime)) {
    try { beginMicrophoneRecording(); } catch (error) { handleRecorderFailure(error); }
  }
  const micElapsed = sync.recordingStarted ? state.microphone.elapsed(state.audioContext.currentTime) : 0;
  elements.activeSourceTime.textContent = `${formatTimestamp(sourceTime)} / ${formatTimestamp(state.duration)}`;
  elements.activeRecordingTime.textContent = formatTimestamp(micElapsed);
  elements.activeProgressFill.style.width = `${Math.min(100, (sourceTime / state.duration) * 100)}%`;
  elements.debugValues.innerHTML = [
    ["AudioContext.currentTime", state.audioContext.currentTime.toFixed(3)],
    ["Source currentTime", sourceTime.toFixed(3)],
    ["Configured offset", sync.configuredValueSeconds.toFixed(3)],
    ["Recording state", state.sessionActive ? (sync.recordingStarted ? "recording" : "waiting") : "idle"],
    ["MediaRecorder state", state.microphone.state],
    ["Selected MIME type", state.microphone.mimeType || "—"],
    ["Mic elapsed", micElapsed.toFixed(3)],
    ["Mapped source time", sync.sourceTimeForMicTime(micElapsed).toFixed(3)],
  ].map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
  state.animationFrame = requestAnimationFrame(renderActiveSession);
}

async function startSession() {
  if (state.sessionActive || !validateConfiguration()) return;
  elements.startButton.disabled = true;
  elements.startButton.querySelector("span").textContent = "Preparing microphone…";
  try {
    await ensureAudioContext();
    elements.audio.pause();
    const sourceStartPosition = elements.audio.currentTime;
    const mode = currentMode();
    const offset = configuredOffset();
    const configuredValue = mode === "immediate" ? 0 : parseTimestamp(mode === "sourceTimestamp" ? elements.timestampInput.value : elements.delayInput.value);
    state.microphone = new MicrophoneRecorder();
    await state.microphone.prepare();
    state.microphone.onUnexpectedStop = handleRecorderFailure;
    state.synchronization = new SynchronizationController(state.audioContext);
    state.synchronization.configure(mode, configuredValue, sourceStartPosition);
    state.sessionActive = true;
    setConfigurationLocked(true);
    elements.activeSession.classList.remove("hidden");
    elements.activeSourceName.textContent = state.file.name;
    elements.activeOffset.textContent = formatTimestamp(offset);
    elements.activeRecordingTime.textContent = "00:00";
    elements.sessionStatus.textContent = offset === 0 ? "Starting" : "Waiting to record";
    elements.waitingMessage.classList.toggle("hidden", offset === 0);
    elements.waitingMessage.querySelector("strong").textContent = formatTimestamp(offset);
    elements.pauseButton.textContent = "Pause";
    await elements.audio.play();
    if (mode === "immediate") await beginMicrophoneRecording();
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(renderActiveSession);
    elements.activeSession.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    state.microphone?.release();
    state.sessionActive = false;
    setConfigurationLocked(false);
    elements.activeSession.classList.add("hidden");
    const message = error?.name === "NotAllowedError"
      ? "Microphone access was denied. Allow microphone access in Safari settings and try again."
      : `Could not start the session: ${error.message || error}`;
    showToast(message, true);
  } finally {
    elements.startButton.querySelector("span").textContent = "Start session";
    validateConfiguration();
  }
}

async function pauseOrResume() {
  if (!state.sessionActive || state.stopping) return;
  try {
    if (elements.audio.paused) {
      await state.audioContext.resume();
      await elements.audio.play();
      if (state.synchronization.recordingStarted) state.microphone.resume(state.audioContext.currentTime);
      elements.pauseButton.textContent = "Pause";
      elements.sessionStatus.textContent = state.synchronization.recordingStarted ? "Recording" : "Waiting to record";
    } else {
      elements.audio.pause();
      if (state.synchronization.recordingStarted) state.microphone.pause(state.audioContext.currentTime);
      elements.pauseButton.textContent = "Resume";
      elements.sessionStatus.textContent = "Paused";
    }
  } catch (error) { showToast(`Could not change playback: ${error.message}`, true); }
}

async function stopSession(reason = "manual") {
  if (!state.sessionActive || state.stopping) return;
  state.stopping = true;
  cancelAnimationFrame(state.animationFrame);
  elements.audio.pause();
  elements.stopButton.disabled = true;
  elements.pauseButton.disabled = true;
  elements.sessionStatus.textContent = "Saving";
  try {
    const hadRecording = state.synchronization.recordingStarted;
    const result = await state.microphone.stop(state.audioContext.currentTime);
    if (hadRecording && result?.blob.size) {
      const session = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: new Date().toISOString(),
        source: { filename: state.file.name, mimeType: state.file.type, sizeBytes: state.file.size, durationSeconds: state.duration },
        recording: { blob: result.blob, mimeType: result.mimeType, sizeBytes: result.blob.size, durationSeconds: result.durationSeconds },
        synchronization: {
          recordingSourceOffsetSeconds: state.synchronization.recordingSourceOffsetSeconds,
          mode: state.synchronization.mode,
          configuredValueSeconds: state.synchronization.configuredValueSeconds,
        },
      };
      try {
        await repository.saveSession(session);
        showToast(reason === "ended" ? "Playback ended. Recording saved on this device." : "Recording saved on this device.");
      } catch (error) {
        const quota = error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "");
        showToast(quota ? "This device does not have enough browser storage to save the recording. Export other sessions and delete them, then try again." : `The recording could not be saved: ${error.message}`, true);
      }
    } else {
      showToast("Session stopped before the recording start point, so nothing was saved.");
    }
  } catch (error) {
    showToast(`The recording could not be finalized: ${error.message}`, true);
  } finally {
    state.microphone?.release();
    state.sessionActive = false;
    state.stopping = false;
    state.microphone = null;
    state.synchronization = null;
    elements.activeSession.classList.add("hidden");
    elements.stopButton.disabled = false;
    elements.pauseButton.disabled = false;
    elements.audio.currentTime = 0;
    setConfigurationLocked(false);
    await loadSessions();
  }
}

function handleRecorderFailure(error) {
  if (!state.sessionActive || state.stopping) return;
  showToast(error?.message || "The microphone recording was interrupted.", true);
  stopSession("error");
}

function extensionForMimeType(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  return "audio";
}

function safeFilename(name) { return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "innercast"; }

function clearSessionObjectUrls() {
  state.sessionObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.sessionObjectUrls = [];
}

async function loadSessions() {
  try {
    const sessions = await repository.listSessions();
    clearSessionObjectUrls();
    elements.sessionCount.textContent = String(sessions.length);
    elements.emptySessions.classList.toggle("hidden", sessions.length > 0);
    elements.sessionsList.innerHTML = "";
    for (const session of sessions) {
      const url = URL.createObjectURL(session.recording.blob);
      state.sessionObjectUrls.push(url);
      const article = document.createElement("article");
      article.className = "session-card";
      article.innerHTML = `
        <div class="session-card-head"><h2></h2><time></time></div>
        <div class="session-facts">
          <div><span>Duration</span><strong>${formatTimestamp(session.recording.durationSeconds)}</strong></div>
          <div><span>Starts at</span><strong>${formatTimestamp(session.synchronization.recordingSourceOffsetSeconds)}</strong></div>
          <div><span>Size</span><strong>${bytesLabel(session.recording.sizeBytes)}</strong></div>
          <div><span>Format</span><strong>${session.recording.mimeType || "Unknown"}</strong></div>
        </div>
        <audio controls preload="metadata" src="${url}"></audio>
        <div class="session-buttons"><a href="${url}">Export</a><button class="delete-button">Delete</button></div>`;
      article.querySelector("h2").textContent = session.source.filename;
      article.querySelector("time").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.createdAt));
      const download = article.querySelector("a");
      download.download = `${safeFilename(session.source.filename)}-innercast-${session.createdAt.slice(0, 10)}.${extensionForMimeType(session.recording.mimeType)}`;
      article.querySelector(".delete-button").addEventListener("click", async () => {
        if (!window.confirm(`Delete the recording for “${session.source.filename}”? This cannot be undone.`)) return;
        try { await repository.deleteSession(session.id); await loadSessions(); showToast("Recording deleted from this device."); }
        catch (error) { showToast(`Could not delete the recording: ${error.message}`, true); }
      });
      elements.sessionsList.append(article);
    }
  } catch (error) {
    showToast(`Could not read saved sessions: ${error.message}`, true);
  }
  updateStorageEstimate();
}

async function updateStorageEstimate() {
  if (!navigator.storage?.estimate) {
    elements.storageEstimate.textContent = "Storage estimates are not available in this browser.";
    return;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const free = Math.max(0, (quota || 0) - (usage || 0));
    elements.storageEstimate.textContent = `Browser storage: ${bytesLabel(usage || 0)} used · ${bytesLabel(free)} approximately available · ${bytesLabel(quota || 0)} quota`;
  } catch { elements.storageEstimate.textContent = "Storage estimate is currently unavailable."; }
}

function switchView(view) {
  if (state.sessionActive && view !== "recorder") { showToast("Stop the active session before leaving the recorder.", true); return; }
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`));
  document.querySelectorAll(".nav-link").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  if (view === "sessions") loadSessions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

elements.fileInput.addEventListener("change", () => selectFile(elements.fileInput.files?.[0]));
elements.changeFile.addEventListener("click", () => resetSelectedFile());
elements.audio.addEventListener("loadedmetadata", () => {
  state.duration = elements.audio.duration;
  elements.seek.max = String(state.duration);
  elements.duration.textContent = formatTimestamp(state.duration);
  elements.currentTime.textContent = "00:00";
  elements.modeOptions.disabled = false;
  validateConfiguration();
});
elements.audio.addEventListener("error", () => { showToast("Safari could not read this audio file. Try another format.", true); resetSelectedFile(); });
elements.audio.addEventListener("timeupdate", () => {
  if (!state.sessionActive) {
    elements.seek.value = String(elements.audio.currentTime);
    elements.currentTime.textContent = formatTimestamp(elements.audio.currentTime);
  }
});
elements.audio.addEventListener("play", () => {
  if (!state.sessionActive) elements.previewToggle.textContent = "Ⅱ";
  else if (state.synchronization?.recordingStarted && state.microphone?.state === "paused") {
    state.microphone.resume(state.audioContext.currentTime);
    elements.pauseButton.textContent = "Pause";
    elements.sessionStatus.textContent = "Recording";
  }
});
elements.audio.addEventListener("pause", () => {
  if (!state.sessionActive) elements.previewToggle.textContent = "▶";
  else if (!state.stopping && state.synchronization?.recordingStarted && state.microphone?.state === "recording") {
    state.microphone.pause(state.audioContext.currentTime);
    elements.pauseButton.textContent = "Resume";
    elements.sessionStatus.textContent = "Paused";
  }
});
elements.audio.addEventListener("ended", () => { if (state.sessionActive) stopSession("ended"); });
elements.previewToggle.addEventListener("click", async () => {
  try { if (elements.audio.paused) { await ensureAudioContext(); await elements.audio.play(); } else elements.audio.pause(); }
  catch (error) { showToast(`Playback could not start: ${error.message}`, true); }
});
elements.seek.addEventListener("input", () => {
  if (!state.sessionActive) {
    elements.audio.currentTime = Number(elements.seek.value);
    elements.currentTime.textContent = formatTimestamp(elements.audio.currentTime);
    validateConfiguration();
  }
});
document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener("change", updateModeUI));
elements.timestampInput.addEventListener("input", validateConfiguration);
elements.delayInput.addEventListener("input", validateConfiguration);
elements.startButton.addEventListener("click", startSession);
elements.pauseButton.addEventListener("click", pauseOrResume);
elements.stopButton.addEventListener("click", () => stopSession("manual"));
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.sessionActive) showToast("Keep Innercast open and your phone unlocked. iOS may interrupt playback or recording in the background.", true);
});
window.addEventListener("pagehide", () => { if (state.sessionActive) state.microphone?.release(); clearSessionObjectUrls(); });

loadSessions();
