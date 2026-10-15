export default {
  id: "elevenlabs",
  alias: "el",
  display: {
    name: "ElevenLabs",
    icon: "record_voice_over",
    color: "#6C47FF",
    textIcon: "EL",
    website: "https://elevenlabs.io",
    notice: {
      apiKeyUrl: "https://elevenlabs.io/app/settings/api-keys"
    }
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: [
    "tts",
    "stt",
    "liveCaption"
  ],
  // Params the Scribe API accepts; mirrored per-model in `models[].params` below,
  // which is what the dashboard example card gates its fields on. The engine reads
  // the incoming request's own fields, so a new scribe model needs only a `models` entry.
  models: [
    {
      id: "scribe_v2",
      name: "Scribe v2 (High Accuracy)",
      params: ["language", "response_format", "timestamps_granularity", "tag_audio_events", "diarize", "num_speakers"],
      kinds: ["stt", "liveCaption"]
    },
    {
      id: "scribe_v2_realtime",
      name: "Scribe v2 Realtime (Live)",
      params: ["language"],
      kinds: ["liveCaption", "stt"]
    },
    {
      id: "scribe_v1",
      name: "Scribe v1 (Legacy)",
      params: ["language", "response_format", "timestamps_granularity", "tag_audio_events", "diarize", "num_speakers"],
      kinds: ["stt", "liveCaption"]
    },
    {
      id: "eleven_flash_v2_5",
      name: "Eleven Flash v2.5 (Fastest, ~75ms)",
      kinds: ["tts"]
    },
    {
      id: "eleven_turbo_v2_5",
      name: "Eleven Turbo v2.5 (High Quality Multilingual)",
      kinds: ["tts"]
    },
    {
      id: "eleven_multilingual_v2",
      name: "Eleven Multilingual v2 (Rich Expressive)",
      kinds: ["tts"]
    },
    {
      id: "eleven_flash_v2",
      name: "Eleven Flash v2 (Fastest English)",
      kinds: ["tts"]
    },
    {
      id: "eleven_turbo_v2",
      name: "Eleven Turbo v2 (English)",
      kinds: ["tts"]
    },
    {
      id: "eleven_monolingual_v1",
      name: "Eleven Monolingual v1 (English Legacy)",
      kinds: ["tts"]
    },
  ],
  liveCaptionConfig: {
    wsUrl: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
    defaultModel: "scribe_v2_realtime",
    authType: "apikey",
    authHeader: "xi-api-key",
    format: "elevenlabs-scribe",
  },
  ttsConfig: {
    baseUrl: "https://api.elevenlabs.io/v1/text-to-speech",
    defaultModel: "eleven_flash_v2_5",
    authType: "apikey",
    authHeader: "xi-api-key",
    format: "elevenlabs",
    models: [
      {
        id: "eleven_flash_v2_5",
        name: "Flash v2.5 (Fastest, ~75ms)"
      },
      {
        id: "eleven_turbo_v2_5",
        name: "Turbo v2.5 (High Quality Multilingual)"
      },
      {
        id: "eleven_multilingual_v2",
        name: "Multilingual v2 (Rich Expressive)"
      },
      {
        id: "eleven_flash_v2",
        name: "Flash v2 (Fastest English)"
      },
      {
        id: "eleven_turbo_v2",
        name: "Turbo v2 (English)"
      },
      {
        id: "eleven_monolingual_v1",
        name: "Monolingual v1 (English Legacy)"
      }
    ]
  },
  sttConfig: {
    baseUrl: "https://api.elevenlabs.io/v1/speech-to-text",
    authType: "apikey",
    authHeader: "xi-api-key",
    format: "elevenlabs-stt",
    // OpenAI response_format → Scribe `additional_formats[].format`. Requests the
    // matching extra render alongside the JSON body; the engine then serves it.
    responseFormats: { segments: "seg_json", subtitles: "srt", captions: "vtt" }
  }
}
