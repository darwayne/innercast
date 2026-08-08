import { parseTimestamp, sourceTimeForMicTime, validateOffset } from "../app/timestamp.js";
import { isLikelyAudioFile } from "../app/file-types.js";
import { WHISPER_MODELS } from "../app/whisper-transcriber.js";

const tests = [
  ["parse seconds", () => equal(parseTimestamp("30"), 30)],
  ["parse seconds above one minute", () => equal(parseTimestamp("90"), 90)],
  ["parse MM:SS", () => equal(parseTimestamp("1:30"), 90)],
  ["parse HH:MM:SS", () => equal(parseTimestamp("01:05:30"), 3930)],
  ["map mic zero to source offset", () => equal(sourceTimeForMicTime(330, 0), 330)],
  ["map mic 10 to source time", () => equal(sourceTimeForMicTime(330, 10), 340)],
  ["map fractional mic time", () => equal(sourceTimeForMicTime(330, 120.5), 450.5)],
  ["reject malformed timestamps", () => throws(() => parseTimestamp("1:70"))],
  ["reject negative timestamps", () => throws(() => parseTimestamp("-2"))],
  ["reject offset equal to duration", () => throws(() => validateOffset(100, 100))],
  ["reject offset beyond duration", () => throws(() => validateOffset(101, 100))],
  ["accept FLAC with a generic MIME type", () => equal(isLikelyAudioFile({ name: "journey.flac", type: "application/octet-stream" }), true)],
  ["accept AAC with no MIME type", () => equal(isLikelyAudioFile({ name: "journey.AAC", type: "" }), true)],
  ["accept browser-reported audio MIME types", () => equal(isLikelyAudioFile({ name: "unknown", type: "audio/x-flac" }), true)],
  ["reject unrelated generic files", () => equal(isLikelyAudioFile({ name: "notes.pdf", type: "application/octet-stream" }), false)],
  ["offer the tiny English Whisper model", () => equal(WHISPER_MODELS.tiny.id, "onnx-community/whisper-tiny.en")],
  ["offer the base English Whisper model", () => equal(WHISPER_MODELS.base.id, "onnx-community/whisper-base.en")],
];

function equal(actual, expected) { if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`); }
function throws(fn) { try { fn(); } catch { return; } throw new Error("expected function to throw"); }

const results = document.querySelector("#results");
let passed = 0;
for (const [name, test] of tests) {
  const item = document.createElement("li");
  try { test(); item.className = "pass"; item.textContent = `✓ ${name}`; passed += 1; }
  catch (error) { item.className = "fail"; item.textContent = `✗ ${name}: ${error.message}`; }
  results.append(item);
}
document.querySelector("#summary").innerHTML = `<strong>${passed}/${tests.length}</strong> tests passed.`;
document.title = passed === tests.length ? "PASS — Innercast tests" : "FAIL — Innercast tests";
