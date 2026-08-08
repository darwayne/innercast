export type RecordingStartMode = "immediate" | "sourceTimestamp" | "delay";

export interface SourceMetadata {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
}

export interface RecordingMetadata {
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
}

export interface SynchronizationMetadata {
  /** The source timestamp that corresponds to microphone timestamp zero. */
  recordingSourceOffsetSeconds: number;
  mode: RecordingStartMode;
  /** The user's original value: zero, absolute source time, or delay length. */
  configuredValueSeconds: number;
}

export interface SavedSession {
  id: string;
  createdAt: string;
  source: SourceMetadata;
  recording: RecordingMetadata;
  synchronization: SynchronizationMetadata;
  transcription?: {
    text: string;
    language: string;
    /** web-speech-api is retained only so sessions saved by older builds remain readable. */
    provider: "whisper-transformers-js" | "web-speech-api";
    model?: "tiny" | "base" | "small";
    createdAt?: string;
    segments: Array<{
      text: string;
      confidence?: number | null;
      micTimestampSeconds: number;
      sourceTimestampSeconds: number;
      endMicTimestampSeconds?: number | null;
    }>;
    errorMessage: string | null;
  };
}
