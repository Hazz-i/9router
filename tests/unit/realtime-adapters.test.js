// Translation-logic unit tests for the Deepgram Voice Agent
// /v1/realtime adapter, with injected fake upstream sockets (same
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


import { createDeepgramAdapter } from "@/sse/handlers/realtime/deepgramAdapter.js";
import deepgramRegistry from "open-sse/providers/registry/deepgram.js";

// flush pending microtasks + queued macrotasks (FakeWS opens in a microtask)
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  FakeWS.instances.length = 0;
});

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
    config: overrides.config ?? DG_CONFIG,
    provider: overrides.provider ?? "deepgram",
    model: overrides.model ?? "voice-agent",
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
