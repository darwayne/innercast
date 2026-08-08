// Moonshine v2 is not implemented by Transformers.js yet. Run its published
// ONNX graphs directly so Innercast can keep inference browser-only.
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.wasm.min.mjs";
import { ChunkedModelCache } from "./model-cache.js?v=10";

const ORT_ASSET_ROOT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const MODEL_HOST = "https://huggingface.co";
const SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 15;
const BOS_TOKEN = 1;
const EOS_TOKEN = 2;
const MAX_NEW_TOKENS = 256;

ort.env.wasm.wasmPaths = ORT_ASSET_ROOT;
// Innercast's dependency-free static server does not add the cross-origin
// isolation headers required for SharedArrayBuffer-backed WASM threads.
ort.env.wasm.numThreads = 1;

function report(detail) { self.postMessage({ type: "progress", detail }); }

const cache = new ChunkedModelCache(({ file, loaded, total, progress }) => {
  const loadedMB = (loaded / (1024 * 1024)).toFixed(0);
  const totalLabel = total ? ` of ${(total / (1024 * 1024)).toFixed(0)} MB` : " MB";
  report({ phase: "model", message: `Saving ${file} safely… ${loadedMB}${totalLabel}`, progress });
});

function assetUrl(modelId, revision, filename) {
  return `${MODEL_HOST}/${modelId}/resolve/${revision}/${filename}`;
}

async function readCachedAsset(url, label) {
  report({ phase: "model", message: `Preparing ${label}…`, progress: null });
  const response = await cache.match(url);
  if (!response) throw new Error(`The ${label} file was not found.`);
  return response.arrayBuffer();
}

async function createSession(url, label) {
  const bytes = await readCachedAsset(url, label);
  try {
    return await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  } catch (error) {
    throw new Error(`Safari could not load the ${label}. It may have run out of memory. ${error?.message || error}`);
  }
}

async function loadModel(request) {
  const root = (filename) => assetUrl(request.modelId, request.revision, filename);
  const tokenizerBytes = await readCachedAsset(root("tokenizer.json"), "Moonshine tokenizer");
  const tokenizerJson = JSON.parse(new TextDecoder().decode(tokenizerBytes));
  const encoder = await createSession(root("encoder_model_quantized.onnx"), "Moonshine encoder");
  const decoder = await createSession(root("decoder_model_merged_quantized.onnx"), "Moonshine decoder");
  report({ phase: "model", message: "Moonshine v2 model ready", progress: 1 });
  return { encoder, decoder, tokenizerJson };
}

function padAudio(audio) {
  const paddedLength = Math.max(80, Math.ceil(audio.length / 80) * 80);
  if (paddedLength === audio.length) return audio;
  const padded = new Float32Array(paddedLength);
  padded.set(audio);
  return padded;
}

function emptyCacheTensor(request) {
  return new ort.Tensor("float32", new Float32Array(0), [1, request.attentionHeads, 0, request.headDimension]);
}

function decoderFeeds(request, decoder, encoderHiddenStates, token, caches, useCache) {
  const feeds = {};
  for (const name of decoder.inputNames) {
    // The split export calls this decoder_input_ids; the memory-saving merged
    // export currently calls it input_ids. Support both graph contracts.
    if (name === "decoder_input_ids" || name === "input_ids") {
      feeds[name] = new ort.Tensor("int64", BigInt64Array.of(BigInt(token)), [1, 1]);
    } else if (name === "encoder_hidden_states") {
      feeds[name] = encoderHiddenStates;
    } else if (name === "use_cache_branch") {
      feeds[name] = new ort.Tensor("bool", Uint8Array.of(useCache ? 1 : 0), [1]);
    } else if (name.startsWith("past_key_values.")) {
      feeds[name] = caches.get(name) || emptyCacheTensor(request);
    }
  }
  return feeds;
}

function outputFor(session, outputs, preferredName, fallbackIndex) {
  return outputs[preferredName] || outputs[session.outputNames[fallbackIndex]];
}

function nextToken(logits) {
  const vocabularySize = logits.dims[logits.dims.length - 1];
  const start = logits.data.length - vocabularySize;
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let index = 0; index < vocabularySize; index += 1) {
    const value = logits.data[start + index];
    if (value > bestValue) { bestValue = value; bestIndex = index; }
  }
  return bestIndex;
}

function updateCaches(decoder, outputs, caches, preserveEncoderCache) {
  for (const outputName of decoder.outputNames) {
    if (!outputName.startsWith("present.")) continue;
    const inputName = outputName.replace(/^present\./, "past_key_values.");
    if (preserveEncoderCache && inputName.includes(".encoder.") && caches.has(inputName)) continue;
    if (outputs[outputName]) caches.set(inputName, outputs[outputName]);
  }
}

function decodeTokens(tokenizerJson, tokenIds) {
  const pieces = [];
  for (const [piece, id] of Object.entries(tokenizerJson.model.vocab)) pieces[id] = piece;
  const bytes = [];
  const encoder = new TextEncoder();
  for (const id of tokenIds) {
    if (id <= EOS_TOKEN) continue;
    const piece = String(pieces[id] || "").replaceAll("▁", " ");
    const byteFallback = piece.match(/^<0x([0-9A-Fa-f]{2})>$/);
    if (byteFallback) bytes.push(Number.parseInt(byteFallback[1], 16));
    else bytes.push(...encoder.encode(piece));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes)).replace(/^ /, "").trim();
}

async function transcribeChunk(request, model, audio) {
  const padded = padAudio(audio);
  const attentionMask = new BigInt64Array(padded.length);
  attentionMask.fill(1n);
  const encoderOutputs = await model.encoder.run({
    input_values: new ort.Tensor("float32", padded, [1, padded.length]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, padded.length]),
  });
  const encoderHiddenStates = outputFor(model.encoder, encoderOutputs, "last_hidden_state", 0);
  if (!encoderHiddenStates) throw new Error("Moonshine encoder did not return hidden states.");

  const caches = new Map();
  const tokenIds = [];
  let token = BOS_TOKEN;
  for (let step = 0; step < MAX_NEW_TOKENS; step += 1) {
    const useCache = step > 0;
    const outputs = await model.decoder.run(
      decoderFeeds(request, model.decoder, encoderHiddenStates, token, caches, useCache),
    );
    token = nextToken(outputFor(model.decoder, outputs, "logits", 0));
    if (token === EOS_TOKEN) break;
    tokenIds.push(token);
    // Merged Moonshine decoders emit invalid cross-attention cache values on
    // their cached branch, so retain the encoder cache created on step zero.
    updateCaches(model.decoder, outputs, caches, useCache);
  }
  return decodeTokens(model.tokenizerJson, tokenIds);
}

self.onmessage = async (event) => {
  if (event.data?.type !== "transcribe") return;
  const request = event.data;
  let model;
  try {
    model = await loadModel(request);
    const chunkFrames = SAMPLE_RATE * CHUNK_SECONDS;
    const totalChunks = Math.max(1, Math.ceil(request.audio.length / chunkFrames));
    const textParts = [];
    const segments = [];
    for (let index = 0; index < totalChunks; index += 1) {
      const firstFrame = index * chunkFrames;
      const lastFrame = Math.min(request.audio.length, firstFrame + chunkFrames);
      report({
        phase: "transcribing",
        message: `Transcribing part ${index + 1} of ${totalChunks}…`,
        progress: index / totalChunks,
      });
      const text = await transcribeChunk(request, model, request.audio.slice(firstFrame, lastFrame));
      if (text) {
        textParts.push(text);
        const micTimestampSeconds = firstFrame / SAMPLE_RATE;
        segments.push({
          text,
          micTimestampSeconds,
          sourceTimestampSeconds: request.recordingSourceOffsetSeconds + micTimestampSeconds,
          endMicTimestampSeconds: lastFrame / SAMPLE_RATE,
        });
      }
    }
    report({ phase: "transcribing", message: "Transcription complete", progress: 1 });
    self.postMessage({
      type: "complete",
      transcription: {
        text: textParts.join(" ").trim(), language: "en",
        provider: "moonshine-v2-onnxruntime-web",
        model: request.modelKey, modelId: request.modelId, device: "wasm",
        createdAt: new Date().toISOString(), segments, errorMessage: null,
      },
    });
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || String(error) });
  } finally {
    await model?.encoder?.release().catch(() => {});
    await model?.decoder?.release().catch(() => {});
  }
};
