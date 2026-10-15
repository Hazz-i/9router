import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { fetchElevenLabsVoices } from "open-sse/handlers/ttsCore.js";

const langNames = new Intl.DisplayNames(["en"], { type: "language" });

// Standard official ElevenLabs premade voices available to all accounts (including free tier)
const PREMADE_ELEVENLABS_VOICES = [
  { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George (Raspy British)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah (Soft News)", labels: { gender: "female", language: "en" }, category: "premade" },
  { voice_id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger (Confident)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "IKne3meq5aSn9XLyUdCD", name: "Charlie (Casual)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "pqHfZKP75CvOlQylNhV4", name: "Bill (Trustworthy)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice (Confident British)", labels: { gender: "female", language: "en" }, category: "premade" },
  { voice_id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam (Articulate)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "nPczCjzI2devNBz1zQrb", name: "Brian (Deep Narration)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "iP95p4xoKVk53GoZ742B", name: "Chris (Conversational)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel (Deep News)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily (Warm British)", labels: { gender: "female", language: "en" }, category: "premade" },
  { voice_id: "bIHbv24MWmeRgasZH58o", name: "Will (Friendly)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "cgSgspJ2msm6clMCkdW9", name: "Jessica (Playful)", labels: { gender: "female", language: "en" }, category: "premade" },
  { voice_id: "cjVigY5qzO86Huf0OWal", name: "Eric (Conversational)", labels: { gender: "male", language: "en" }, category: "premade" },
  { voice_id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (Warm)", labels: { gender: "female", language: "en" }, category: "premade" },
  { voice_id: "9BWtsMINqrJLrRacOk9x", name: "Aria (Expressive)", labels: { gender: "female", language: "en" }, category: "premade" },
  { voice_id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura (Upbeat)", labels: { gender: "female", language: "en" }, category: "premade" },
];

// Multilingual v2 and Flash v2.5 supported language codes
const SUPPORTED_LANG_CODES = [
  "en", "id", "ja", "zh", "ko", "es", "fr", "de", "pt", "ru", "it",
  "ar", "hi", "vi", "th", "nl", "pl", "tr", "sv", "fil", "ms", "uk",
  "el", "cs", "fi", "ro", "da", "bg", "hr", "sk", "ta", "hu"
];

function buildFallbackCatalog() {
  const byLang = {};
  for (const code of SUPPORTED_LANG_CODES) {
    let name = code;
    try {
      name = langNames.of(code) || code;
    } catch {
      name = code;
    }
    byLang[code] = {
      code,
      name,
      voices: PREMADE_ELEVENLABS_VOICES.map((v) => ({
        id: v.voice_id,
        name: v.name,
        gender: v.labels?.gender || "",
        lang: code,
        free_users_allowed: true,
      })),
    };
  }
  const languages = Object.values(byLang).sort((a, b) => a.name.localeCompare(b.name));
  return { languages, byLang, isFallback: true };
}

/**
 * GET /api/media-providers/tts/elevenlabs/voices[?lang=en]
 * Returns { languages, byLang } grouped by language - same format as edge-tts
 * If ElevenLabs API returns 401 (e.g. missing voices_read scope on restricted API keys),
 * automatically falls back to default premade voices so the UI never breaks.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const langFilter = searchParams.get("lang");

    const connections = await getProviderConnections({ provider: "elevenlabs", isActive: true });
    const apiKey = connections[0]?.apiKey;

    let voices = null;
    if (apiKey) {
      try {
        voices = await fetchElevenLabsVoices(apiKey);
      } catch (err) {
        console.warn("[ElevenLabs Voices] API fetch failed, falling back to premade catalog:", err.message);
      }
    }

    // If API fetch returned null (e.g. 401 missing permissions) or threw error or had no voices, use fallback catalog
    if (!voices || !voices.length) {
      const fallback = buildFallbackCatalog();
      if (langFilter) {
        return NextResponse.json({ voices: fallback.byLang[langFilter]?.voices || [] });
      }
      return NextResponse.json(fallback);
    }

    // Group by all supported languages (verified_languages + labels.language)
    const byLang = {};
    const addToLang = (code, voice) => {
      if (!byLang[code]) {
        byLang[code] = {
          code,
          name: (() => { try { return langNames.of(code); } catch { return code; } })(),
          voices: [],
        };
      }
      if (!byLang[code].voices.find((v) => v.id === voice.voice_id)) {
        byLang[code].voices.push({
          id: voice.voice_id,
          name: voice.name,
          gender: voice.labels?.gender || "",
          lang: code,
          free_users_allowed: voice.category === "premade" || voice.is_owner === true,
        });
      }
    };

    for (const v of voices) {
      const primaryLang = v.labels?.language || "en";
      addToLang(primaryLang, v);
      for (const vl of v.verified_languages || []) {
        if (vl.language && vl.language !== primaryLang) {
          addToLang(vl.language, v);
        }
      }
    }

    const languages = Object.values(byLang).sort((a, b) => a.name.localeCompare(b.name));

    if (langFilter) {
      return NextResponse.json({ voices: byLang[langFilter]?.voices || [] });
    }

    return NextResponse.json({ languages, byLang });
  } catch (err) {
    console.error("[ElevenLabs Voices Route] Error:", err);
    // Even in severe errors, return fallback catalog so user is never locked out
    const fallback = buildFallbackCatalog();
    return NextResponse.json(fallback);
  }
}
