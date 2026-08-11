export const WHISPER_MODELS = Object.freeze({
  tiny: {
    id: "onnx-community/whisper-tiny.en",
    label: "Whisper Tiny English — fastest",
    approximateSize: "~45 MB download",
  },
  base: {
    id: "onnx-community/whisper-base.en",
    label: "Whisper Base English — balanced",
    approximateSize: "~80 MB download",
  },
  small: {
    id: "onnx-community/whisper-small.en",
    label: "Whisper Small English — experimental",
    approximateSize: "~250 MB download",
  },
  medium: {
    id: "distil-whisper/distil-medium.en",
    label: "Distil-Medium English — experimental",
    approximateSize: "~405 MB download",
  },
  moonshineTiny: {
    id: "onnx-community/moonshine-tiny-ONNX",
    label: "Moonshine Tiny English — lightweight",
    approximateSize: "~55 MB download",
    family: "moonshine",
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q8",
    },
  },
  moonshineBase: {
    id: "onnx-community/moonshine-base-ONNX",
    label: "Moonshine Base English — recommended",
    approximateSize: "~127 MB download",
    family: "moonshine",
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "q8",
    },
  },
  moonshineSmallStreaming: {
    id: "Immortalizer/moonshine-streaming-small-onnx",
    revision: "64ebc81403e04e7810c557615f4119717a6ae88f",
    label: "Moonshine Small Streaming English — experimental",
    approximateSize: "~216 MB download",
    family: "moonshine-v2",
    decoderLayers: 10,
    attentionHeads: 8,
    headDimension: 64,
  },
  moonshineMediumStreaming: {
    id: "Immortalizer/moonshine-streaming-medium-onnx",
    revision: "0174b1111690d2f883c228f4d773243264569e5d",
    label: "Moonshine Medium Streaming English — bleeding edge",
    approximateSize: "~363 MB download",
    family: "moonshine-v2",
    decoderLayers: 14,
    attentionHeads: 10,
    headDimension: 64,
  },
});

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Decodes a completed MediaRecorder Blob and converts it to the models' expected
 * 16 kHz mono PCM. This happens only after the recording is safely in IndexedDB,
 * so model loading or transcription can never interfere with capture.
 */
async function decodeToWhisperAudio(blob, onProgress, isCancelled) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error("On-device audio decoding is not supported by this browser version.");
  }

  onProgress({ phase: "decoding", message: "Preparing recording…", progress: 0 });
  const context = new AudioContextClass();
  try {
    const encoded = await blob.arrayBuffer();
    if (isCancelled()) throw new Error("Transcription cancelled.");
    const decoded = await context.decodeAudioData(encoded);
    const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContextClass(1, frameCount, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    if (isCancelled()) throw new Error("Transcription cancelled.");
    onProgress({ phase: "decoding", message: "Recording prepared", progress: 1 });
    return new Float32Array(rendered.getChannelData(0));
  } catch (error) {
    if (/cancelled/i.test(error?.message || "")) throw error;
    throw new Error(`The browser could not prepare this recording for transcription: ${error?.message || error}`);
  } finally {
    await context.close().catch(() => {});
  }
}

export class OnDeviceWhisperTranscriber {
  constructor() {
    this.worker = null;
    this.cancelled = false;
    this.activeReject = null;
  }

  async transcribe(blob, modelKey, recordingSourceOffsetSeconds, onProgress = () => {}) {
    if (!WHISPER_MODELS[modelKey]) throw new Error("Choose a supported transcription model.");
    if (!(blob instanceof Blob) || !blob.size) throw new Error("This recording has no audio to transcribe.");
    if (!window.Worker) throw new Error("Web Workers are not supported by this browser version.");

    this.cancelled = false;
    const model = WHISPER_MODELS[modelKey];
    const audio = await decodeToWhisperAudio(blob, onProgress, () => this.cancelled);
    if (this.cancelled) throw new Error("Transcription cancelled.");

    return new Promise((resolve, reject) => {
      this.activeReject = reject;
      const workerFile = model.family === "moonshine-v2" ? "./moonshine-v2-worker.js?v=19" : "./whisper-worker.js?v=19";
      const worker = new Worker(new URL(workerFile, import.meta.url), { type: "module" });
      this.worker = worker;
      const finish = () => {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.activeReject = null;
      };
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "progress") {
          onProgress(message.detail);
          return;
        }
        finish();
        if (message.type === "complete") resolve(message.transcription);
        else reject(new Error(message.error || "On-device transcription failed."));
      };
      worker.onerror = () => {
        finish();
        reject(new Error("The transcription model could not load. First use requires internet access to download the engine and model."));
      };
      worker.postMessage({
        type: "transcribe",
        audio,
        modelKey,
        modelId: model.id,
        modelFamily: model.family || "whisper",
        revision: model.revision,
        decoderLayers: model.decoderLayers,
        attentionHeads: model.attentionHeads,
        headDimension: model.headDimension,
        device: model.device || "wasm",
        dtype: model.dtype || "q8",
        recordingSourceOffsetSeconds,
      }, [audio.buffer]);
    });
  }

  cancel() {
    this.cancelled = true;
    this.worker?.terminate();
    this.worker = null;
    this.activeReject?.(new Error("Transcription cancelled."));
    this.activeReject = null;
  }
}
