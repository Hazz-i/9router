// The dashboard "Test" chip for realtime / liveCaption models used to fall
// through to the generic chat probe (HTTP 503 / OpenAI 401). These tests pin
// the WS-gateway probe added in pingModelByKind: dial the same gateways the
// features use, succeed on session.created / ready, fail on error frames,
// and always close the socket.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the heavy Next.js-dependent imports BEFORE importing ping.js
// (same pattern as tests/unit/ping-reasoning-models-3010.test.js).
vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-key", isActive: true }]) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

// ── fake WebSocket (same binding styles as tests/unit/gemini-live-stt.test.js) ──

class FakeWS {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWS.CONNECTING;
    this.closeCalls = [];
    this._listeners = {};
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWS.OPEN;
      (this._listeners.open || []).forEach((f) => f({}));
    });
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }

  emit(obj) {
    const ev = { data: JSON.stringify(obj) };
    (this._listeners.message || []).forEach((f) => f(ev));
  }

  close() {
    this.readyState = FakeWS.CLOSED;
    this.closeCalls.push({ code: 1000 });
    const ev = { code: 1000 };
    (this._listeners.close || []).forEach((f) => f(ev));
  }
}

const BASE = "http://127.0.0.1:20127";

beforeEach(() => {
  FakeWS.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWS);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openedSocket(kind) {
  const promise = pingModelByKind(`gemini/gemini-3.8-live`, kind, BASE);
  await flushMicrotasks();
  const ws = FakeWS.instances[0];
  expect(ws).toBeTruthy();
  return { promise, ws };
}

// Drain the async key-loading chain inside pingModelByKind. Extra turns are
// pumped by the loop itself, so one flush is enough regardless of chain depth.
async function flushMicrotasks(turns = 30) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("pingModelByKind WS probes (realtime / liveCaption)", () => {
  it("realtime: dials /v1/realtime and succeeds on session.created, closing the socket", async () => {
    const { promise, ws } = await openedSocket("realtime");
    expect(ws.url).toBe(`${BASE.replace("http", "ws")}/v1/realtime?model=gemini%2Fgemini-3.8-live&voice=Puck&apiKey=test-key`);
    ws.emit({ type: "session.created", session: { id: "s1" } });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.error).toBe(null);
    expect(typeof result.latencyMs).toBe("number");
    expect(ws.readyState).toBe(FakeWS.CLOSED);
  });

  it("liveCaption: dials /v1/audio/live-transcriptions and succeeds on ready", async () => {
    const { promise, ws } = await openedSocket("liveCaption");
    expect(ws.url).toBe(`${BASE.replace("http", "ws")}/v1/audio/live-transcriptions?model=gemini%2Fgemini-3.8-live&language=id&encoding=linear16&sample_rate=16000&apiKey=test-key`);
    ws.emit({ type: "ready", upstream: "deepgram" });
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.error).toBe(null);
    expect(ws.readyState).toBe(FakeWS.CLOSED);
  });

  it("error frame fails with the upstream message", async () => {
    const { promise, ws } = await openedSocket("realtime");
    ws.emit({ type: "error", error: { type: "upstream_error", message: "models/x is not found for API version v1beta" } });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("models/x is not found for API version v1beta");
    expect(result.status).toBeUndefined();
    expect(ws.readyState).toBe(FakeWS.CLOSED);
  });

  it("timeout fails and closes the socket", async () => {
    vi.useFakeTimers();
    try {
      const promise = pingModelByKind("gemini/gemini-3.8-live", "realtime", BASE);
      await flushMicrotasks();
      const ws = FakeWS.instances[0];
      await vi.advanceTimersByTimeAsync(15000);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Timed out/);
      expect(ws.readyState).toBe(FakeWS.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });
});
