// The simulated device's voice (Gemini API): reply text → speech, push-to-talk audio → text.
// Server-side so every browser hears the same voice and voice input works without the browser's own
// speech recognition (which only Chrome/Edge ship, and which sends audio to the browser vendor).
// `fetchImpl` is injectable for tests. Key = SPEECH_API_KEY (falls back to GEMINI_API_KEY).
const API = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
export const DEFAULT_STT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_VOICE = "Sulafat";
// No style prefix: measured 2026-10-22, any "say it calmly…" instruction slowed the read 30–90 % and added long pauses;
// the plain text in a warm voice reads at a natural pace.
const MAX_TTS_CHARS = 700;
const MAX_AUDIO_BYTES = 1_500_000;

export function makeSpeech({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const key = env.SPEECH_API_KEY || env.GEMINI_API_KEY || "";
  const ttsModel = env.SPEECH_TTS_MODEL || DEFAULT_TTS_MODEL;
  const sttModel = env.SPEECH_STT_MODEL || DEFAULT_STT_MODEL;
  const voice = env.SPEECH_VOICE || DEFAULT_VOICE;

  async function generate(model, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${API}/${model}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: ctrl.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return { error: `speech_http_${res.status}` };
      return { parts: (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [] };
    } catch (e) {
      return { error: e.name === "AbortError" ? "speech_timeout" : "speech_failed" };
    } finally { clearTimeout(timer); }
  }

  /** → { audio: Buffer, mimeType } (WAV) or { error } */
  async function tts(text) {
    text = text.replace(/\s+/g, " ").trim().slice(0, MAX_TTS_CHARS);
    if (!text) return { error: "empty_text" };
    const out = await generate(ttsModel, {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    });
    if (out.error) return out;
    const inline = out.parts.map((p) => p.inlineData).find(Boolean);
    if (!inline || !inline.data) return { error: "no_audio" };
    const raw = Buffer.from(inline.data, "base64");
    const mime = String(inline.mimeType || "");
    // Older TTS models return bare 16-bit PCM ("audio/L16;codec=pcm;rate=24000"); wrap it so every browser can play it.
    if (/wav/i.test(mime)) return { audio: raw, mimeType: "audio/wav" };
    const rate = Number((/rate=(\d+)/.exec(mime) || [])[1]) || 24000;
    return { audio: Buffer.concat([wavHeader(raw.length, rate), raw]), mimeType: "audio/wav" };
  }

  /** base64 audio (webm/ogg/wav/mp4 from MediaRecorder) → { text } or { error } */
  async function stt(b64, mimeType) {
    if (!b64 || b64.length * 0.75 > MAX_AUDIO_BYTES) return { error: "bad_audio" };
    const mime = /^audio\/[a-z0-9.+-]+/i.exec(mimeType || "")?.[0] || "audio/webm";
    const out = await generate(sttModel, {
      contents: [{ parts: [
        { inline_data: { mime_type: mime, data: b64 } },
        { text: "Transcribe exactly what the speaker says, in English. Output only the words spoken — no quotes, no labels, no description of sounds. If nothing intelligible is said, output nothing." },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400, thinkingConfig: { thinkingLevel: "minimal" } },
    });
    if (out.error) return out;
    const text = out.parts.map((p) => p.text || "").join("").replace(/\s+/g, " ").trim();
    return { text };
  }

  return { configured: Boolean(key), ttsModel, sttModel, voice, tts, stt };
}

export function wavHeader(dataLen, rate, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataLen, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(dataLen, 40);
  return h;
}
