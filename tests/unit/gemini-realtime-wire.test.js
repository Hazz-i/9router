// Gemini Live realtime voice gateway wire contract.
//
// Regression lock: the deprecated `realtimeInput.mediaChunks` field is silently
// ignored by the current API (audio never reaches the model, VAD never fires).
// Locked invariants:
//   - setup frame carries top-level inputAudioTranscription / outputAudioTranscription
//     (siblings of generationConfig, never nested inside it);
//   - client audio rides realtimeInput.audio{mimeType,data} on both the binary
//     and input_audio_buffer.append paths;
//   - the literal "mediaChunks" never appears in any upstream frame.
import { describe, it, expect, afterEach, vi } from "vitest";

const { FakeWS } = vi.hoisted(() => {
  class FakeWS {
    static instances = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.sent = []; // JSON.parsed frames, in send order
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
      this.sent.push(JSON.parse(data));
    }

    close(code, reason) {
      this.closed = true;
      this.readyState = FakeWS.CLOSED;
      this.closeCalls.push({ code, reason });
      (this._listeners.close || []).forEach((f) => f({ code, reason: reason || "" }));
    }
  }
  return { FakeWS };
});

vi.mock("ws", () => ({
  WebSocket: FakeWS,
  // not exercised in these tests (server-attachment path)
  WebSocketServer: class {},
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ model: "gemini-3.8-live", provider: "gemini" }),
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ apiKey: "AIza-TEST", id: "conn-1" }),
  isValidApiKey: async () => true,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (p) => p,
  AI_PROVIDERS: { gemini: { realtimeConfig: { bidiUrl: "wss://gemini.example/ws" } } },
}));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: async () => {},
}));

import { handleRealtimeVoiceConnection } from "@/sse/handlers/realtimeVoiceWs.js";

function makeClient() {
  const client = {
    readyState: FakeWS.OPEN,
    sent: [],
    handlers: {},
    on(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close(code, reason) {
      (this.handlers.close || []).forEach((f) => f(code, reason));
    },
  };
  return client;
}

function fire(client, ...args) {
  for (const f of client.handlers.message || []) f(...args);
}

const REQ = {
  url: "/v1/realtime?model=gemini/gemini-3.8-live&voice=Puck",
  headers: { host: "localhost" },
  socket: { remoteAddress: "127.0.0.1" },
};

async function openSession() {
  const client = makeClient();
  const conn = handleRealtimeVoiceConnection(client, REQ);
  await conn;
  const upstream = FakeWS.instances[0];
  await vi.waitFor(() => expect(upstream.sent.length).toBeGreaterThanOrEqual(1)); // setup frame out
  return { client, upstream };
}

afterEach(() => {
  FakeWS.instances.length = 0;
});

describe("Gemini Live realtime voice wire format", () => {
  it("locks setup transcription fields as generationConfig siblings — never nested, no mediaChunks", async () => {
    const { upstream } = await openSession();
    const setup = upstream.sent[0];
    expect(setup.setup).toBeTruthy();

    expect(setup.setup.inputAudioTranscription).toEqual({});
    expect(setup.setup.outputAudioTranscription).toEqual({});
    // must be siblings of generationConfig, not swallowed by it
    expect(setup.setup.generationConfig.inputAudioTranscription).toBeUndefined();
    expect(setup.setup.generationConfig.outputAudioTranscription).toBeUndefined();

    expect(JSON.stringify(upstream.sent)).not.toContain("mediaChunks");
  });

  it("input_audio_buffer.append rides realtimeInput.audio{mimeType,data} exactly", async () => {
    const { client, upstream } = await openSession();
    const b64 = Buffer.from("pcm16-audio-bytes").toString("base64");
    fire(client, Buffer.from(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }), "utf8"), false);

    const last = upstream.sent[upstream.sent.length - 1];
    expect(last).toEqual({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: b64,
        },
      },
    });
    expect(JSON.stringify(upstream.sent)).not.toContain("mediaChunks");
  });

  it("binary client frames ride realtimeInput.audio too", async () => {
    const { client, upstream } = await openSession();
    fire(client, Buffer.from("raw-pcm"), true);

    const last = upstream.sent[upstream.sent.length - 1];
    expect(last).toEqual({
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: Buffer.from("raw-pcm").toString("base64"),
        },
      },
    });
    expect(JSON.stringify(upstream.sent)).not.toContain("mediaChunks");
  });
});
