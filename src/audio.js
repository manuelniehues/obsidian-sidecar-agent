// Sidecar Agent – pure helpers for voice input (no Obsidian imports, so the tests can load them).

/** General Flash models from the models list, best first (no TTS, image, live or embedding variants). */
export function rankTranscribeModels(names) {
  const ok = [...new Set((names || []).map((n) => n.replace(/^models\//, "")))].filter((id) => /^gemini-[\d.]+-flash(-lite)?(-preview)?(-[\d-]+)?$/.test(id));
  const score = (id) => {
    const ver = parseFloat(id.match(/gemini-([\d.]+)/)[1]) || 0;
    // full Flash before Lite, stable before preview
    return ver * 100 + (/-lite/.test(id) ? 0 : 10) + (/-preview/.test(id) ? 0 : 5);
  };
  return ok.sort((a, b) => score(b) - score(a));
}

/** Newest general Flash model. */
export function pickTranscribeModel(names) {
  return rankTranscribeModels(names)[0] || "";
}

/** Overloaded, rate-limited or gone: worth trying the next model. */
export function isRetryableStatus(status) {
  return status === 429 || status === 404 || status >= 500;
}

/** 16-bit PCM WAV from mono float samples. */
export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Collapse the transcript to one line (a line break would send the message in the terminal). */
export function cleanTranscript(text) {
  return (text || "")
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}
