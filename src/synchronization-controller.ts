import type { RecordingStartMode } from "./models.js";

/**
 * Owns the one-value synchronization model.
 *
 * Once recording starts, microphone time 0 maps to
 * recordingSourceOffsetSeconds. Playback and recording must then pause/resume
 * together, and source seeking must remain disabled.
 */
export class SynchronizationController {
  recordingSourceOffsetSeconds = 0;
  mode: RecordingStartMode = "immediate";
  configuredValueSeconds = 0;
  recordingStarted = false;

  constructor(private readonly audioContext: AudioContext) {}

  configure(mode: RecordingStartMode, configuredValue: number, sourceStartPosition: number): void {
    this.mode = mode;
    this.configuredValueSeconds = configuredValue;
    this.recordingSourceOffsetSeconds = mode === "immediate"
      ? sourceStartPosition
      : mode === "delay" ? sourceStartPosition + configuredValue : configuredValue;
    this.recordingStarted = false;
  }

  shouldStartRecording(sourceCurrentTime: number): boolean {
    return !this.recordingStarted && sourceCurrentTime + 0.02 >= this.recordingSourceOffsetSeconds;
  }

  markRecordingStarted(actualSourceTime: number): number {
    this.recordingStarted = true;
    this.recordingSourceOffsetSeconds = actualSourceTime;
    return this.audioContext.currentTime;
  }

  sourceTimeForMicTime(micTime: number): number {
    return this.recordingSourceOffsetSeconds + micTime;
  }
}
