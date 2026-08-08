export const WHISPER_MODELS = Object.freeze({
  tiny: {
    id: "onnx-community/whisper-tiny.en",
    label: "Tiny English — fastest",
    approximateSize: "~75 MB",
  },
  base: {
    id: "onnx-community/whisper-base.en",
    label: "Base English — balanced",
    approximateSize: "~142 MB",
  },
});

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Decodes a completed MediaRecorder Blob and converts it to Whisper's expected
 * 16 kHz mono PCM. This happens only after the recording is safely in IndexedDB,
 * so model loading or transcription can never interfere with capture.
 */
async function decodeToWhisperAudio(blob, onProgress, isCancelled) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error("On-device audio decoding is not supported by this Safari version.");
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
    throw new Error(`Safari could not prepare this recording for transcription: ${error?.message || error}`);
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
    if (!WHISPER_MODELS[modelKey]) throw new Error("Choose a supported Whisper model.");
    if (!(blob instanceof Blob) || !blob.size) throw new Error("This recording has no audio to transcribe.");
    if (!window.Worker) throw new Error("Web Workers are not supported by this Safari version.");

    this.cancelled = false;
    const audio = await decodeToWhisperAudio(blob, onProgress, () => this.cancelled);
    if (this.cancelled) throw new Error("Transcription cancelled.");

    return new Promise((resolve, reject) => {
      this.activeReject = reject;
      const worker = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
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
        reject(new Error("Whisper could not load. The first use requires internet access to download the transcription engine and model."));
      };
      worker.postMessage({
        type: "transcribe",
        audio,
        modelKey,
        modelId: WHISPER_MODELS[modelKey].id,
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
