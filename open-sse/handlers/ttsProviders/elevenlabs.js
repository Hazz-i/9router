// ElevenLabs TTS — voice id with optional model_id prefix
import { Buffer } from "node:buffer";

const VOICES_TTL = 24 * 60 * 60 * 1000;
const _voicesCache = new Map(); // by API key

export async function fetchElevenLabsVoices(apiKey) {
  if (!apiKey) throw new Error("ElevenLabs API key required");
  const now = Date.now();
  const cached = _voicesCache.get(apiKey);
  if (cached && now - cached.time < VOICES_TTL) return cached.voices;

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      // If API key is missing voices_read permission or unauthorized, return null for fallback catalog
      if (res.status === 401 || res.status === 403) {
        return null;
      }
      throw new Error(`ElevenLabs voices fetch failed: ${res.status}`);
    }
    const data = await res.json();
    // Normalize: derive lang from labels for grouping
    const voices = (data.voices || []).map((v) => ({ ...v, lang: v.labels?.language || "en" }));
    _voicesCache.set(apiKey, { voices, time: now });
    return voices;
  } catch (err) {
    if (err.message?.includes("401") || err.message?.includes("403")) {
      return null;
    }
    throw err;
  }
}

export default {
  async synthesize(text, model, credentials) {
    if (!credentials?.apiKey) throw new Error("ElevenLabs API key required");
    let modelId = "eleven_multilingual_v2";
    let voiceId = "JBFqnCBsd6RMkjVDRZzb"; // Default to George (free-tier supported)
    if (model) {
      const clean = model.replace(/^el\//, "").replace(/^elevenlabs\//, "");
      if (clean.includes("/")) {
        const parts = clean.split("/");
        modelId = parts[0] || modelId;
        voiceId = parts[1] || voiceId;
      } else if (clean.startsWith("eleven_")) {
        modelId = clean;
      } else {
        voiceId = clean;
      }
    }

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": credentials.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.detail?.message || `ElevenLabs TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error("ElevenLabs TTS returned empty audio");
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};
