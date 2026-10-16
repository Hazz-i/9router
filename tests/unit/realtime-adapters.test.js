// Translation-logic unit tests for the ElevenLabs ConvAI and Deepgram Voice
// Agent /v1/realtime adapters, with injected fake upstream sockets (same
// FakeWS pattern as gemini-realtime-wire.test.js / gemini-live-stt.test.js).
// Wire observables only: client audio → correct upstream frame; upstream
// event → correct OpenAI client event; binary upstream frame → audio delta;
// ping → pong; missing agent_id / think credentials → clear error.
import { describe, it, expect, afterEach, vi } from "vitest";

const { FakeWS } = vi.hoisted(() => {
  class FakeWS {
    static instances = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.sent = []; // data frames in send order (parsed if JSON)
      this.readyState = FakeWS.CONNECTING;
      this.closed = false;
      this.closeCalls = [];
      this._listeners = {};
      FakeWS.instances.push(this);
      queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = FakeWS.OPEN;
        (this._listeners.open || []).forEach((f) => f({}));
      });
    }

    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }

    on(type, fn) {
      this.addEventListener(type, fn);
    }

    send(data) {
      this.sent.push(
        typeof data === "string" ? JSON.parse(data) : Buffer.from(data)
      );
    }

    // Fire a server text frame (JSON) through the message handler the way `ws` does.
    emit(obj) {
      (this._listeners.message || []).forEach((f) => f(JSON.stringify(obj), false));
    }

    // Fire a server BINARY frame (raw bytes, not JSON).
    emitBinary(bytes) {
      (this._listeners.message || []).forEach((f) => f(Buffer.from(bytes), true));
    }

    emitClose(code = 1000) {
      this.closed = true;
      this.readyState = FakeWS.CLOSED;
      (this._listeners.close || []).forEach((f) => f({ code, reason: "" }));
    }

    close(code, reason) {
      this.closed = true;
      this.readyState = FakeWS.CLOSED;
      this.closeCalls.push({ code, reason });
    }
  }
  return { FakeWS };
});

vi.mock("ws", () => ({
  WebSocket: FakeWS,
  WebSocketServer: class {},
}));


import { createElevenLabsAdapter } from "@/sse/handlers/realtime/elevenlabsAdapter.js";
import { createDeepgramAdapter } from "@/sse/handlers/realtime/deepgramAdapter.js";
import deepgramRegistry from "open-sse/providers/registry/deepgram.js";

// flush pending microtasks + queued macrotasks (FakeWS opens in a microtask)
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  FakeWS.instances.length = 0;
});

const EL_CONFIG = {
  defaultModel: "conv-ai",
  wsUrl: "wss://api.elevenlabs.io/v1/convai/conversation",
  signedUrlEndpoint: "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url",
  authType: "apikey",
  authHeader: "xi-api-key",
  audioInRate: 16000,
  audioOutRate: 16000,
  residencyHosts: {
    global: "api.elevenlabs.io",
    us: "api.us.elevenlabs.io",
    eu: "api.eu.residency.elevenlabs.io",
    in: "api.in.residency.elevenlabs.io",
    sg: "api.sg.residency.elevenlabs.io",
  },
};

const DG_CONFIG = {
  defaultModel: "voice-agent",
  wsUrl: "wss://agent.deepgram.com/v1/agent/converse",
  authType: "apikey",
  authHeader: "Authorization",
  authScheme: "Token",
  audioInRate: 16000,
  audioOutRate: 24000,
  keepAliveMs: 5000,
  listen: { provider: { type: "deepgram", model: "nova-3" } },
  speak: { provider: { type: "deepgram", model: "aura-2-thalia-en" } },
  think: { provider: { type: "open_ai", model: "gpt-4o-mini" } },
};

function mkCtx(overrides = {}) {
  const clientSent = [];
  const ctx = {
    config: overrides.config ?? EL_CONFIG,
    provider: overrides.provider ?? "elevenlabs",
    model: overrides.model ?? "conv-ai",
    voice: "Puck",
    instructions: "base instructions",
    credentials: overrides.credentials ?? {},
    apiKey: overrides.apiKey ?? "TEST-KEY",
    query: overrides.query ?? { get: () => null },
    sendClient: (obj) => clientSent.push(obj),
    closeClient: () => {},
    isClientOpen: () => true,
    countInput: () => {},
    countOutput: overrides.countOutput ?? (() => {}),
    setInputRate: () => {},
    setOutputRate: () => {},
    millisSinceStart: () => 42,
  };
  return { ctx, clientSent };
}

const CLIENT_AUDIO_B64 = Buffer.from("pcm16-input").toString("base64");

function fireClientEvent(adapter, event) {
  adapter.handleClientEvent(event);
}

// ── ElevenLabs ConvAI ─────────────────────────────────────────────────────

describe("ElevenLabs ConvAI adapter", () => {
  it("rejects a connection with a clear error when no agent id is configured", () => {
    const { ctx } = mkCtx();
    expect(() => createElevenLabsAdapter(ctx)).toThrow(/agent id/i);
  });

  it("client audio → user_audio_chunk on the plain agent_id URL when signed-url fails (public agent fallback)", async () => {
    const fetchCalls = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return { ok: false, status: 404 };
    };
    try {
      const { ctx } = mkCtx({
        apiKey: "xi-TEST",
        credentials: { providerSpecificData: { agentId: "AGENT-1" } },
      });
      const adapter = createElevenLabsAdapter(ctx);
      await adapter.connect();
      await settle();
      const ws = FakeWS.instances[0];

      // Signed URL was attempted with xi-api-key header, then fell back
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain("/v1/convai/conversation/get-signed-url");
      expect(fetchCalls[0].opts.headers["xi-api-key"]).toBe("xi-TEST");
      expect(ws.url).toContain("agent_id=AGENT-1");

      // Initiation frame first, then client audio rides user_audio_chunk
      expect(ws.sent[0]).toEqual({ type: "conversation_initiation_client_data" });
      fireClientEvent(adapter, { type: "input_audio_buffer.append", audio: CLIENT_AUDIO_B64 });
      expect(ws.sent[1]).toEqual({ user_audio_chunk: CLIENT_AUDIO_B64 });
    } finally {
      global.fetch = origFetch;
    }
  });

  it("dials the signed_url when the signed-url call succeeds", async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ signed_url: "wss://user-signed.example/&token=tok" }) });
    try {
      const { ctx } = mkCtx({ credentials: { providerSpecificData: { agentId: "AGENT-2" } } });
      const adapter = createElevenLabsAdapter(ctx);
      await adapter.connect();
      await settle();
      expect(FakeWS.instances[0].url).toBe("wss://user-signed.example/&token=tok");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("upstream events map to the OpenAI client contract; formats parsed from metadata; ping → pong", async () => {
    const { ctx, clientSent } = mkCtx({ credentials: { providerSpecificData: { agentId: "AGENT-3" } } });
    const adapter = createElevenLabsAdapter(ctx);
    await adapter.connect();
    await settle();
    const ws = FakeWS.instances[0];

    // readiness → session.created + session.updated (voice omitted: agent-owned)
    ws.emit({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {
      conversation_id: "conv-123", agent_output_audio_format: "pcm_24000", user_input_audio_format: "pcm_16000" } });
    expect(clientSent[0].type).toBe("session.created");
    expect(clientSent[0].session.id).toBeTypeOf("string");
    expect(clientSent[0].session.model).toBe("conv-ai");
    expect("voice" in clientSent[0].session).toBe(false);
    expect(clientSent[1].type).toBe("session.updated");

    // audio → response.audio.delta
    ws.emit({ type: "audio", audio_event: { audio_base_64: "ABA=" } });
    expect(clientSent[2]).toEqual({
      type: "response.audio.delta", response_id: clientSent[2].response_id,
      item_id: clientSent[2].item_id, output_index: 0, content_index: 0, delta: "ABA=",
    });

    // agent_response → response.audio_transcript.delta
    ws.emit({ type: "agent_response", agent_response_event: { agent_response: "Hello there" } });
    expect(clientSent[3]).toEqual({
      type: "response.audio_transcript.delta", response_id: clientSent[2].response_id,
      item_id: clientSent[2].item_id, output_index: 0, content_index: 0, delta: "Hello there",
    });

    // agent_response_complete → response.audio.done + response.done
    ws.emit({ type: "agent_response_complete", agent_response_complete_event: { event_id: 7 } });
    expect(clientSent[4]).toEqual({ type: "response.audio.done", response_id: clientSent[2].response_id, item_id: clientSent[2].item_id });
    expect(clientSent[5]).toEqual({ type: "response.done", response: { id: clientSent[2].response_id, object: "realtime.response", status: "completed" } });

    // interruption → input_audio_buffer.speech_started (+ response.cancelled,
    // with freshly rotated response ids — not the completed turn's)
    ws.emit({ type: "interruption", interruption_event: {} });
    expect(clientSent[6].type).toBe("input_audio_buffer.speech_started");
    expect(clientSent[7].type).toBe("response.cancelled");
    expect(clientSent[7].response_id).not.toBe(clientSent[2].response_id);
    expect(clientSent[6].item_id).not.toBe(clientSent[4].item_id);

    // ping → pong with identical event_id
    ws.emit({ type: "ping", ping_event: { event_id: 99 } });
    expect(ws.sent.find((f) => f.type === "pong")).toEqual({ type: "pong", event_id: 99 });

    // client_error → client error
    ws.emit({ type: "client_error", error_event: { code: 500, error_name: "internal", message: "boom" } });
    expect(clientSent[8]).toEqual({ type: "error", error: { type: "upstream_error", message: "internal (500): boom" } });
  });
});

// ── Deepgram Voice Agent ──────────────────────────────────────────────────

describe("Deepgram Voice Agent adapter", () => {
  it("needs no think credentials — built-in LLM keys are Deepgram's, and no endpoint hop is sent", async () => {
    const { ctx } = mkCtx({ config: DG_CONFIG, provider: "deepgram", model: "voice-agent" });
    const adapter = createDeepgramAdapter(ctx); // must NOT throw without thinkApiKey/thinkUrl
    await adapter.connect();
    await settle();
    const settings = FakeWS.instances[0].sent[0];
    expect(settings.agent.think.provider).toEqual(DG_CONFIG.think.provider);
    expect(settings.agent.think.endpoint).toBeUndefined();
  });

  it("Settings frame is first, uses Token auth, client audio rides raw binary", async () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG,
      provider: "deepgram",
      model: "voice-agent",
      credentials: { providerSpecificData: { thinkApiKey: "sk-LLM", thinkUrl: "https://llm.example/v1/chat" } },
    });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const ws = FakeWS.instances[0];

    expect(ws.url).toBe(DG_CONFIG.wsUrl);
    expect(ws.opts.headers.Authorization).toBe("Token TEST-KEY");

    const settings = ws.sent[0];
    expect(settings.type).toBe("Settings");
    expect(settings.audio).toEqual({
      input: { encoding: "linear16", sample_rate: 16000 },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    });
    expect(settings.agent.listen).toEqual(DG_CONFIG.listen);
    expect(settings.agent.speak).toEqual(DG_CONFIG.speak);
    expect(settings.agent.think.provider).toEqual({ type: "open_ai", model: "gpt-4o-mini" });
    // think key rides the documented endpoint hop
    expect(settings.agent.think.endpoint).toEqual({
      url: "https://llm.example/v1/chat",
      headers: { Authorization: "Bearer sk-LLM" },
    });
    expect(settings.agent.think.prompt).toBe("base instructions");

    // client audio → raw binary frame upstream
    adapter.handleClientAudio(Buffer.from("raw-dg-pcm"));
    expect(Buffer.isBuffer(ws.sent[1])).toBe(true);
    expect(ws.sent[1].toString()).toBe("raw-dg-pcm");
  });

  it("upstream events map to the OpenAI client contract; binary upstream frame → audio delta", async () => {
    const outBytes = [];
    const { ctx, clientSent } = mkCtx({
      config: DG_CONFIG,
      provider: "deepgram",
      model: "voice-agent",
      credentials: { providerSpecificData: { thinkApiKey: "sk-LLM", thinkUrl: "https://llm.example/v1/chat" } },
      countOutput: (n) => outBytes.push(n),
    });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const ws = FakeWS.instances[0];

    // BINARY upstream frame → response.audio.delta (base64)
    ws.emitBinary([1, 2, 3, 4]);
    expect(clientSent[0]).toEqual({
      type: "response.audio.delta", response_id: clientSent[0].response_id,
      item_id: clientSent[0].item_id, output_index: 0, content_index: 0,
      delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    expect(outBytes).toEqual([4]);

    // Welcome (readiness) sends nothing; SettingsApplied → session.created + session.updated
    ws.emit({ type: "Welcome", request_id: "req-1" });
    expect(clientSent).toHaveLength(1);
    ws.emit({ type: "SettingsApplied" });
    expect(clientSent[1].type).toBe("session.created");
    expect(clientSent[1].session.model).toBe("voice-agent");
    expect(clientSent[2].type).toBe("session.updated");

    // ConversationText assistant → transcript delta; user → ignored
    ws.emit({ type: "ConversationText", role: "assistant", content: "Hi, how can I help?" });
    expect(clientSent[3].type).toBe("response.audio_transcript.delta");
    expect(clientSent[3].delta).toBe("Hi, how can I help?");
    ws.emit({ type: "ConversationText", role: "user", content: "hello agent" });
    expect(clientSent).toHaveLength(4);

    // UserStartedSpeaking → speech_started + response.cancelled
    ws.emit({ type: "UserStartedSpeaking" });
    expect(clientSent[4].type).toBe("input_audio_buffer.speech_started");
    expect(clientSent[5]).toEqual({ type: "response.cancelled", response_id: clientSent[0].response_id });

    // AgentAudioDone → response.audio.done + response.done (ids rotate after cancel)
    ws.emit({ type: "AgentAudioDone" });
    expect(clientSent[6].type).toBe("response.audio.done");
    expect(clientSent[7]).toEqual({
      type: "response.done",
      response: { id: clientSent[6].response_id, object: "realtime.response", status: "completed" },
    });
    expect(clientSent[7].response.id).not.toBe(clientSent[0].response_id);

    // Error → client error
    ws.emit({ type: "Error", description: "bad request", code: 400 });
    expect(clientSent[8]).toEqual({ type: "error", error: { type: "upstream_error", message: "400: bad request" } });
  });
});

// ── ElevenLabs residency host selection ───────────────────────────────────

describe("ElevenLabs ConvAI residency", () => {
  const CASES = [
    ["global", "api.elevenlabs.io"],
    ["us", "api.us.elevenlabs.io"],
    ["eu", "api.eu.residency.elevenlabs.io"],
    ["in", "api.in.residency.elevenlabs.io"],
    ["sg", "api.sg.residency.elevenlabs.io"],
  ];

  it.each(CASES)("?region=%s relays the signed-url REST call AND the WS dial through the %s host", async (region, host) => {
    const fetchCalls = [];
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      fetchCalls.push({ url: String(url) });
      return { ok: false, status: 404 };
    };
    try {
      const { ctx } = mkCtx({
        credentials: { providerSpecificData: { agentId: "AGENT-R" } },
        query: new URLSearchParams(`region=${region}`),
      });
      const adapter = createElevenLabsAdapter(ctx);
      await adapter.connect();
      await settle();

      expect(fetchCalls[0].url).toBe(`https://${host}/v1/convai/conversation/get-signed-url?agent_id=AGENT-R`);
      expect(FakeWS.instances[0].url).toBe(`wss://${host}/v1/convai/conversation?agent_id=AGENT-R`);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("dials the signed_url from the response even under a residency host", async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ signed_url: "wss://api.eu.residency.elevenlabs.io/v1/convai/conversation?agent_id=AGENT-R&token=t" }) });
    try {
      const { ctx } = mkCtx({ credentials: { providerSpecificData: { agentId: "AGENT-R", residency: "eu" } } });
      const adapter = createElevenLabsAdapter(ctx);
      await adapter.connect();
      await settle();
      expect(FakeWS.instances[0].url).toContain("api.eu.residency.elevenlabs.io");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("no region anywhere → global default, URLs byte-identical to today", async () => {
    const fetchCalls = [];
    const origFetch = global.fetch;
    global.fetch = async (url) => { fetchCalls.push({ url: String(url) }); return { ok: false, status: 404 }; };
    try {
      const { ctx } = mkCtx({ credentials: { providerSpecificData: { agentId: "AGENT-D" } } });
      const adapter = createElevenLabsAdapter(ctx);
      await adapter.connect();
      await settle();
      expect(fetchCalls[0].url).toContain("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=AGENT-D");
      expect(FakeWS.instances[0].url).toContain("wss://api.elevenlabs.io/v1/convai/conversation?agent_id=AGENT-D");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("unknown region → clear error naming the valid values", () => {
    const { ctx } = mkCtx({
      credentials: { providerSpecificData: { agentId: "AGENT-X" } },
      query: new URLSearchParams("region=mars"),
    });
    expect(() => createElevenLabsAdapter(ctx)).toThrow(/global.*us.*eu.*in.*sg/);
  });
});

// ── Deepgram listen/think/speak/greeting overrides ────────────────────────

describe("Deepgram Voice Agent query-param overrides", () => {
  // Real registry option groups — the units under test. The adapter must strip
  // the grouped `providers`/`customVoice` data the registry carries (it never
  // reaches the upstream Settings frame).
  const DG_CONFIG_WITH_OPTIONS = {
    ...DG_CONFIG,
    listen: deepgramRegistry.realtimeConfig.listen,
    speak: deepgramRegistry.realtimeConfig.speak,
    think: deepgramRegistry.realtimeConfig.think,
  };

  it("no overrides → Settings identical to registry defaults, no greeting", async () => {
    const { ctx } = mkCtx({ config: DG_CONFIG_WITH_OPTIONS, provider: "deepgram", model: "voice-agent" });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const settings = FakeWS.instances[0].sent[0];
    expect(settings.agent.listen).toEqual({ provider: { type: "deepgram", model: "nova-3" } });
    expect(settings.agent.speak).toEqual({ provider: { type: "deepgram", model: "aura-2-thalia-en" } });
    expect(settings.agent.think).toEqual({ prompt: "base instructions", provider: { type: "google", model: "gemini-3.1-flash-lite" } });
    expect("greeting" in settings.agent).toBe(false);
  });

  it("grouped providers offer the registry defaults (and never leak into Settings)", () => {
    const rc = deepgramRegistry.realtimeConfig;
    for (const kind of ["listen", "speak", "think"]) {
      const group = rc[kind].providers.find((g) => g.type === rc[kind].provider.type);
      const entry = (group.models || group.voices || []).find((o) => o.id === rc[kind].provider.model);
      expect(entry).toBeDefined();
    }
    // Every custom voice template carries the @id placeholder the adapter substitutes.
    for (const group of rc.speak.providers) {
      expect(JSON.stringify(group.customVoice)).toContain("@id");
    }
  });

  it("listen/think/speak/greeting overrides land in the Settings frame", async () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG_WITH_OPTIONS,
      provider: "deepgram",
      model: "voice-agent",
      // tts-1/alloy exercises the provider + rest-of-slash id parsing
      query: new URLSearchParams(
        "listen=deepgram/flux-general-multi&think=google/gemini-2.5-flash&speak=open_ai/tts-1/alloy&greeting=Hello%20there!"
      ),
    });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const settings = FakeWS.instances[0].sent[0];

    expect(settings.agent.listen).toEqual({ provider: { type: "deepgram", version: "v2", model: "flux-general-multi" } });
    expect(settings.agent.think.provider).toEqual({ type: "google", model: "gemini-2.5-flash" });
    expect(settings.agent.think.prompt).toBe("base instructions");
    expect(settings.agent.speak).toEqual({ provider: { type: "open_ai", model: "tts-1", voice: "alloy" } });
    expect(settings.agent.greeting).toBe("Hello there!");
  });

  it("eleven_labs speak override uses the playground's model_id/voice_id shape; groq think keeps its slashed model", async () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG_WITH_OPTIONS,
      provider: "deepgram",
      model: "voice-agent",
      query: new URLSearchParams("think=groq/openai/gpt-oss-20b&speak=eleven_labs/cgSgspJ2msm6clMCkdW9"),
    });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const settings = FakeWS.instances[0].sent[0];

    expect(settings.agent.think.provider).toEqual({ type: "groq", model: "openai/gpt-oss-20b" });
    expect(settings.agent.speak).toEqual({
      provider: { type: "eleven_labs", model_id: "eleven_multilingual_v2", voice_id: "cgSgspJ2msm6clMCkdW9" },
    });
  });

  it("custom passthrough: raw id rides the provider's customVoice fragment (speak) / plain provider fragment (think)", async () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG_WITH_OPTIONS,
      provider: "deepgram",
      model: "voice-agent",
      query: new URLSearchParams("speak=eleven_labs/custom:my-cloned-voice&think=open_ai/custom:ft-gpt-5.5-myorg"),
    });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const settings = FakeWS.instances[0].sent[0];

    expect(settings.agent.speak).toEqual({
      provider: { type: "eleven_labs", model_id: "eleven_multilingual_v2", voice_id: "my-cloned-voice" },
    });
    expect(settings.agent.think.provider).toEqual({ type: "open_ai", model: "ft-gpt-5.5-myorg" });
  });

  it("custom passthrough validates the provider against the table", () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG_WITH_OPTIONS,
      provider: "deepgram",
      model: "voice-agent",
      query: new URLSearchParams("speak=minimax/custom:my-voice"),
    });
    expect(() => createDeepgramAdapter(ctx)).toThrow(/Unknown realtime speak choice "minimax\/custom:my-voice".*Valid options:/);
    expect(FakeWS.instances).toHaveLength(0);
  });

  it("unknown provider/id → clear error naming valid options, nothing dialled, no Settings sent", async () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG_WITH_OPTIONS,
      provider: "deepgram",
      model: "voice-agent",
      query: new URLSearchParams("think=google/gpt-9-turbo-nova"),
    });
    expect(() => createDeepgramAdapter(ctx)).toThrow(/Unknown realtime think choice "google\/gpt-9-turbo-nova".*Valid options:.*google\/gemini-3\.1-flash-lite.*groq\/openai\/gpt-oss-20b/s);
    expect(FakeWS.instances).toHaveLength(0);
  });

  it("custom think endpoint from providerSpecificData still rides the override when both are set", async () => {
    const { ctx } = mkCtx({
      config: DG_CONFIG_WITH_OPTIONS,
      provider: "deepgram",
      model: "voice-agent",
      credentials: { providerSpecificData: { thinkApiKey: "sk-LLM", thinkUrl: "https://llm.example/v1/chat" } },
      query: new URLSearchParams("think=open_ai/gpt-4o-mini"),
    });
    const adapter = createDeepgramAdapter(ctx);
    await adapter.connect();
    await settle();
    const settings = FakeWS.instances[0].sent[0];
    expect(settings.agent.think.provider).toEqual({ type: "open_ai", model: "gpt-4o-mini" });
    expect(settings.agent.think.endpoint).toEqual({
      url: "https://llm.example/v1/chat",
      headers: { Authorization: "Bearer sk-LLM" },
    });
  });
});
