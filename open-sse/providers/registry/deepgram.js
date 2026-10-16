export default {
  id: "deepgram",
  priority: 20,
  alias: "deepgram",
  aliases: [
    "dg",
  ],
  uiAlias: "dg",
  display: {
    name: "Deepgram",
    icon: "mic",
    color: "#13EF93",
    textIcon: "DG",
    website: "https://deepgram.com",
    notice: {
      text: "$200 free credit on signup (no card required). Aura-1: $0.015/1k chars, Aura-2: $0.030/1k chars (Pay-As-You-Go).",
      apiKeyUrl: "https://console.deepgram.com/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.deepgram.com/v1/listen",
  },
  models: [
    { id: "voice-agent", name: "Voice Agent (Realtime)", kinds: ["realtime"] },
    { id: "nova-3", name: "Nova 3", params: ["language"], kinds: ["stt", "liveCaption"] },
    { id: "nova-2", name: "Nova 2", params: ["language"], kinds: ["stt", "liveCaption"] },
    { id: "whisper-large", name: "Whisper Large", params: ["language"], kinds: ["stt", "liveCaption"] },
    { id: "nova", name: "Nova", kinds: ["stt", "liveCaption"] },
  ],
  serviceKinds: ["stt", "liveCaption", "realtime"],
  sttConfig: { baseUrl: "https://api.deepgram.com/v1/listen", authType: "apikey", authHeader: "token", format: "deepgram" },
  liveCaptionConfig: { wsUrl: "wss://api.deepgram.com/v1/listen", authType: "apikey", authHeader: "token", format: "deepgram" },
  realtimeConfig: {
    defaultModel: "voice-agent",
    wsUrl: "wss://agent.deepgram.com/v1/agent/converse",
    authType: "apikey",
    authHeader: "Authorization",
    authScheme: "Token",
    audioInRate: 16000,
    audioOutRate: 24000,
    keepAliveMs: 5000,
    // Playground-style option groups for ?listen/?think/?speak overrides on the
    // realtime URL, parsed as <provider.type>/<id> (e.g. think=google/gemini-2.5-flash,
    // speak=open_ai/tts-1/alloy, listen=deepgram/flux-general-en). `provider.*` is the
    // no-override fallback so no query params == today's Settings bytes. Entries:
    // id/name for the UI picker, `settings` only where the agent fragment differs
    // from that plain provider fragment. Non-Deepgram speak providers are BYO TTS:
    // Deepgram requires their speak endpoint/credentials upstream, so choosing one
    // surfaces an upstream Error frame if no key is attached on their side.
    // Custom passthrough: <provider.type>/custom:<raw-id> (validated provider only)
    // — speak groups carry a `customVoice` template whose "@id" placeholder is
    // replaced by the raw id; think/listen build { provider: { type, model } }.
    listen: {
      provider: { type: "deepgram", model: "nova-3" },
      providers: [
        {
          type: "deepgram",
          name: "Deepgram",
          models: [
            { id: "nova-3", name: "Nova 3" },
            { id: "nova-2", name: "Nova 2" },
            // Flux STT runs on provider version v2 (docs: version+model pair).
            { id: "flux-general-en", name: "Flux General (EN)", settings: { provider: { type: "deepgram", version: "v2", model: "flux-general-en" } } },
            { id: "flux-general-multi", name: "Flux General (Multilingual)", settings: { provider: { type: "deepgram", version: "v2", model: "flux-general-multi" } } },
          ],
        },
      ],
    },
    speak: {
      provider: { type: "deepgram", model: "aura-2-thalia-en" },
      providers: [
        {
          type: "deepgram",
          name: "Deepgram",
          voices: [
            // Aura-2 English (docs/tts-models.md "Aura-2 All Available English Voices").
            { id: "aura-2-thalia-en", name: "Thalia" },
            { id: "aura-2-andromeda-en", name: "Andromeda" },
            { id: "aura-2-helena-en", name: "Helena" },
            { id: "aura-2-apollo-en", name: "Apollo" },
            { id: "aura-2-arcas-en", name: "Arcas" },
            { id: "aura-2-aries-en", name: "Aries" },
            { id: "aura-2-amalthea-en", name: "Amalthea" },
            { id: "aura-2-asteria-en", name: "Asteria" },
            { id: "aura-2-athena-en", name: "Athena" },
            { id: "aura-2-atlas-en", name: "Atlas" },
            { id: "aura-2-aurora-en", name: "Aurora" },
            { id: "aura-2-callista-en", name: "Callista" },
            { id: "aura-2-cora-en", name: "Cora" },
            { id: "aura-2-cordelia-en", name: "Cordelia" },
            { id: "aura-2-delia-en", name: "Delia" },
            { id: "aura-2-draco-en", name: "Draco" },
            { id: "aura-2-electra-en", name: "Electra" },
            { id: "aura-2-harmonia-en", name: "Harmonia" },
            { id: "aura-2-hera-en", name: "Hera" },
            { id: "aura-2-hermes-en", name: "Hermes" },
            { id: "aura-2-hyperion-en", name: "Hyperion" },
            { id: "aura-2-iris-en", name: "Iris" },
            { id: "aura-2-janus-en", name: "Janus" },
            { id: "aura-2-juno-en", name: "Juno" },
            { id: "aura-2-jupiter-en", name: "Jupiter" },
            { id: "aura-2-luna-en", name: "Luna" },
            { id: "aura-2-mars-en", name: "Mars" },
            { id: "aura-2-minerva-en", name: "Minerva" },
            { id: "aura-2-neptune-en", name: "Neptune" },
            { id: "aura-2-odysseus-en", name: "Odysseus" },
            { id: "aura-2-ophelia-en", name: "Ophelia" },
            { id: "aura-2-orion-en", name: "Orion" },
            { id: "aura-2-orpheus-en", name: "Orpheus" },
            { id: "aura-2-pandora-en", name: "Pandora" },
            { id: "aura-2-phoebe-en", name: "Phoebe" },
            { id: "aura-2-pluto-en", name: "Pluto" },
            { id: "aura-2-saturn-en", name: "Saturn" },
            { id: "aura-2-selene-en", name: "Selene" },
            { id: "aura-2-theia-en", name: "Theia" },
            { id: "aura-2-vesta-en", name: "Vesta" },
            { id: "aura-2-zeus-en", name: "Zeus" },
            // Aura v1 English (docs/tts-models.md "Aura (v1) English Voices").
            { id: "aura-asteria-en", name: "Asteria (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-asteria-en" } } },
            { id: "aura-luna-en", name: "Luna (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-luna-en" } } },
            { id: "aura-stella-en", name: "Stella (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-stella-en" } } },
            { id: "aura-athena-en", name: "Athena (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-athena-en" } } },
            { id: "aura-hera-en", name: "Hera (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-hera-en" } } },
            { id: "aura-orion-en", name: "Orion (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-orion-en" } } },
            { id: "aura-arcas-en", name: "Arcas (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-arcas-en" } } },
            { id: "aura-perseus-en", name: "Perseus (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-perseus-en" } } },
            { id: "aura-angus-en", name: "Angus (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-angus-en" } } },
            { id: "aura-orpheus-en", name: "Orpheus (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-orpheus-en" } } },
            { id: "aura-helios-en", name: "Helios (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-helios-en" } } },
            { id: "aura-zeus-en", name: "Zeus (Aura v1)", settings: { provider: { type: "deepgram", version: "v1", model: "aura-zeus-en" } } },
            // Flux TTS voice agents (docs/flux-tts/voices.md), speaker version v2.
            { id: "flux-hannah-en", name: "Hannah", settings: { provider: { type: "deepgram", version: "v2", model: "flux-hannah-en" } } },
            { id: "flux-kit-en", name: "Kit", settings: { provider: { type: "deepgram", version: "v2", model: "flux-kit-en" } } },
            { id: "flux-alexis-en", name: "Alexis", settings: { provider: { type: "deepgram", version: "v2", model: "flux-alexis-en" } } },
            { id: "flux-cliff-en", name: "Cliff", settings: { provider: { type: "deepgram", version: "v2", model: "flux-cliff-en" } } },
            { id: "flux-sienna-en", name: "Sienna", settings: { provider: { type: "deepgram", version: "v2", model: "flux-sienna-en" } } },
            { id: "flux-cole-en", name: "Cole", settings: { provider: { type: "deepgram", version: "v2", model: "flux-cole-en" } } },
            { id: "flux-brooke-en", name: "Brooke", settings: { provider: { type: "deepgram", version: "v2", model: "flux-brooke-en" } } },
            { id: "flux-colin-en", name: "Colin", settings: { provider: { type: "deepgram", version: "v2", model: "flux-colin-en" } } },
            { id: "flux-gemma-en", name: "Gemma", settings: { provider: { type: "deepgram", version: "v2", model: "flux-gemma-en" } } },
            { id: "flux-haley-en", name: "Haley", settings: { provider: { type: "deepgram", version: "v2", model: "flux-haley-en" } } },
            { id: "flux-heather-en", name: "Heather", settings: { provider: { type: "deepgram", version: "v2", model: "flux-heather-en" } } },
            { id: "flux-miles-en", name: "Miles", settings: { provider: { type: "deepgram", version: "v2", model: "flux-miles-en" } } },
            { id: "flux-sean-en", name: "Sean", settings: { provider: { type: "deepgram", version: "v2", model: "flux-sean-en" } } },
          ],
          customVoice: { provider: { type: "deepgram", model: "@id" } },
        },
        {
          // Prebuilt premade voice ids (Jessica/Daniel, on record in ElevenLabs
          // communities + provider API); both support eleven_multilingual_v2.
          type: "eleven_labs",
          name: "ElevenLabs",
          voices: [
            { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", settings: { provider: { type: "eleven_labs", model_id: "eleven_multilingual_v2", voice_id: "cgSgspJ2msm6clMCkdW9" } } },
            { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", settings: { provider: { type: "eleven_labs", model_id: "eleven_multilingual_v2", voice_id: "onwK4e9ZLuTAKqWW03F9" } } },
          ],
          customVoice: { provider: { type: "eleven_labs", model_id: "eleven_multilingual_v2", voice_id: "@id" } },
        },
        {
          // Cartesia voice id (sonic-2) as documented on Deepgram's TTS page.
          type: "cartesia",
          name: "Cartesia",
          voices: [
            { id: "a167e0f3-df7e-4d52-a9c3-f949145efdab", name: "Blake", settings: { provider: { type: "cartesia", model_id: "sonic-2", voice: { mode: "id", id: "a167e0f3-df7e-4d52-a9c3-f949145efdab" } } } },
          ],
          customVoice: { provider: { type: "cartesia", model_id: "sonic-2", voice: { mode: "id", id: "@id" } } },
        },
        {
          // OpenAI tts-1 voices; ids keep the <model>/<voice> token so the URL
          // form matches Deepgram's own examples (speak=open_ai/tts-1/alloy).
          type: "open_ai",
          name: "OpenAI",
          voices: [
            { id: "tts-1/alloy", name: "Alloy", settings: { provider: { type: "open_ai", model: "tts-1", voice: "alloy" } } },
            { id: "tts-1/echo", name: "Echo", settings: { provider: { type: "open_ai", model: "tts-1", voice: "echo" } } },
            { id: "tts-1/fable", name: "Fable", settings: { provider: { type: "open_ai", model: "tts-1", voice: "fable" } } },
            { id: "tts-1/onyx", name: "Onyx", settings: { provider: { type: "open_ai", model: "tts-1", voice: "onyx" } } },
            { id: "tts-1/nova", name: "Nova", settings: { provider: { type: "open_ai", model: "tts-1", voice: "nova" } } },
            { id: "tts-1/shimmer", name: "Shimmer", settings: { provider: { type: "open_ai", model: "tts-1", voice: "shimmer" } } },
            { id: "tts-1-hd/alloy", name: "Alloy (HD)", settings: { provider: { type: "open_ai", model: "tts-1-hd", voice: "alloy" } } },
          ],
          customVoice: { provider: { type: "open_ai", model: "tts-1", voice: "@id" } },
        },
        {
          // AWS Polly en-US standard-engine voices (Deepgram requires explicit engine).
          type: "aws_polly",
          name: "AWS Polly",
          voices: [
            { id: "Joanna", name: "Joanna", settings: { provider: { type: "aws_polly", voice: "Joanna", engine: "standard", language_code: "en-US" } } },
            { id: "Matthew", name: "Matthew", settings: { provider: { type: "aws_polly", voice: "Matthew", engine: "standard", language_code: "en-US" } } },
          ],
          customVoice: { provider: { type: "aws_polly", voice: "@id", engine: "standard", language_code: "en-US" } },
        },
      ],
    },
    // Think (LLM) ids are Deepgram's managed catalog, mirrored from their live
    // playground endpoint GET https://agent.deepgram.com/v1/agent/settings/think/models
    // (agent.think.provider = {type, model} — Deepgram runs the built-in providers on
    // their own credentials). Custom LLM only: set thinkUrl + thinkApiKey on the
    // connection. groq/nvidia entries also need the endpoint hop upstream, so they
    // surface a Deepgram Error frame on their own unless that's attached.
    think: {
      provider: { type: "google", model: "gemini-3.1-flash-lite" },
      providers: [
        {
          type: "open_ai",
          name: "OpenAI",
          models: [
            { id: "gpt-4.1", name: "GPT-4.1" },
            { id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
            { id: "gpt-4.1-nano", name: "GPT-4.1 nano" },
            { id: "gpt-4o", name: "GPT-4o" },
            { id: "gpt-4o-mini", name: "GPT-4o mini" },
            { id: "gpt-5", name: "GPT-5" },
            { id: "gpt-5-mini", name: "GPT-5 mini" },
            { id: "gpt-5-nano", name: "GPT-5 nano" },
            { id: "gpt-5.1", name: "GPT-5.1 Thinking" },
            { id: "gpt-5.2", name: "GPT 5.2" },
            { id: "gpt-5.4", name: "GPT 5.4" },
            { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
            { id: "gpt-5.4-nano", name: "GPT-5.4 nano" },
            { id: "gpt-5.5", name: "GPT-5.5" },
            { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
            { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
            { id: "gpt-6-luna", name: "GPT-6 Luna" },
          ],
        },
        {
          type: "anthropic",
          name: "Anthropic",
          models: [
            { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
            { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
            { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
            { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
            { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
          ],
        },
        {
          type: "google",
          name: "Google",
          models: [
            { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
            { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
            { id: "gemini-3-flash-preview", name: "Gemini 3.0 Flash Preview" },
            { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
            { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
            { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
            { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          ],
        },
        {
          // Endpoint hop required upstream (docs); Deepgram-managed playground
          // entries still emit just {type, model}.
          type: "groq",
          name: "Groq",
          models: [
            { id: "openai/gpt-oss-20b", name: "GPT OSS 20B" },
          ],
        },
        {
          type: "nvidia",
          name: "NVIDIA",
          models: [
            { id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B A3B" },
          ],
        },
      ],
    },
  },
};
