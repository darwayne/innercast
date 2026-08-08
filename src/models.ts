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
}
