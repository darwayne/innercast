export type WhisperModelKey = "tiny" | "base";

export interface WhisperModelChoice {
  id: string;
  label: string;
  approximateSize: string;
}

export interface TranscriptionProgress {
  phase: "decoding" | "model" | "transcribing";
  message: string;
  progress: number | null;
}

export interface WhisperTranscript {
  text: string;
  language: "en";
  provider: "whisper-transformers-js";
  model: WhisperModelKey;
  createdAt: string;
  segments: Array<{
    text: string;
    micTimestampSeconds: number;
    sourceTimestampSeconds: number;
    endMicTimestampSeconds: number | null;
  }>;
  errorMessage: null;
}

export const WHISPER_MODELS: Readonly<Record<WhisperModelKey, WhisperModelChoice>> = Object.freeze({
  tiny: { id: "onnx-community/whisper-tiny.en", label: "Tiny English — fastest", approximateSize: "~75 MB" },
  base: { id: "onnx-community/whisper-base.en", label: "Base English — balanced", approximateSize: "~142 MB" },
});

const TARGET_SAMPLE_RATE = 16_000;

async function decodeToWhisperAudio(
  blob: Blob,
  onProgress: (update: TranscriptionProgress) => void,
  isCancelled: () => boolean,
): Promise<Float32Array> {
  if (!window.AudioContext || !window.OfflineAudioContext) {
    throw new Error("On-device audio decoding is not supported by this Safari version.");
  }
  onProgress({ phase: "decoding", message: "Preparing recording…", progress: 0 });
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (isCancelled()) throw new Error("Transcription cancelled.");
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    if (isCancelled()) throw new Error("Transcription cancelled.");
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Owns post-recording decode/worker lifecycle; it knows nothing about IndexedDB. */
export class OnDeviceWhisperTranscriber {
  private worker: Worker | null = null;
  private cancelled = false;
  private activeReject: ((reason: Error) => void) | null = null;

  async transcribe(
    blob: Blob,
    modelKey: WhisperModelKey,
    recordingSourceOffsetSeconds: number,
    onProgress: (update: TranscriptionProgress) => void = () => undefined,
  ): Promise<WhisperTranscript> {
    if (!WHISPER_MODELS[modelKey]) throw new Error("Choose a supported Whisper model.");
    this.cancelled = false;
    const audio = await decodeToWhisperAudio(blob, onProgress, () => this.cancelled);
    return new Promise((resolve, reject) => {
      this.activeReject = reject;
      const worker = new Worker(new URL("../app/whisper-worker.js", import.meta.url), { type: "module" });
      this.worker = worker;
      const finish = () => { worker.terminate(); this.worker = null; this.activeReject = null; };
      worker.onmessage = (event: MessageEvent) => {
        if (event.data.type === "progress") { onProgress(event.data.detail); return; }
        finish();
        event.data.type === "complete" ? resolve(event.data.transcription) : reject(new Error(event.data.error));
      };
      worker.onerror = () => { finish(); reject(new Error("Whisper could not load.")); };
      worker.postMessage({
        type: "transcribe", audio, modelKey, modelId: WHISPER_MODELS[modelKey].id, recordingSourceOffsetSeconds,
      }, [audio.buffer]);
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.worker?.terminate();
    this.worker = null;
    this.activeReject?.(new Error("Transcription cancelled."));
    this.activeReject = null;
  }
}
