import { formatTimestamp, parseTimestamp, validateOffset } from "./timestamp.js";
import { RecordingRepository } from "./repository.js";
import { MicrophoneRecorder, SynchronizationController } from "./controllers.js?v=22";
import { isLikelyAudioFile } from "./file-types.js";
import { OnDeviceWhisperTranscriber, WHISPER_MODELS } from "./whisper-transcriber.js?v=19";
import { ChunkedModelCache } from "./model-cache.js?v=19";
import { isNativeRuntime, nativeCommand, NativeRecordingRepository } from "./native-runtime.js?v=1";

const $ = (selector) => document.querySelector(selector);
const repository = isNativeRuntime ? new NativeRecordingRepository() : new RecordingRepository();
const TRANSCRIPTION_MODEL_SETTING = "innercast-transcription-model";
const MICROPHONE_SETTING = "innercast-microphone";
const DEFAULT_TRANSCRIPTION_MODEL = "small";
// On iOS, play-and-record can force Bluetooth headphones into a mono voice
// route. WebKit can keep an already-acquired microphone alive while playback
// restores the high-quality output route, so prefer that behavior for Innercast.
const ACTIVE_RECORDING_AUDIO_SESSION = "playback";
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
  wakeLock: null,
  microphoneDevices: [],
  settingsReturnView: "sessions",
  nativePaused: false,
  nativeFinalizedSessionId: null,
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
  transcriptionModelSetting: $("#transcription-model-setting"),
  transcriptionModelDescription: $("#transcription-model-description"),
  microphoneSetting: $("#microphone-setting"),
  microphoneSettingDescription: $("#microphone-setting-description"),
  refreshMicrophones: $("#refresh-microphones"),
  selectedMicrophoneLabel: $("#selected-microphone-label"),
  settingsBack: $("#settings-back"),
};

function selectedMicrophonePreference() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(MICROPHONE_SETTING) || "null");
    if (saved?.deviceId) return { deviceId: saved.deviceId, label: saved.label || "Selected microphone" };
  } catch { /* Fall back to the browser's default input. */ }
  return { deviceId: "", label: "Automatic" };
}

function saveMicrophonePreference(deviceId, label) {
  try {
    if (deviceId) window.localStorage.setItem(MICROPHONE_SETTING, JSON.stringify({ deviceId, label }));
    else window.localStorage.removeItem(MICROPHONE_SETTING);
  } catch { showToast("The browser could not save the microphone setting.", true); }
}

function updateMicrophoneContext() {
  if (elements.selectedMicrophoneLabel) elements.selectedMicrophoneLabel.textContent = selectedMicrophonePreference().label;
}

function renderMicrophoneSettings() {
  if (!elements.microphoneSetting) return;
  const preference = selectedMicrophonePreference();
  elements.microphoneSetting.replaceChildren();
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Automatic (browser default)";
  elements.microphoneSetting.append(automatic);
  state.microphoneDevices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    elements.microphoneSetting.append(option);
  });
  if (preference.deviceId && !state.microphoneDevices.some((device) => device.deviceId === preference.deviceId)) {
    const unavailable = document.createElement("option");
    unavailable.value = preference.deviceId;
    unavailable.textContent = `${preference.label} (currently unavailable)`;
    elements.microphoneSetting.append(unavailable);
  }
  elements.microphoneSetting.value = preference.deviceId;
  const count = state.microphoneDevices.length;
  elements.microphoneSettingDescription.textContent = !navigator.mediaDevices?.enumerateDevices
    ? "This browser does not support microphone enumeration and will choose the input automatically."
    : count === 0
      ? "The browser has not revealed any named inputs yet. Tap Find microphones and allow access to refresh the list."
      : count === 1
        ? "The browser currently exposes one microphone to this web app."
        : `${count} microphones are available. The selected input will be requested when a session starts.`;
  updateMicrophoneContext();
}

async function refreshMicrophoneDevices(requestPermission = false) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    state.microphoneDevices = [];
    renderMicrophoneSettings();
    return;
  }
  let permissionStream = null;
  try {
    if (requestPermission) {
      setBrowserAudioSession("auto");
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const seen = new Set();
    state.microphoneDevices = devices.filter((device) => {
      if (device.kind !== "audioinput" || !device.deviceId || seen.has(device.deviceId)) return false;
      seen.add(device.deviceId);
      return true;
    });
    renderMicrophoneSettings();
  } catch (error) {
    if (requestPermission) {
      const denied = error?.name === "NotAllowedError";
      showToast(denied ? "Microphone access was not allowed, so the browser cannot reveal input names." : `Could not refresh microphones: ${error.message}`, true);
    }
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
    if (requestPermission) resetBrowserAudioSessionForPlayback();
  }
}

function microphoneLabelForId(deviceId) {
  return state.microphoneDevices.find((device) => device.deviceId === deviceId)?.label || "Browser default";
}

function selectedTranscriptionModel() {
  try {
    const saved = window.localStorage.getItem(TRANSCRIPTION_MODEL_SETTING);
    return WHISPER_MODELS[saved] ? saved : DEFAULT_TRANSCRIPTION_MODEL;
  } catch { return DEFAULT_TRANSCRIPTION_MODEL; }
}

function transcriptionModelLabel(modelKey = selectedTranscriptionModel()) {
  return WHISPER_MODELS[modelKey]?.label.split(" —")[0] || "Whisper Small English";
}

function updateTranscriptionSettingDescription() {
  const model = WHISPER_MODELS[selectedTranscriptionModel()];
  if (!elements.transcriptionModelDescription || !model) return;
  elements.transcriptionModelDescription.textContent = `${model.label} · ${model.approximateSize}. The first use downloads and caches this model on this device.`;
}

function initializeTranscriptionSettings() {
  if (!elements.transcriptionModelSetting) return;
  for (const [key, model] of Object.entries(WHISPER_MODELS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = `${model.label} (${model.approximateSize})`;
    elements.transcriptionModelSetting.append(option);
  }
  elements.transcriptionModelSetting.value = selectedTranscriptionModel();
  updateTranscriptionSettingDescription();
  elements.transcriptionModelSetting.addEventListener("change", () => {
    try { window.localStorage.setItem(TRANSCRIPTION_MODEL_SETTING, elements.transcriptionModelSetting.value); }
    catch { showToast("The browser could not save this setting.", true); }
    updateTranscriptionSettingDescription();
    showToast(`${transcriptionModelLabel()} will be used for transcription.`);
  });
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  window.setTimeout(() => elements.toast.classList.remove("show"), 4200);
}

function setBrowserAudioSession(type) {
  // WebKit exposes the Audio Session API on current iOS releases. Explicitly
  // selecting playback prevents IndexedDB Blob players from remaining silent
  // until another native media element happens to initialize the output route.
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) {
      navigator.audioSession.type = type;
    }
  } catch { /* Other browsers manage their audio route automatically. */ }
}

function resetBrowserAudioSessionForPlayback() {
  // WebKit can leave iOS in its lower-fidelity capture route after the mic is
  // released. Toggling playback -> auto asks the OS to restore normal media
  // routing; do this before play while we still have the user's gesture.
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = "playback";
      navigator.audioSession.type = "auto";
    }
  } catch { /* The Audio Session API is browser-specific and optional. */ }
}

function preparePlaybackOutput() {
  resetBrowserAudioSessionForPlayback();
  // Resume during the user's touch gesture when possible. The HTMLAudioElement
  // remains the actual output path; this only unlocks the browser's audio machinery.
  ensureAudioContext().catch(() => {});
}

async function requestSessionWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  if (state.wakeLock && !state.wakeLock.released) return;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    if (!state.sessionActive) {
      await wakeLock.release();
      return;
    }
    state.wakeLock = wakeLock;
    wakeLock.addEventListener("release", () => {
      if (state.wakeLock === wakeLock) state.wakeLock = null;
    });
  } catch (error) {
    // Wake Lock is an optional safeguard. Recording must remain usable when
    // The browser declines it (for example, in Low Power Mode).
    console.warn("The screen wake lock could not be acquired.", error);
  }
}

async function releaseSessionWakeLock() {
  const wakeLock = state.wakeLock;
  state.wakeLock = null;
  if (!wakeLock || wakeLock.released) return;
  try { await wakeLock.release(); }
  catch (error) { console.warn("The screen wake lock could not be released.", error); }
}

async function registerOfflineSupport() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    if (!hadController) showToast("Innercast is ready for offline use.");
  } catch (error) {
    // Recording and storage remain usable even if the browser declines service
    // worker registration (for example, in private browsing mode).
    console.warn("Offline support could not be installed.", error);
  }
}

async function initializeModelCache() {
  try {
    const database = await new ChunkedModelCache().open();
    database.close();
  } catch (error) {
    console.warn("The transcription model cache could not be initialized.", error);
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

function channelCountLabel(value) {
  const count = Math.max(1, Math.trunc(Number(value) || 1));
  if (count === 1) return "Mono";
  if (count === 2) return "Stereo";
  return `${count} channels`;
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

function configuredValueSeconds() {
  const mode = currentMode();
  if (mode === "immediate") return 0;
  return parseTimestamp(mode === "sourceTimestamp" ? elements.timestampInput.value : elements.delayInput.value);
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

function selectNativeSource(source) {
  if (!source || state.sessionActive) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = {
    name: source.filename,
    type: source.mimeType,
    size: source.sizeBytes,
  };
  state.objectUrl = null;
  state.duration = source.durationSeconds;
  state.persistSourceOnMetadata = false;
  state.sourceFromStorage = true;
  elements.audio.src = source.playbackUrl;
  elements.sourceName.textContent = source.filename;
  elements.sourceMeta.textContent = `${source.mimeType || "Unknown audio type"} · ${bytesLabel(source.sizeBytes)} · Saved by the app`;
  elements.filePicker.classList.add("hidden");
  elements.sourceDetails.classList.remove("hidden");
  elements.seek.max = String(source.durationSeconds);
  elements.duration.textContent = formatTimestamp(source.durationSeconds);
  elements.modeOptions.disabled = false;
  elements.audio.load();
  validateConfiguration();
}

async function chooseNativeSource() {
  try {
    const source = await nativeCommand("selectSource");
    if (source) selectNativeSource(source);
  } catch (error) {
    if (!/cancelled/i.test(error?.message || String(error))) showToast(`Could not select that audio file: ${error.message || error}`, true);
  }
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
    if (isNativeRuntime) {
      if (saved && !state.file) selectNativeSource(saved);
      return;
    }
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
    ["Microphone input", state.microphone.deviceLabel || microphoneLabelForId(state.microphone.deviceId)],
    ["Microphone channels", state.microphone.channelCount],
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
  if (isNativeRuntime) {
    try {
      elements.audio.pause();
      const sourceStartPosition = elements.audio.currentTime;
      const mode = currentMode();
      const configuredValue = configuredValueSeconds();
      const offset = configuredOffset();
      state.sessionActive = true;
      state.nativePaused = false;
      state.nativeFinalizedSessionId = null;
      setConfigurationLocked(true);
      elements.activeSession.classList.remove("hidden");
      elements.activeSourceName.textContent = state.file.name;
      elements.activeOffset.textContent = formatTimestamp(offset);
      elements.activeRecordingTime.textContent = "00:00";
      elements.sessionStatus.textContent = offset === sourceStartPosition ? "Starting" : "Waiting to record";
      elements.waitingMessage.classList.toggle("hidden", offset === sourceStartPosition);
      elements.waitingMessage.querySelector("strong").textContent = formatTimestamp(offset);
      elements.pauseButton.textContent = "Pause";
      await nativeCommand("startSession", { mode, configuredValueSeconds: configuredValue, sourceStartPositionSeconds: sourceStartPosition });
      elements.activeSession.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      state.sessionActive = false;
      setConfigurationLocked(false);
      elements.activeSession.classList.add("hidden");
      showToast(`Could not start the session: ${error.message || error}`, true);
    } finally {
      elements.startButton.querySelector("span").textContent = "Start session";
      validateConfiguration();
    }
    return;
  }
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
    const microphonePreference = selectedMicrophonePreference();
    // Use the exact WebKit routing workaround sequence: establish the capture
    // category immediately before getUserMedia, then restore playback while
    // retaining the already-acquired microphone MediaStream.
    setBrowserAudioSession("play-and-record");
    await state.microphone.prepare(microphonePreference.deviceId);
    setBrowserAudioSession(ACTIVE_RECORDING_AUDIO_SESSION);
    await refreshMicrophoneDevices();
    state.microphone.onUnexpectedStop = handleRecorderFailure;
    state.synchronization = new SynchronizationController(state.audioContext);
    state.synchronization.configure(mode, configuredValue, sourceStartPosition);
    state.sessionActive = true;
    await requestSessionWakeLock();
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
    if (elements.audio.paused) throw new Error("The browser did not start source playback. Tap Start session again and confirm that audio is routed to your headphones.");
    if (mode === "immediate") await beginMicrophoneRecording();
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(renderActiveSession);
    elements.activeSession.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    state.microphone?.release();
    await releaseSessionWakeLock();
    resetBrowserAudioSessionForPlayback();
    state.sessionActive = false;
    setConfigurationLocked(false);
    elements.activeSession.classList.add("hidden");
    const message = error?.name === "NotAllowedError"
      ? "Microphone access was denied. Allow microphone access in your browser or site settings and try again."
      : ["OverconstrainedError", "NotFoundError"].includes(error?.name)
        ? "The selected microphone is no longer available. Reconnect it or choose another microphone in Settings."
        : `Could not start the session: ${error.message || error}`;
    showToast(message, true);
  } finally {
    elements.startButton.querySelector("span").textContent = "Start session";
    validateConfiguration();
  }
}

async function pauseOrResume() {
  if (!state.sessionActive || state.stopping) return;
  if (isNativeRuntime) {
    try {
      if (state.nativePaused) {
        await nativeCommand("resumeSession");
        state.nativePaused = false;
        elements.pauseButton.textContent = "Pause";
        elements.sessionStatus.textContent = "Recording";
      } else {
        await nativeCommand("pauseSession");
        state.nativePaused = true;
        elements.pauseButton.textContent = "Resume";
        elements.sessionStatus.textContent = "Paused";
      }
    } catch (error) { showToast(`Could not change playback: ${error.message || error}`, true); }
    return;
  }
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
  if (isNativeRuntime) {
    state.stopping = true;
    elements.stopButton.disabled = true;
    elements.pauseButton.disabled = true;
    elements.sessionStatus.textContent = "Saving";
    try {
      const session = await nativeCommand("stopSession", { reason });
      await finishNativeSession(session, reason);
    } catch (error) {
      showToast(`The recording could not be finalized: ${error.message || error}`, true);
      await finishNativeSession(null, "error");
    }
    return;
  }
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
        recording: {
          blob: result.blob,
          mimeType: result.mimeType,
          sizeBytes: result.blob.size,
          durationSeconds: result.durationSeconds,
          channelCount: result.channelCount,
        },
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
      showToast("Recording started but the browser did not provide any audio data to save.", true);
    }
  } catch (error) {
    showToast(`The recording could not be finalized: ${error.message}`, true);
  } finally {
    state.microphone?.release();
    await releaseSessionWakeLock();
    resetBrowserAudioSessionForPlayback();
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

async function finishNativeSession(session, reason) {
  if (session?.id && state.nativeFinalizedSessionId === session.id) return;
  if (session?.id) state.nativeFinalizedSessionId = session.id;
  const wasActive = state.sessionActive || state.stopping;
  state.sessionActive = false;
  state.stopping = false;
  state.nativePaused = false;
  elements.activeSession.classList.add("hidden");
  elements.stopButton.disabled = false;
  elements.pauseButton.disabled = false;
  elements.audio.currentTime = 0;
  elements.seek.value = "0";
  elements.currentTime.textContent = "00:00";
  setConfigurationLocked(false);
  if (wasActive) {
    showToast(session
      ? reason === "ended" ? "Playback ended. Recording saved on this device." : "Recording saved on this device."
      : "Session stopped before the recording start point, so nothing was saved.");
  }
  await loadSessions();
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
      selectedTranscriptionModel(),
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
    resetBrowserAudioSessionForPlayback();
    button.classList.remove("cancel-transcription");
    button.textContent = savedTranscription || session.transcription ? "Transcribe again" : "Transcribe";
    progress.classList.add("hidden");
    status.innerHTML = `Uses ${transcriptionModelLabel()}. <a href="#/settings" data-settings-from="sessions">Change in Settings</a>.`;
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
    <div class="transcription-controls single"><button type="button"></button></div>
    <progress class="hidden" max="1" value="0"></progress>
    <small>Uses ${transcriptionModelLabel()}. <a href="#/settings" data-settings-from="sessions">Change in Settings</a>.</small>`;
  const button = panel.querySelector("button");
  button.textContent = session.transcription ? "Transcribe again" : "Transcribe";
  button.addEventListener("click", () => transcribeSavedSession(session, panel));
  return panel;
}

async function loadSessions() {
  try {
    const sessions = await repository.listSessions();
    // Detach media elements before revoking their Blob URLs. Revoking a URL
    // while a mobile browser still has it attached can poison the replacement
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
      const url = session.recording.playbackUrl || URL.createObjectURL(session.recording.blob);
      if (!session.recording.playbackUrl) state.sessionObjectUrls.push(url);
      const article = document.createElement("article");
      article.className = "session-card";
      article.innerHTML = `
        <div class="session-card-head"><h2></h2><time></time></div>
        <div class="session-facts">
          <div><span>Duration</span><strong>${formatTimestamp(session.recording.durationSeconds)}</strong></div>
          <div><span>Starts at</span><strong>${formatTimestamp(session.synchronization.recordingSourceOffsetSeconds)}</strong></div>
          <div><span>Size</span><strong>${bytesLabel(session.recording.sizeBytes)}</strong></div>
          <div><span>Format</span><strong>${session.recording.mimeType || "Unknown"}</strong></div>
          <div><span>Channels</span><strong>${channelCountLabel(session.recording.channelCount)}</strong></div>
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
      recordingAudio.addEventListener("play", resetBrowserAudioSessionForPlayback);
      renderSavedTranscript(article, session);
      if (!isNativeRuntime) {
        const transcriptionPanel = createTranscriptionPanel(session);
        article.querySelector(".session-buttons").before(transcriptionPanel);
      }
      if (isNativeRuntime) {
        download.removeAttribute("download");
        download.href = "#";
        download.addEventListener("click", async (event) => {
          event.preventDefault();
          try { await repository.exportSession(session.id); }
          catch (error) { showToast(`Could not export the recording: ${error.message || error}`, true); }
        });
      }
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
  if (isNativeRuntime) {
    try {
      const { usage, available } = await repository.getStorageInfo();
      elements.storageEstimate.textContent = `Native recordings: ${bytesLabel(usage || 0)} used · ${bytesLabel(available || 0)} approximately available`;
    } catch { elements.storageEstimate.textContent = "Storage estimate is currently unavailable."; }
    return;
  }
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

function viewFromRoute() {
  if (window.location.hash === "#/sessions") return "sessions";
  if (window.location.hash === "#/settings") return "settings";
  return "recorder";
}

function switchView(view, updateRoute = true) {
  view = ["sessions", "settings"].includes(view) ? view : "recorder";
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
  document.title = view === "sessions" ? "Sessions — Innercast"
    : view === "settings" ? "Settings — Innercast"
    : "Innercast — Play the journey. Record the experience.";
  if (view === "sessions") loadSessions();
  if (view === "settings" && !isNativeRuntime) refreshMicrophoneDevices();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

elements.fileInput.addEventListener("change", () => selectFile(elements.fileInput.files?.[0]));
if (isNativeRuntime) {
  document.documentElement.classList.add("native-runtime");
  elements.filePicker.addEventListener("click", (event) => { event.preventDefault(); chooseNativeSource(); });
  elements.selectedMicrophoneLabel.textContent = "Built-in iPhone microphone · stereo A2DP output";
  elements.selectedMicrophoneLabel.nextElementSibling?.remove();
}
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
  showToast("The browser could not read this audio file. Try another format.", true);
  if (state.sourceFromStorage) {
    try { await repository.deleteLastSelectedSource(); } catch { /* It can still be cleared in browser settings. */ }
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
  if (state.sessionActive) setBrowserAudioSession(ACTIVE_RECORDING_AUDIO_SESSION);
  else resetBrowserAudioSessionForPlayback();
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
  try { if (elements.audio.paused) { preparePlaybackOutput(); await ensureAudioContext(); await elements.audio.play(); } else elements.audio.pause(); }
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
elements.microphoneSetting.addEventListener("change", () => {
  const option = elements.microphoneSetting.selectedOptions[0];
  const label = elements.microphoneSetting.value ? option.textContent.replace(/ \(currently unavailable\)$/, "") : "Automatic";
  saveMicrophonePreference(elements.microphoneSetting.value, label);
  updateMicrophoneContext();
  showToast(`${label} will be requested for new recording sessions.`);
});
elements.refreshMicrophones.addEventListener("click", async () => {
  elements.refreshMicrophones.disabled = true;
  elements.refreshMicrophones.textContent = "Checking…";
  await refreshMicrophoneDevices(true);
  elements.refreshMicrophones.disabled = false;
  elements.refreshMicrophones.textContent = "Find microphones";
});
elements.settingsBack.addEventListener("click", () => switchView(state.settingsReturnView));
document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-settings-from]");
  if (link) state.settingsReturnView = link.dataset.settingsFrom;
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
window.addEventListener("hashchange", () => switchView(viewFromRoute(), false));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.sessionActive) showToast("Keep Innercast open and your phone unlocked. iOS may interrupt playback or recording in the background.", true);
  else if (state.sessionActive) requestSessionWakeLock();
});
window.addEventListener("pagehide", () => {
  releaseSessionWakeLock();
  if (state.sessionActive) state.microphone?.release();
  state.transcriptionJob?.transcriber.cancel();
  clearSessionObjectUrls();
  if (isNativeRuntime && state.sessionActive) nativeCommand("stopSession", { reason: "pagehide" }).catch(() => {});
});
window.addEventListener("innercast-native-event", async (event) => {
  if (!isNativeRuntime) return;
  const { type, payload = {} } = event.detail || {};
  if (type === "progress" && state.sessionActive) {
    const sourceTime = Number(payload.sourceTime) || 0;
    const micElapsed = Number(payload.recordingElapsed) || 0;
    elements.audio.currentTime = sourceTime;
    elements.activeSourceTime.textContent = `${formatTimestamp(sourceTime)} / ${formatTimestamp(state.duration)}`;
    elements.activeRecordingTime.textContent = formatTimestamp(micElapsed);
    elements.activeOffset.textContent = formatTimestamp(Number(payload.recordingSourceOffsetSeconds) || 0);
    elements.activeProgressFill.style.width = `${Math.min(100, (sourceTime / state.duration) * 100)}%`;
    elements.waitingMessage.classList.toggle("hidden", Boolean(payload.recordingStarted));
    elements.sessionStatus.textContent = payload.paused ? "Paused" : payload.recordingStarted ? "Recording" : "Waiting to record";
    elements.debugValues.innerHTML = [
      ["Runtime", "Native AVAudioEngine"],
      ["Source currentTime", sourceTime.toFixed(3)],
      ["Recording state", payload.recordingStarted ? "recording" : "waiting"],
      ["Mic elapsed", micElapsed.toFixed(3)],
      ["Mapped source time", ((Number(payload.recordingSourceOffsetSeconds) || 0) + micElapsed).toFixed(3)],
    ].map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("");
  } else if (type === "sessionCompleted") {
    await finishNativeSession(payload.session || null, payload.reason || "manual");
  } else if (type === "sessionStopped") {
    await finishNativeSession(null, payload.reason || "manual");
  } else if (type === "error") {
    showToast(payload.message || "The native audio pipeline reported an error.", true);
  }
});
if (!["#/recorder", "#/sessions", "#/settings"].includes(window.location.hash)) {
  window.history.replaceState(null, "", routeForView("recorder"));
}
resetBrowserAudioSessionForPlayback();
initializeTranscriptionSettings();
renderMicrophoneSettings();
if (!isNativeRuntime) refreshMicrophoneDevices();
if (!isNativeRuntime && navigator.mediaDevices) navigator.mediaDevices.addEventListener?.("devicechange", () => refreshMicrophoneDevices());
initializeModelCache();
const initialView = viewFromRoute();
switchView(initialView, false);
if (initialView !== "sessions") loadSessions();
restoreLastSelectedSource();
window.addEventListener("load", registerOfflineSupport, { once: true });
