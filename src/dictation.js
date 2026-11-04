// Sidecar Agent – voice input: record from the microphone, transcribe with the Gemini API, insert the text.
// Works on every Mac that runs Obsidian (no system speech model needed). The API key lives in Obsidian's
// secret storage (1.11.4+), older versions fall back to the plugin settings.
import { Notice, requestUrl } from "obsidian";
import { t } from "./i18n";
import { cleanTranscript, encodeWav, isRetryableStatus, rankTranscribeModels } from "./audio";

const API = "https://generativelanguage.googleapis.com/v1beta";
export const SECRET_ID = "sidecar-agent-gemini-key";
const RATE = 16000; // Hz, mono: plenty for speech, ~1.9 MB per minute as WAV
const MAX_SECONDS = 600; // inline audio stays well below the 20 MB request limit

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class Dictation {
  constructor(plugin) {
    this.plugin = plugin;
    this.state = "idle"; // idle | recording | transcribing
    this.model = "";
    this.timer = null;
  }

  apiKey() {
    const ss = this.plugin.app.secretStorage;
    return (ss?.getSecret?.(SECRET_ID) || this.plugin.settings.dictationKey || "").trim();
  }

  setState(s) {
    this.state = s;
    this.plugin.trigger("dictation-changed", s);
  }

  async toggle() {
    if (this.hold) return this.stopHold();
    if (this.state === "recording") return this.stop();
    if (this.state === "transcribing") return;
    const s = this.plugin.panel?.active;
    if (s?.st?.agent === "claude" && this.plugin.settings.claudeVoice) return this.startHold(s);
    return this.start();
  }

  /**
   * Claude's own dictation: Claude treats a stream of key repeats of the push-to-talk key (space) as
   * "held" and starts recording; when the repeats stop it transcribes into the prompt line. The button
   * imitates the held key by sending a space every 30 ms (like keyboard auto-repeat) until clicked again.
   */
  startHold(s) {
    if (!s.running || !s.readyAt) {
      new Notice(t("dict.claudeBusy"));
      return;
    }
    if (s.viewMode === "reader") this.plugin.panel?.setViewMode?.(s, "terminal");
    s.term?.focus();
    const tick = () => {
      if (!s.running || this.plugin.panel?.active !== s) return this.stopHold();
      s.input(" ");
    };
    tick();
    this.hold = { s, iv: window.setInterval(tick, 30), max: window.setTimeout(() => this.stopHold(), MAX_SECONDS * 1000) };
    this.setState("recording");
  }

  stopHold() {
    if (!this.hold) return;
    window.clearInterval(this.hold.iv);
    window.clearTimeout(this.hold.max);
    this.hold.s.term?.focus();
    this.hold = null;
    this.setState("idle");
  }

  async start() {
    if (!this.apiKey()) {
      new Notice(t("dict.noKey"), 8000);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      new Notice(t("dict.noMic", { msg: e.message || e.name }), 8000);
      return;
    }
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (ev) => ev.data.size && this.chunks.push(ev.data);
    this.rec.onstop = () => this.finish();
    this.rec.start();
    this.startedAt = Date.now();
    this.timer = window.setTimeout(() => this.stop(), MAX_SECONDS * 1000);
    this.setState("recording");
  }

  stop() {
    window.clearTimeout(this.timer);
    if (this.rec?.state === "recording") this.rec.stop();
  }

  /** Abort without transcribing (plugin unload). */
  cancel() {
    if (this.hold) {
      window.clearInterval(this.hold.iv);
      window.clearTimeout(this.hold.max);
      this.hold = null;
    }
    window.clearTimeout(this.timer);
    if (this.rec) {
      this.rec.onstop = null;
      if (this.rec.state === "recording") this.rec.stop();
    }
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.rec = null;
    this.stream = null;
    this.state = "idle";
  }

  async finish() {
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    const blob = new Blob(this.chunks, { type: this.rec?.mimeType || "audio/webm" });
    this.rec = null;
    if (Date.now() - this.startedAt < 600 || !blob.size) {
      this.setState("idle");
      return;
    }
    this.setState("transcribing");
    try {
      const wav = await this.toWav(blob);
      const text = cleanTranscript(await this.transcribe(wav));
      if (text) await this.plugin.insertIntoTerminal(text + " ");
      else new Notice(t("dict.empty"));
    } catch (e) {
      console.error("Sidecar Agent: dictation failed", e);
      new Notice(t("dict.failed", { msg: e.message || String(e) }), 10000);
    } finally {
      this.setState("idle");
    }
  }

  /** Decode the recording and resample it to 16 kHz mono WAV (a format Gemini accepts for sure). */
  async toWav(blob) {
    const ctx = new AudioContext();
    let audio;
    try {
      audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    } finally {
      ctx.close();
    }
    const frames = Math.ceil(audio.duration * RATE);
    const off = new OfflineAudioContext(1, frames, RATE);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return encodeWav(out.getChannelData(0), RATE);
  }

  /** Models to try in order: the set one, otherwise the last one that worked, then the best Flash models. */
  async candidateModels(key) {
    const set = (this.plugin.settings.dictationModel || "").trim();
    if (set) return [set];
    if (!this.ranked) {
      try {
        const r = await requestUrl({ url: `${API}/models?pageSize=1000`, headers: { "x-goog-api-key": key }, throw: false });
        if (r.status >= 400) throw new Error(r.json?.error?.message || `HTTP ${r.status}`);
        const names = (r.json?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name);
        this.ranked = rankTranscribeModels(names);
      } catch (e) {
        throw new Error(t("dict.keyRejected", { msg: e.message || String(e) }));
      }
    }
    const list = [...new Set([this.model, ...this.ranked.slice(0, 4), "gemini-flash-latest"].filter(Boolean))];
    // overloaded models go to the end for a while
    const now = Date.now();
    const cool = (m) => ((this.cooldown || {})[m] || 0) > now;
    return [...list.filter((m) => !cool(m)), ...list.filter(cool)];
  }

  /** requestUrl has no timeout: give up waiting after ms (the request itself runs out in the background). */
  withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = window.setTimeout(() => resolve({ status: 504, json: { error: { message: t("dict.timeout", { s: Math.round(ms / 1000) }) } } }), ms);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
  }

  async transcribe(wav) {
    const key = this.apiKey();
    const seconds = (wav.byteLength - 44) / (RATE * 2);
    const timeoutMs = (20 + seconds * 0.5) * 1000;
    const vocab = (this.plugin.settings.dictationVocabulary || "").trim();
    const prompt = [
      "Transcribe this audio verbatim in the language that is spoken. Add normal punctuation.",
      "Output only the transcript, no comments, no quotes, no translation.",
      "If nothing is spoken, output nothing.",
      vocab ? `Spell these terms exactly like this when they occur: ${vocab}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "audio/wav", data: toBase64(wav) } }] }],
      generationConfig: { temperature: 0 },
    });
    const errors = [];
    for (const model of await this.candidateModels(key)) {
      const r = await this.withTimeout(
        requestUrl({
          url: `${API}/models/${encodeURIComponent(model)}:generateContent`,
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body,
          throw: false,
        }),
        timeoutMs,
      );
      if (r.status < 400) {
        this.model = model; // keep the one that answered
        const parts = r.json?.candidates?.[0]?.content?.parts || [];
        return parts
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("");
      }
      const msg = r.json?.error?.message || `HTTP ${r.status}`;
      errors.push(`${model}: ${msg}`);
      console.warn(`Sidecar Agent: transcription with ${model} failed (${r.status})`, msg);
      if (model === this.model) this.model = "";
      if (r.status === 429 || r.status >= 500) (this.cooldown ||= {})[model] = Date.now() + 15 * 60000;
      if (!isRetryableStatus(r.status)) break;
    }
    throw new Error(errors.join(" · "));
  }
}
