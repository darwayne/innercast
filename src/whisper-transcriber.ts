export type WhisperModelKey = "tiny" | "base" | "small" | "medium" | "large" | "moonshineTiny" | "moonshineBase" | "moonshineSmallStreaming" | "moonshineMediumStreaming";

export interface WhisperModelChoice {
  id: string;
  label: string;
  approximateSize: string;
  device?: "wasm" | "webgpu";
  dtype?: string | Record<string, string>;
  family?: "whisper" | "moonshine" | "moonshine-v2";
  revision?: string;
  decoderLayers?: number;
  attentionHeads?: number;
  headDimension?: number;
}

export interface TranscriptionProgress {
  phase: "decoding" | "model" | "transcribing";
  message: string;
  progress: number | null;
}

export interface WhisperTranscript {
  text: string;
  language: "en";
  provider: "whisper-transformers-js" | "moonshine-transformers-js" | "moonshine-v2-onnxruntime-web";
  model: WhisperModelKey;
  modelId: string;
  device: "wasm" | "webgpu";
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
  tiny: { id: "onnx-community/whisper-tiny.en", label: "Whisper Tiny English — fastest", approximateSize: "~45 MB download" },
  base: { id: "onnx-community/whisper-base.en", label: "Whisper Base English — balanced", approximateSize: "~80 MB download" },
  small: { id: "onnx-community/whisper-small.en", label: "Whisper Small English — experimental", approximateSize: "~250 MB download" },
  medium: {
    id: "distil-whisper/distil-medium.en",
    label: "Distil-Medium English — experimental",
    approximateSize: "~405 MB download",
  },
  large: {
    id: "distil-whisper/distil-large-v3.5-ONNX",
    label: "Distil-Large v3.5 English — bleeding edge",
    approximateSize: "~540 MB download",
    device: "webgpu",
    dtype: {
      encoder_model: "q4f16",
      decoder_model_merged: "q4f16",
    },
  },
  moonshineTiny: {
    id: "onnx-community/moonshine-tiny-ONNX",
    label: "Moonshine Tiny English — lightweight",
    approximateSize: "~55 MB download",
    family: "moonshine",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
  },
  moonshineBase: {
    id: "onnx-community/moonshine-base-ONNX",
    label: "Moonshine Base English — recommended",
    approximateSize: "~127 MB download",
    family: "moonshine",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
  },
  moonshineSmallStreaming: {
    id: "Immortalizer/moonshine-streaming-small-onnx",
    revision: "64ebc81403e04e7810c557615f4119717a6ae88f",
    label: "Moonshine Small Streaming English — experimental",
    approximateSize: "~216 MB download", family: "moonshine-v2",
    decoderLayers: 10, attentionHeads: 8, headDimension: 64,
  },
  moonshineMediumStreaming: {
    id: "Immortalizer/moonshine-streaming-medium-onnx",
    revision: "0174b1111690d2f883c228f4d773243264569e5d",
    label: "Moonshine Medium Streaming English — bleeding edge",
    approximateSize: "~363 MB download", family: "moonshine-v2",
    decoderLayers: 14, attentionHeads: 10, headDimension: 64,
  },
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
    if (!WHISPER_MODELS[modelKey]) throw new Error("Choose a supported transcription model.");
    this.cancelled = false;
    const audio = await decodeToWhisperAudio(blob, onProgress, () => this.cancelled);
    return new Promise((resolve, reject) => {
      this.activeReject = reject;
      const workerFile = model.family === "moonshine-v2" ? "../app/moonshine-v2-worker.js?v=11" : "../app/whisper-worker.js?v=11";
      const worker = new Worker(new URL(workerFile, import.meta.url), { type: "module" });
      this.worker = worker;
      const finish = () => { worker.terminate(); this.worker = null; this.activeReject = null; };
      worker.onmessage = (event: MessageEvent) => {
        if (event.data.type === "progress") { onProgress(event.data.detail); return; }
        finish();
        event.data.type === "complete" ? resolve(event.data.transcription) : reject(new Error(event.data.error));
      };
      worker.onerror = () => { finish(); reject(new Error("The transcription model could not load.")); };
      const model = WHISPER_MODELS[modelKey];
      worker.postMessage({
        type: "transcribe", audio, modelKey, modelId: model.id,
        modelFamily: model.family ?? "whisper", revision: model.revision,
        decoderLayers: model.decoderLayers, attentionHeads: model.attentionHeads, headDimension: model.headDimension,
        device: model.device ?? "wasm", dtype: model.dtype ?? "q8", recordingSourceOffsetSeconds,
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
