export class MicrophoneRecorder {
  constructor() {
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = "";
    this.startClockTime = null;
    this.pausedClockTime = null;
    this.accumulatedPauseSeconds = 0;
    this.onUnexpectedStop = null;
    this.hasStarted = false;
    this.finalBlobPromise = null;
    this.resolveFinalBlob = null;
  }

  static chooseMimeType() {
    const choices = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    return choices.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  async prepare() {
    if (!window.isSecureContext) throw new Error("Microphone access requires HTTPS. When using Tailscale, run “make tailscale” and open the https://…ts.net address it displays.");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not expose microphone access. Open Innercast directly in Safari and check the site's microphone permission.");
    if (!window.MediaRecorder) throw new Error("MediaRecorder is not supported by this Safari version. Update iOS and try again.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const type = MicrophoneRecorder.chooseMimeType();
    const options = type ? { mimeType: type } : undefined;
    this.recorder = new MediaRecorder(this.stream, options);
    this.mimeType = this.recorder.mimeType || type || "application/octet-stream";
    this.chunks = [];
    this.hasStarted = false;
    this.finalBlobPromise = new Promise((resolve) => { this.resolveFinalBlob = resolve; });
    this.recorder.ondataavailable = (event) => { if (event.data?.size) this.chunks.push(event.data); };
    this.recorder.onstop = () => this.resolveFinalBlob?.(new Blob(this.chunks, { type: this.mimeType }));
    this.recorder.onerror = (event) => this.onUnexpectedStop?.(event.error || new Error("The microphone recorder reported an error."));
    for (const track of this.stream.getAudioTracks()) track.onended = () => this.onUnexpectedStop?.(new Error("The microphone became unavailable."));
  }

  start(audioClockTime) {
    if (!this.recorder || this.recorder.state !== "inactive") throw new Error("Microphone is not ready to record.");
    this.startClockTime = audioClockTime;
    this.pausedClockTime = null;
    this.accumulatedPauseSeconds = 0;
    this.hasStarted = true;
    this.recorder.start(1000);
  }

  pause(audioClockTime) {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedClockTime = audioClockTime;
    }
  }

  resume(audioClockTime) {
    if (this.recorder?.state === "paused") {
      if (this.pausedClockTime !== null) this.accumulatedPauseSeconds += Math.max(0, audioClockTime - this.pausedClockTime);
      this.pausedClockTime = null;
      this.recorder.resume();
    }
  }

  elapsed(audioClockTime) {
    if (this.startClockTime === null) return 0;
    const end = this.pausedClockTime ?? audioClockTime;
    return Math.max(0, end - this.startClockTime - this.accumulatedPauseSeconds);
  }

  async stop(audioClockTime) {
    if (!this.recorder || !this.hasStarted) {
      this.release();
      return null;
    }
    const durationSeconds = this.elapsed(audioClockTime);
    if (this.recorder.state !== "inactive") this.recorder.stop();
    const fallbackBlob = () => new Blob(this.chunks, { type: this.mimeType });
    const blob = await Promise.race([
      this.finalBlobPromise,
      new Promise((resolve) => window.setTimeout(() => resolve(fallbackBlob()), 1500)),
    ]);
    this.release();
    return { blob, mimeType: this.mimeType, durationSeconds };
  }

  release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  get state() { return this.recorder?.state || "inactive"; }
}

export class SynchronizationController {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.recordingSourceOffsetSeconds = 0;
    this.mode = "immediate";
    this.configuredValueSeconds = 0;
    this.recordingStarted = false;
  }

  configure(mode, configuredValue, sourceStartPosition) {
    this.mode = mode;
    this.configuredValueSeconds = configuredValue;
    this.recordingSourceOffsetSeconds = mode === "immediate"
      ? sourceStartPosition
      : mode === "delay" ? sourceStartPosition + configuredValue : configuredValue;
    this.recordingStarted = false;
  }

  shouldStartRecording(sourceCurrentTime) {
    return !this.recordingStarted && sourceCurrentTime + 0.02 >= this.recordingSourceOffsetSeconds;
  }

  markRecordingStarted(actualSourceTime) {
    this.recordingStarted = true;
    // This measured source position is the invariant: microphone time 0 maps here.
    // Playback and MediaRecorder are subsequently paused/resumed as one unit and seeking is prohibited.
    this.recordingSourceOffsetSeconds = actualSourceTime;
    return this.audioContext.currentTime;
  }

  sourceTimeForMicTime(micTime) { return this.recordingSourceOffsetSeconds + micTime; }
}
