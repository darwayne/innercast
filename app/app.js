import { formatTimestamp, parseTimestamp, validateOffset } from "./timestamp.js";
import { RecordingRepository } from "./repository.js";
import { MicrophoneRecorder, SynchronizationController } from "./controllers.js";
import { isLikelyAudioFile } from "./file-types.js";
import { OnDeviceWhisperTranscriber, WHISPER_MODELS } from "./whisper-transcriber.js?v=10";

const $ = (selector) => document.querySelector(selector);
const repository = new RecordingRepository();
const state = {
  file: null,
  objectUrl: null,
  duration: 0,
  audioContext: null,
  microphone: null,
  synchronization: null,
  sessionActive: false,
  stopping: false,
  animationFrame: 0,
  sessionObjectUrls: [],
  persistSourceOnMetadata: false,
  sourceFromStorage: false,
  transcriptionJob: null,
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

function setBrowserAudioSession(type) {
  // Safari exposes the Audio Session API on current iOS releases. Explicitly
  // selecting playback prevents IndexedDB Blob players from remaining silent
  // until another native media element happens to initialize the output route.
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) {
      navigator.audioSession.type = type;
    }
  } catch { /* Other browsers manage their audio route automatically. */ }
}

function preparePlaybackOutput() {
  setBrowserAudioSession("playback");
  // Resume during the user's touch gesture when possible. The HTMLAudioElement
  // remains the actual output path; this only unlocks Safari's audio machinery.
  ensureAudioContext().catch(() => {});
}

async function registerOfflineSupport() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    if (!hadController) showToast("Innercast is ready for offline use.");
  } catch (error) {
    // Recording and storage remain usable even if Safari declines service
    // worker registration (for example, in private browsing mode).
    console.warn("Offline support could not be installed.", error);
  }
}

function bytesLabel(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
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
  state.persistSourceOnMetadata = false;
  state.sourceFromStorage = false;
  elements.audio.removeAttribute("src");
  elements.audio.load();
  elements.fileInput.value = "";
  elements.filePicker.classList.remove("hidden");
  elements.sourceDetails.classList.add("hidden");
  elements.modeOptions.disabled = true;
  elements.startButton.disabled = true;
}

function selectFile(file, persistOnLoad = true) {
  if (!file || state.sessionActive) return;
  if (!isLikelyAudioFile(file)) {
    showToast("Choose an AAC, M4A, MP3, FLAC, WAV, AIFF, CAF, or another browser-supported audio file.", true);
    return;
  }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = file;
  state.persistSourceOnMetadata = persistOnLoad;
  state.sourceFromStorage = !persistOnLoad;
  state.objectUrl = URL.createObjectURL(file);
  elements.audio.src = state.objectUrl;
  elements.sourceName.textContent = file.name;
  elements.sourceMeta.textContent = `${file.type || "Unknown audio type"} · ${bytesLabel(file.size)}`;
  elements.filePicker.classList.add("hidden");
  elements.sourceDetails.classList.remove("hidden");
  elements.audio.load();
}

async function restoreLastSelectedSource() {
  if (state.file) return;
  try {
    const saved = await repository.getLastSelectedSource();
    if (!saved?.blob?.size || state.file) return;
    const file = new File([saved.blob], saved.filename, {
      type: saved.mimeType || saved.blob.type || "application/octet-stream",
      lastModified: new Date(saved.selectedAt).getTime(),
    });
    selectFile(file, false);
    elements.sourceMeta.textContent = `${file.type || "Unknown audio type"} · ${bytesLabel(file.size)} · Saved on this device`;
  } catch (error) {
    showToast(`The last source file could not be restored: ${error.message}`, true);
  }
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is not supported in this browser.");
    state.audioContext = new AudioContextClass();
  }
  if (state.audioContext.state === "suspended") await state.audioContext.resume();
}

async function unlockNativePlayback() {
  // Invoke play synchronously from the Start button gesture, before awaiting
  // microphone permission. iOS may otherwise consume the gesture while its
  // permission sheet is open and refuse or silently suppress later playback.
  const requestedPosition = elements.audio.currentTime;
  const wasMuted = elements.audio.muted;
  elements.audio.muted = true;
  try {
    await elements.audio.play();
    elements.audio.pause();
    elements.audio.currentTime = requestedPosition;
  } finally {
    elements.audio.muted = wasMuted;
  }
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
    ["Source playback", elements.audio.paused ? "paused" : "playing"],
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
  if (state.transcriptionJob) {
    showToast("Finish or cancel the on-device transcription before starting a recording.", true);
    return;
  }
  elements.startButton.disabled = true;
  elements.startButton.querySelector("span").textContent = "Preparing microphone…";
  setBrowserAudioSession("playback");
  try {
    const playbackUnlock = unlockNativePlayback();
    await ensureAudioContext();
    await playbackUnlock;
    elements.audio.pause();
    const sourceStartPosition = elements.audio.currentTime;
    const mode = currentMode();
    const offset = configuredOffset();
    const configuredValue = mode === "immediate" ? 0 : parseTimestamp(mode === "sourceTimestamp" ? elements.timestampInput.value : elements.delayInput.value);
    state.microphone = new MicrophoneRecorder();
    setBrowserAudioSession("play-and-record");
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
    if (elements.audio.paused) throw new Error("Safari did not start source playback. Tap Start session again and confirm that audio is routed to your headphones.");
    if (mode === "immediate") await beginMicrophoneRecording();
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(renderActiveSession);
    elements.activeSession.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    setBrowserAudioSession("playback");
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
        showToast(reason === "ended"
          ? "Playback ended. Recording saved on this device."
          : reason === "error" ? "Recording was interrupted; available audio was saved." : "Recording saved on this device.");
      } catch (error) {
        const quota = error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "");
        showToast(quota ? "This device does not have enough browser storage to save the recording. Export other sessions and delete them, then try again." : `The recording could not be saved: ${error.message}`, true);
      }
    } else if (!hadRecording) {
      showToast("Session stopped before the recording start point, so nothing was saved.");
    } else {
      showToast("Recording started but Safari did not provide any audio data to save.", true);
    }
  } catch (error) {
    showToast(`The recording could not be finalized: ${error.message}`, true);
  } finally {
    state.microphone?.release();
    setBrowserAudioSession("playback");
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

function renderSavedTranscript(article, session) {
  if (!article) return;
  article.querySelector(".transcript-fact")?.remove();
  article.querySelector(".saved-transcript")?.remove();
  if (!session.transcription) return;

  const wordCount = session.transcription.text?.trim()
    ? session.transcription.text.trim().split(/\s+/).length : 0;
  const fact = document.createElement("div");
  fact.className = "transcript-fact";
  fact.innerHTML = `<span>Transcript</span><strong>${wordCount ? `${wordCount} words` : "No speech"}</strong>`;
  article.querySelector(".session-facts").append(fact);

  const details = document.createElement("details");
  details.className = "saved-transcript";
  const summary = document.createElement("summary");
  const modelChoice = WHISPER_MODELS[session.transcription.model];
  const modelLabel = modelChoice
    ? ` · ${modelChoice.label.split(" —")[0]}`
    : session.transcription.model ? ` · ${session.transcription.model}` : "";
  summary.textContent = `Transcript · ${session.transcription.language || "Unknown language"}${modelLabel}`;
  const transcript = document.createElement("p");
  transcript.textContent = session.transcription.text || session.transcription.errorMessage || "No speech was recognized.";
  details.append(summary, transcript);
  article.querySelector("audio").after(details);
}

async function transcribeSavedSession(session, panel) {
  const select = panel.querySelector("select");
  const button = panel.querySelector("button");
  const progress = panel.querySelector("progress");
  const status = panel.querySelector("small");

  if (state.transcriptionJob) {
    if (state.transcriptionJob.sessionId === session.id) {
      state.transcriptionJob.transcriber.cancel();
    } else {
      showToast("Finish or cancel the current transcription first.", true);
    }
    return;
  }

  const transcriber = new OnDeviceWhisperTranscriber();
  state.transcriptionJob = { sessionId: session.id, transcriber };
  select.disabled = true;
  button.textContent = "Cancel";
  button.classList.add("cancel-transcription");
  status.textContent = "Preparing saved recording… Keep this page open.";
  let savedTranscription = null;
  try {
    // Fetch a new structured clone of the Blob for every attempt. WebKit can
    // invalidate an older IndexedDB Blob handle after the same record is
    // rewritten to save its previous transcript. Reusing the session-card
    // object then makes decodeAudioData fail with "The object can not be found
    // here" when the user switches models and transcribes again.
    const storedSession = await repository.getSession(session.id);
    if (!storedSession?.recording?.blob?.size) {
      throw new Error("The saved recording could not be reopened from this device.");
    }
    const transcription = await transcriber.transcribe(
      storedSession.recording.blob,
      select.value,
      session.synchronization.recordingSourceOffsetSeconds,
      (update) => {
        status.textContent = update.message || "Transcribing on this device…";
        progress.classList.toggle("hidden", !Number.isFinite(update.progress));
        if (Number.isFinite(update.progress)) progress.value = Math.max(0, Math.min(1, update.progress));
      },
    );
    await repository.updateSessionTranscription(session.id, transcription);
    session.transcription = transcription;
    savedTranscription = transcription;
    showToast("On-device transcript saved with this recording.");
  } catch (error) {
    const cancelled = /cancelled/i.test(error?.message || "");
    showToast(cancelled ? "Transcription cancelled. The recording is unchanged." : `Transcription failed: ${error.message}`, !cancelled);
  } finally {
    if (state.transcriptionJob?.sessionId === session.id) state.transcriptionJob = null;
    setBrowserAudioSession("playback");
    select.disabled = false;
    button.classList.remove("cancel-transcription");
    button.textContent = savedTranscription || session.transcription ? "Transcribe again" : "Transcribe";
    progress.classList.add("hidden");
    status.textContent = "First use downloads the selected model. Audio remains on this device.";
    if (savedTranscription) {
      if (panel.isConnected) renderSavedTranscript(panel.closest(".session-card"), session);
      else if (viewFromRoute() === "sessions") await loadSessions();
    }
    updateStorageEstimate();
  }
}

function createTranscriptionPanel(session) {
  const panel = document.createElement("section");
  panel.className = "transcription-panel";
  panel.innerHTML = `
    <div><strong>On-device transcription</strong><span>Runs after recording so it cannot interrupt microphone capture.</span></div>
    <div class="transcription-controls"><select aria-label="Transcription model"></select><button type="button"></button></div>
    <progress class="hidden" max="1" value="0"></progress>
    <small>First use downloads the selected model. Audio remains on this device.</small>`;
  const select = panel.querySelector("select");
  for (const [key, model] of Object.entries(WHISPER_MODELS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = `${model.label} (${model.approximateSize})`;
    if (session.transcription?.model === key) option.selected = true;
    select.append(option);
  }
  const button = panel.querySelector("button");
  button.textContent = session.transcription ? "Transcribe again" : "Transcribe";
  button.addEventListener("click", () => transcribeSavedSession(session, panel));
  return panel;
}

async function loadSessions() {
  try {
    const sessions = await repository.listSessions();
    // Detach media elements before revoking their Blob URLs. Revoking a URL
    // while Mobile Safari still has it attached can poison the replacement
    // player with a MEDIA_ERR_SRC_NOT_SUPPORTED state.
    elements.sessionsList.querySelectorAll("audio").forEach((audio) => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    });
    elements.sessionsList.innerHTML = "";
    clearSessionObjectUrls();
    elements.sessionCount.textContent = String(sessions.length);
    elements.emptySessions.classList.toggle("hidden", sessions.length > 0);
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
      const recordingAudio = article.querySelector("audio");
      recordingAudio.addEventListener("pointerdown", preparePlaybackOutput, { passive: true });
      recordingAudio.addEventListener("touchstart", preparePlaybackOutput, { passive: true });
      recordingAudio.addEventListener("play", () => setBrowserAudioSession("playback"));
      renderSavedTranscript(article, session);
      const transcriptionPanel = createTranscriptionPanel(session);
      article.querySelector(".session-buttons").before(transcriptionPanel);
      article.querySelector(".delete-button").addEventListener("click", async () => {
        if (state.transcriptionJob?.sessionId === session.id) {
          showToast("Cancel this transcription before deleting its recording.", true);
          return;
        }
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

function routeForView(view) { return `#/${view}`; }

function viewFromRoute() { return window.location.hash === "#/sessions" ? "sessions" : "recorder"; }

function switchView(view, updateRoute = true) {
  view = view === "sessions" ? "sessions" : "recorder";
  if (state.sessionActive && view !== "recorder") {
    window.history.replaceState(null, "", routeForView("recorder"));
    showToast("Stop the active session before leaving the recorder.", true);
    return;
  }
  if (updateRoute && window.location.hash !== routeForView(view)) {
    window.location.hash = routeForView(view);
    return;
  }
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`));
  document.querySelectorAll(".nav-link").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  document.title = view === "sessions" ? "Sessions — Innercast" : "Innercast — Play the journey. Record the experience.";
  if (view === "sessions") loadSessions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

elements.fileInput.addEventListener("change", () => selectFile(elements.fileInput.files?.[0]));
elements.changeFile.addEventListener("click", () => resetSelectedFile());
elements.audio.addEventListener("loadedmetadata", async () => {
  state.duration = elements.audio.duration;
  elements.seek.max = String(state.duration);
  elements.duration.textContent = formatTimestamp(state.duration);
  elements.currentTime.textContent = "00:00";
  elements.modeOptions.disabled = false;
  validateConfiguration();
  if (state.persistSourceOnMetadata && state.file) {
    state.persistSourceOnMetadata = false;
    const fileToSave = state.file;
    try {
      await repository.saveLastSelectedSource(fileToSave, state.duration);
      if (state.file === fileToSave) {
        elements.sourceMeta.textContent = `${fileToSave.type || "Unknown audio type"} · ${bytesLabel(fileToSave.size)} · Saved on this device`;
      }
      updateStorageEstimate();
    } catch (error) {
      const quota = error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "");
      showToast(quota
        ? "This source plays normally, but there is not enough browser storage to restore it after a refresh."
        : `This source plays normally, but it could not be saved for the next visit: ${error.message}`, true);
    }
  }
});
elements.audio.addEventListener("error", async () => {
  showToast("Safari could not read this audio file. Try another format.", true);
  if (state.sourceFromStorage) {
    try { await repository.deleteLastSelectedSource(); } catch { /* It can still be cleared in Safari settings. */ }
  }
  resetSelectedFile();
});
elements.audio.addEventListener("timeupdate", () => {
  if (!state.sessionActive) {
    elements.seek.value = String(elements.audio.currentTime);
    elements.currentTime.textContent = formatTimestamp(elements.audio.currentTime);
  }
});
elements.audio.addEventListener("play", () => {
  setBrowserAudioSession(state.sessionActive ? "play-and-record" : "playback");
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
window.addEventListener("hashchange", () => switchView(viewFromRoute(), false));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.sessionActive) showToast("Keep Innercast open and your phone unlocked. iOS may interrupt playback or recording in the background.", true);
});
window.addEventListener("pagehide", () => {
  if (state.sessionActive) state.microphone?.release();
  state.transcriptionJob?.transcriber.cancel();
  clearSessionObjectUrls();
});
if (!["#/recorder", "#/sessions"].includes(window.location.hash)) {
  window.history.replaceState(null, "", routeForView("recorder"));
}
setBrowserAudioSession("playback");
const initialView = viewFromRoute();
switchView(initialView, false);
if (initialView !== "sessions") loadSessions();
restoreLastSelectedSource();
window.addEventListener("load", registerOfflineSupport, { once: true });
