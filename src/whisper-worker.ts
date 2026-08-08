// Browser worker counterpart to whisper-transcriber.ts. The checked-in app/
// JavaScript is served directly so Innercast needs no local build toolchain.
import { env, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
import type { WhisperModelKey, WhisperTranscript } from "./whisper-transcriber.js";

env.useBrowserCache = true;
env.allowLocalModels = false;

const SAMPLE_RATE = 16_000;
const CHUNK_FRAMES = SAMPLE_RATE * 30;

interface TranscriptionRequest {
  type: "transcribe";
  audio: Float32Array;
  modelKey: WhisperModelKey;
  modelId: string;
  recordingSourceOffsetSeconds: number;
}

let loadedModelId: string | null = null;
let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null;

self.onmessage = async (event: MessageEvent<TranscriptionRequest>) => {
  const request = event.data;
  if (request.type !== "transcribe") return;
  try {
    if (!transcriber || loadedModelId !== request.modelId) {
      transcriber = await pipeline("automatic-speech-recognition", request.modelId, { device: "wasm", dtype: "q8" });
      loadedModelId = request.modelId;
    }
    const textParts: string[] = [];
    const segments: WhisperTranscript["segments"] = [];
    const total = Math.max(1, Math.ceil(request.audio.length / CHUNK_FRAMES));
    for (let index = 0; index < total; index += 1) {
      const first = index * CHUNK_FRAMES;
      const last = Math.min(request.audio.length, first + CHUNK_FRAMES);
      const chunk = new Float32Array(CHUNK_FRAMES);
      chunk.set(request.audio.subarray(first, last));
      const result = await transcriber(chunk);
      const text = String(result.text ?? "").trim();
      if (text) textParts.push(text);
      const micTimestampSeconds = first / SAMPLE_RATE;
      if (text) segments.push({
        text,
        micTimestampSeconds,
        sourceTimestampSeconds: request.recordingSourceOffsetSeconds + micTimestampSeconds,
        endMicTimestampSeconds: last / SAMPLE_RATE,
      });
    }
    const transcription: WhisperTranscript = {
      text: textParts.join(" "), language: "en", provider: "whisper-transformers-js",
      model: request.modelKey, createdAt: new Date().toISOString(), segments, errorMessage: null,
    };
    self.postMessage({ type: "complete", transcription });
  } catch (error) {
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
