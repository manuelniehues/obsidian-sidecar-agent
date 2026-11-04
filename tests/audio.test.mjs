// Voice input helpers (src/audio.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript, encodeWav, isRetryableStatus, pickTranscribeModel, rankTranscribeModels } from "../src/audio.js";

test("voice input: newest full Flash model, stable before preview, no TTS/image/live variants", () => {
  const names = [
    "models/gemini-2.5-flash",
    "models/gemini-2.5-flash-lite",
    "models/gemini-3.5-flash-preview-09-2026",
    "models/gemini-3.5-flash",
    "models/gemini-3.5-flash-lite",
    "models/gemini-3.8-flash-lite-tts",
    "models/gemini-4.0-flash-image",
    "models/gemini-3.5-pro",
    "models/text-embedding-004",
  ];
  assert.equal(pickTranscribeModel(names), "gemini-3.5-flash");
  assert.equal(pickTranscribeModel(["models/gemini-3.5-flash-lite"]), "gemini-3.5-flash-lite");
  assert.equal(pickTranscribeModel([]), "");
});

test("voice input: WAV header and samples", () => {
  const buf = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44 + 8);
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 0, 4)), "RIFF");
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getInt16(46, true), 0x7fff);
  assert.equal(v.getInt16(48, true), -0x8000);
  assert.equal(v.getInt16(50, true), 0x7fff); // clipped
});

test("voice input: transcript becomes one line", () => {
  assert.equal(cleanTranscript("Hallo Claude.\nBitte lies die Notiz.\n"), "Hallo Claude. Bitte lies die Notiz.");
  assert.equal(cleanTranscript("```\nText\n```"), "Text");
  assert.equal(cleanTranscript(""), "");
});

test("voice input: fallback order and retryable errors", () => {
  const names = ["models/gemini-3.8-flash", "models/gemini-3.5-flash", "models/gemini-3.8-flash-tts", "models/gemini-3.7-flash", "models/gemini-flash-latest"];
  assert.deepEqual(rankTranscribeModels(names), ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"]);
  assert.ok(isRetryableStatus(503) && isRetryableStatus(429) && isRetryableStatus(404));
  assert.ok(!isRetryableStatus(400) && !isRetryableStatus(403));
});
