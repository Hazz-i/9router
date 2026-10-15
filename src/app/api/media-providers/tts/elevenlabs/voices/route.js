import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { fetchElevenLabsVoices } from "open-sse/handlers/ttsCore.js";

const langNames = new Intl.DisplayNames(["en"], { type: "language" });

// Dynamic country-specific voice personas mapping to verified free ElevenLabs premade voice IDs
const DYNAMIC_COUNTRY_VOICES = {
  id: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Budi (Pria - Wibawa)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Dewi (Wanita - Lembut)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Bayu (Pria - Santai)", gender: "male", free_users_allowed: true },
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Siti (Wanita - Ramah)", gender: "female", free_users_allowed: true },
    { id: "cjVigY5qzO86Huf0OWal", name: "Rian (Pria - Dinamis)", gender: "male", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Ayu (Wanita - Ceria)", gender: "female", free_users_allowed: true },
  ],
  en: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "George (British - Raspy)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah (American - News)", gender: "female", free_users_allowed: true },
    { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger (American - Confident)", gender: "male", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie (Australian - Casual)", gender: "male", free_users_allowed: true },
    { id: "pqHfZKP75CvOlQylNhV4", name: "Bill (American - Trustworthy)", gender: "male", free_users_allowed: true },
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice (British - Confident)", gender: "female", free_users_allowed: true },
    { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam (American - Articulate)", gender: "male", free_users_allowed: true },
    { id: "nPczCjzI2devNBz1zQrb", name: "Brian (American - Narration)", gender: "male", free_users_allowed: true },
    { id: "iP95p4xoKVk53GoZ742B", name: "Chris (American - Conversational)", gender: "male", free_users_allowed: true },
    { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel (British - Deep News)", gender: "male", free_users_allowed: true },
    { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily (British - Warm)", gender: "female", free_users_allowed: true },
    { id: "bIHbv24MWmeRgasZH58o", name: "Will (American - Friendly)", gender: "male", free_users_allowed: true },
    { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica (American - Playful)", gender: "female", free_users_allowed: true },
    { id: "cjVigY5qzO86Huf0OWal", name: "Eric (American - Casual)", gender: "male", free_users_allowed: true },
    { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda (American - Warm)", gender: "female", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Aria (American - Expressive)", gender: "female", free_users_allowed: true },
    { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura (American - Upbeat)", gender: "female", free_users_allowed: true },
  ],
  ja: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Kenji (男性 - 落ち着いた声)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Aoi (女性 - 優しいナレーション)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Ren (男性 - カジュアル)", gender: "male", free_users_allowed: true },
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Yuki (女性 - 明るく自然)", gender: "female", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Sakura (女性 - 表現力豊か)", gender: "female", free_users_allowed: true },
  ],
  es: [
    { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Mateo (Hombre - Confiado)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sofia (Mujer - Cálida y Clara)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Carlos (Hombre - Casual)", gender: "male", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Lucia (Mujer - Expresiva)", gender: "female", free_users_allowed: true },
    { id: "nPczCjzI2devNBz1zQrb", name: "Diego (Hombre - Narración profunda)", gender: "male", free_users_allowed: true },
  ],
  de: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Lukas (Männlich - Ruhig & Klar)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Greta (Weiblich - Sanft)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Felix (Männlich - Natürlich)", gender: "male", free_users_allowed: true },
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Hannah (Weiblich - Freundlich)", gender: "female", free_users_allowed: true },
  ],
  fr: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Thomas (Homme - Posé & Élégant)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Camille (Femme - Douce & Naturelle)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Antoine (Homme - Dynamique)", gender: "male", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Juliette (Femme - Expressive)", gender: "female", free_users_allowed: true },
  ],
  el: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Nikos (Άνδρας - Ήρεμος & Σταθερός)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Eleni (Γυναίκα - Ζεστή & Εκφραστική)", gender: "female", free_users_allowed: true },
    { id: "nPczCjzI2devNBz1zQrb", name: "Dimitris (Άνδρας - Αφηγηματικός)", gender: "male", free_users_allowed: true },
    { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Sofia (Γυναίκα - Φυσική & Καθαρή)", gender: "female", free_users_allowed: true },
  ],
  zh: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Li Wei (男声 - 沉稳庄重)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Mei Ling (女声 - 温柔自然)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Zhang Hao (男声 - 轻松阳光)", gender: "male", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Xiao Yu (女声 - 生动亲切)", gender: "female", free_users_allowed: true },
  ],
  ar: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Tariq (رجل - فصيح وهادئ)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Fatima (امرأة - دافئة وواضحة)", gender: "female", free_users_allowed: true },
    { id: "nPczCjzI2devNBz1zQrb", name: "Omar (رجل - عميق السرد)", gender: "male", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Layla (امرأة - معبرة)", gender: "female", free_users_allowed: true },
  ],
  ko: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Minho (남성 - 차분하고 신뢰감 있는)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Jiwoo (여성 - 따뜻하고 자연스러운)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Seojun (남성 - 일상 대화체)", gender: "male", free_users_allowed: true },
    { id: "9BWtsMINqrJLrRacOk9x", name: "Yuna (여성 - 표현력 있는)", gender: "female", free_users_allowed: true },
  ],
  it: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Giovanni (Uomo - Calmo e Sicuro)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Chiara (Donna - Calda e Naturale)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Marco (Uomo - Dinamico)", gender: "male", free_users_allowed: true },
  ],
  pt: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Thiago (Masculino - Calmo)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Mariana (Feminino - Suave)", gender: "female", free_users_allowed: true },
    { id: "cjVigY5qzO86Huf0OWal", name: "Gabriel (Masculino - Conversacional)", gender: "male", free_users_allowed: true },
  ],
  ru: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Dmitry (Мужской - Спокойный)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Elena (Женский - Мягкий)", gender: "female", free_users_allowed: true },
    { id: "nPczCjzI2devNBz1zQrb", name: "Ivan (Мужской - Повествовательный)", gender: "male", free_users_allowed: true },
  ],
  hi: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Aarav (पुरुष - शांत और स्पष्ट)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Ananya (महिला - मधुर और स्वाभाविक)", gender: "female", free_users_allowed: true },
    { id: "nPczCjzI2devNBz1zQrb", name: "Kabir (पुरुष - गहरा कथावाचक)", gender: "male", free_users_allowed: true },
  ],
  tr: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Emre (Erkek - Sakin ve Net)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Elif (Kadın - Sıcak ve Doğal)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Burak (Erkek - Günlük)", gender: "male", free_users_allowed: true },
  ],
  vi: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Minh (Nam - Trầm ấm, truyền cảm)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Linh (Nữ - Dịu dàng, tự nhiên)", gender: "female", free_users_allowed: true },
    { id: "IKne3meq5aSn9XLyUdCD", name: "Nam (Nam - Trẻ trung, năng động)", gender: "male", free_users_allowed: true },
  ],
  nl: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Lars (Man - Rustig)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Sanne (Vrouw - Zacht)", gender: "female", free_users_allowed: true },
  ],
  sv: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Magnus (Man - Lugn)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Astrid (Kvinna - Varm)", gender: "female", free_users_allowed: true },
  ],
  fil: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Joshua (Lalaki - Kalmado)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Maria (Babae - Magiliw)", gender: "female", free_users_allowed: true },
  ],
  ms: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Ahmad (Lelaki - Tenang)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Nurul (Perempuan - Lembut)", gender: "female", free_users_allowed: true },
  ],
  th: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Somchai (ชาย - นุ่มนวล)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Kanya (หญิง - อ่อนหวาน)", gender: "female", free_users_allowed: true },
  ],
  pl: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Marek (Mężczyzna - Spokojny)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Zofia (Kobieta - Ciepła)", gender: "female", free_users_allowed: true },
  ],
  cs: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Jan (Muž - Klidný)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Tereza (Žena - Příjemná)", gender: "female", free_users_allowed: true },
  ],
  fi: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Matti (Mies - Rauhallinen)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Aino (Nainen - Luonnollinen)", gender: "female", free_users_allowed: true },
  ],
  da: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Frederik (Mand - Rolig)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Freja (Kvinde - Venlig)", gender: "female", free_users_allowed: true },
  ],
  uk: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Oleksandr (Чоловічий - Впевнений)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Oksana (Жіночий - Лагідна)", gender: "female", free_users_allowed: true },
  ],
  hr: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Luka (Muški - Smiren)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Ana (Ženski - Topla)", gender: "female", free_users_allowed: true },
  ],
  ro: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Andrei (Bărbat - Calm)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Elena (Femeie - Caldă)", gender: "female", free_users_allowed: true },
  ],
  bg: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Georgi (Мъж - Спокоен)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Maria (Жена - Нежна)", gender: "female", free_users_allowed: true },
  ],
  sk: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Peter (Muž - Pokojný)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Zuzana (Žena - Príjemná)", gender: "female", free_users_allowed: true },
  ],
  hu: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Bence (Férfi - Megbízható)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Eszter (Nő - Természetes)", gender: "female", free_users_allowed: true },
  ],
  ta: [
    { id: "JBFqnCBsd6RMkjVDRZzb", name: "Karthik (ஆண் - அமைதியான)", gender: "male", free_users_allowed: true },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Priya (பெண் - மென்மையான)", gender: "female", free_users_allowed: true },
  ],
};

function buildFallbackCatalog() {
  const byLang = {};
  for (const [code, voiceList] of Object.entries(DYNAMIC_COUNTRY_VOICES)) {
    let name = code;
    try {
      name = langNames.of(code) || code;
    } catch {
      name = code;
    }
    byLang[code] = {
      code,
      name,
      voices: voiceList.map((v) => ({
        id: v.id,
        name: v.name,
        gender: v.gender,
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
 * Returns { languages, byLang } grouped dynamically by country/language.
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
        console.warn("[ElevenLabs Voices] API fetch failed, falling back to dynamic catalog:", err.message);
      }
    }

    // If API fetch returned null (e.g. 401 missing permissions) or threw error or had no voices, use dynamic catalog
    if (!voices || !voices.length) {
      const fallback = buildFallbackCatalog();
      if (langFilter) {
        return NextResponse.json({ voices: fallback.byLang[langFilter]?.voices || [] });
      }
      return NextResponse.json(fallback);
    }

    // Group live API voices by verified languages + labels.language
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
    const fallback = buildFallbackCatalog();
    return NextResponse.json(fallback);
  }
}
