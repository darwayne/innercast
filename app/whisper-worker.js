// Pinned so an Innercast release always uses the same inference runtime.
// The runtime and selected model are fetched only for optional transcription;
// inference itself happens inside this worker and audio is never uploaded.
import { env, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.useBrowserCache = true;
env.allowLocalModels = false;

const SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 30;
let loadedModelId = null;
let transcriber = null;

function report(detail) { self.postMessage({ type: "progress", detail }); }

async function loadModel(modelId) {
  if (transcriber && loadedModelId === modelId) return transcriber;
  if (transcriber?.dispose) await transcriber.dispose();
  transcriber = null;
  loadedModelId = null;
  report({ phase: "model", message: "Loading Whisper model…", progress: 0 });
  transcriber = await pipeline("automatic-speech-recognition", modelId, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (event) => {
      const progress = Number.isFinite(event.progress) ? event.progress / 100 : null;
      const label = event.file ? `Downloading ${event.file}` : "Loading Whisper model…";
      report({ phase: "model", message: label, progress });
    },
  });
  loadedModelId = modelId;
  report({ phase: "model", message: "Whisper model ready", progress: 1 });
  return transcriber;
}

self.onmessage = async (event) => {
  if (event.data?.type !== "transcribe") return;
  const { audio, modelKey, modelId, recordingSourceOffsetSeconds } = event.data;
  try {
    const recognize = await loadModel(modelId);
    const chunkFrames = SAMPLE_RATE * CHUNK_SECONDS;
    const totalChunks = Math.max(1, Math.ceil(audio.length / chunkFrames));
    const textParts = [];
    const segments = [];

    for (let index = 0; index < totalChunks; index += 1) {
      const firstFrame = index * chunkFrames;
      const lastFrame = Math.min(audio.length, firstFrame + chunkFrames);
      // Whisper was trained on fixed 30-second windows. Explicit zero-padding
      // matters for very short recordings, where Base can otherwise classify
      // clear speech as silence even though Tiny returns text.
      const chunk = new Float32Array(chunkFrames);
      chunk.set(audio.subarray(firstFrame, lastFrame));
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
        provider: "whisper-transformers-js",
        model: modelKey,
        createdAt: new Date().toISOString(),
        segments,
        errorMessage: null,
      },
    });
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || String(error) });
  }
};
