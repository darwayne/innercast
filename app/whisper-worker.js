// Pinned so an Innercast release always uses the same inference runtime.
// The runtime and selected model are fetched only for optional transcription;
// inference itself happens inside this worker and audio is never uploaded.
import { env, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
import { ChunkedModelCache } from "./model-cache.js?v=14";

env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = new ChunkedModelCache(({ file, loaded, total, progress }) => {
  const loadedMB = (loaded / (1024 * 1024)).toFixed(0);
  const totalLabel = total ? ` of ${(total / (1024 * 1024)).toFixed(0)} MB` : " MB";
  report({
    phase: "model",
    message: `Saving ${file} safely… ${loadedMB}${totalLabel}`,
    progress,
  });
});
env.allowLocalModels = false;

const SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 30;
let loadedModelConfiguration = null;
let transcriber = null;

function report(detail) { self.postMessage({ type: "progress", detail }); }

async function loadModel(modelId, device, dtype) {
  const configuration = JSON.stringify({ modelId, device, dtype });
  if (transcriber && loadedModelConfiguration === configuration) return transcriber;
  if (device === "webgpu" && !self.navigator?.gpu) {
    throw new Error("This browser does not expose the WebGPU support required by the selected model.");
  }
  if (transcriber?.dispose) await transcriber.dispose();
  transcriber = null;
  loadedModelConfiguration = null;
  report({ phase: "model", message: "Loading transcription model…", progress: 0 });
  transcriber = await pipeline("automatic-speech-recognition", modelId, {
    device,
    dtype,
    progress_callback: (event) => {
      const progress = Number.isFinite(event.progress) ? event.progress / 100 : null;
      const label = event.file ? `Downloading ${event.file}` : "Loading transcription model…";
      report({ phase: "model", message: label, progress });
    },
  });
  loadedModelConfiguration = configuration;
  report({ phase: "model", message: "Transcription model ready", progress: 1 });
  return transcriber;
}

self.onmessage = async (event) => {
  if (event.data?.type !== "transcribe") return;
  const { audio, modelKey, modelId, modelFamily, device, dtype, recordingSourceOffsetSeconds } = event.data;
  try {
    const recognize = await loadModel(modelId, device, dtype);
    const chunkFrames = SAMPLE_RATE * CHUNK_SECONDS;
    const totalChunks = Math.max(1, Math.ceil(audio.length / chunkFrames));
    const textParts = [];
    const segments = [];

    for (let index = 0; index < totalChunks; index += 1) {
      const firstFrame = index * chunkFrames;
      const lastFrame = Math.min(audio.length, firstFrame + chunkFrames);
      // Whisper expects fixed 30-second windows, while Moonshine was designed
      // for variable-duration input. Padding Moonshine would waste compute and
      // discard one of its main advantages on mobile hardware.
      let chunk;
      if (modelFamily === "moonshine") {
        chunk = audio.slice(firstFrame, lastFrame);
      } else {
        chunk = new Float32Array(chunkFrames);
        chunk.set(audio.subarray(firstFrame, lastFrame));
      }
      report({
        phase: "transcribing",
        message: `Transcribing part ${index + 1} of ${totalChunks}…`,
        progress: index / totalChunks,
      });
      // Innercast already owns deterministic chunk-to-mic/source timing. Avoid
      // Whisper's timestamp token decoder here; it is unnecessary and has been
      // less reliable for short Base-model input in Mobile Safari.
      const result = await recognize(chunk);
      const chunkStartSeconds = firstFrame / SAMPLE_RATE;
      const text = (result.text || "").trim();
      if (text) textParts.push(text);

      if (text) {
        segments.push({
          text,
          micTimestampSeconds: chunkStartSeconds,
          sourceTimestampSeconds: recordingSourceOffsetSeconds + chunkStartSeconds,
          endMicTimestampSeconds: lastFrame / SAMPLE_RATE,
        });
      }
    }

    report({ phase: "transcribing", message: "Transcription complete", progress: 1 });
    self.postMessage({
      type: "complete",
      transcription: {
        text: textParts.join(" ").trim(),
        language: "en",
        provider: modelFamily === "moonshine" ? "moonshine-transformers-js" : "whisper-transformers-js",
        model: modelKey,
        modelId,
        device,
        createdAt: new Date().toISOString(),
        segments,
        errorMessage: null,
      },
    });
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || String(error) });
  }
};
