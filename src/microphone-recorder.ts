export interface CompletedRecording {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

/** Captures MediaRecorder chunks; persistence deliberately lives elsewhere. */
export class MicrophoneRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startClockTime: number | null = null;
  private pausedClockTime: number | null = null;
  private accumulatedPauseSeconds = 0;
  private hasStarted = false;
  private finalBlobPromise: Promise<Blob> | null = null;
  private resolveFinalBlob: ((blob: Blob) => void) | null = null;
  mimeType = "";
  onUnexpectedStop: ((error: Error) => void) | null = null;

  static chooseMimeType(): string {
    const choices = [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
    ];
    return choices.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  }

  async prepare(): Promise<void> {
    if (!window.isSecureContext) {
      throw new Error("Microphone access requires HTTPS. When using Tailscale, run “make tailscale” and open the https://…ts.net address it displays.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not expose microphone access. Open Innercast directly in Safari and check the site's microphone permission.");
    }
    if (!window.MediaRecorder) {
      throw new Error("MediaRecorder is not supported by this Safari version. Update iOS and try again.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Keep noise suppression and automatic gain while avoiding the echo-
      // cancellation path that may trigger iOS playback ducking.
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const type = MicrophoneRecorder.chooseMimeType();
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.mimeType = this.recorder.mimeType || type || "application/octet-stream";
    this.chunks = [];
    this.hasStarted = false;
    this.finalBlobPromise = new Promise((resolve) => { this.resolveFinalBlob = resolve; });
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.onstop = () => this.resolveFinalBlob?.(new Blob(this.chunks, { type: this.mimeType }));
    this.recorder.onerror = (event) => this.onUnexpectedStop?.(event.error ?? new Error("The microphone recorder reported an error."));
    for (const track of this.stream.getAudioTracks()) {
      track.onended = () => this.onUnexpectedStop?.(new Error("The microphone became unavailable."));
    }
  }

  start(audioClockTime: number): void {
    if (!this.recorder || this.recorder.state !== "inactive") throw new Error("Microphone is not ready to record.");
    this.startClockTime = audioClockTime;
    this.pausedClockTime = null;
    this.accumulatedPauseSeconds = 0;
    this.hasStarted = true;
    this.recorder.start(1000);
  }

  pause(audioClockTime: number): void {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedClockTime = audioClockTime;
    }
  }

  resume(audioClockTime: number): void {
    if (this.recorder?.state === "paused") {
      if (this.pausedClockTime !== null) this.accumulatedPauseSeconds += Math.max(0, audioClockTime - this.pausedClockTime);
      this.pausedClockTime = null;
      this.recorder.resume();
    }
  }

  elapsed(audioClockTime: number): number {
    if (this.startClockTime === null) return 0;
    const end = this.pausedClockTime ?? audioClockTime;
    return Math.max(0, end - this.startClockTime - this.accumulatedPauseSeconds);
  }

  async stop(audioClockTime: number): Promise<CompletedRecording | null> {
    if (!this.recorder || !this.hasStarted) {
      this.release();
      return null;
    }
    const durationSeconds = this.elapsed(audioClockTime);
    if (this.recorder.state !== "inactive") this.recorder.stop();
    const fallbackBlob = (): Blob => new Blob(this.chunks, { type: this.mimeType });
    const blob = await Promise.race([
      this.finalBlobPromise!,
      new Promise<Blob>((resolve) => window.setTimeout(() => resolve(fallbackBlob()), 1500)),
    ]);
    this.release();
    return { blob, mimeType: this.mimeType, durationSeconds };
  }

  release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  get state(): RecordingState { return this.recorder?.state ?? "inactive"; }
}
