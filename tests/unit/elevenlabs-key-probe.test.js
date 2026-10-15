// Regression lock for the ElevenLabs key probe shared by
// /api/providers/validate and Test Connection (testUtils).
// The real key in use lacks `user_read`, so /v1/user always returns
// 401 missing_permissions — the probe must still report the key as valid.
import { describe, it, expect } from "vitest";
import { probeElevenLabsKey } from "../../src/lib/providers/elevenlabsProbe.js";

// json(body) → fake fetch response; supports an optional per-URL response.
function makeFetch(responses) {
  return async (url, options) => {
    const res = typeof responses === "function" ? responses(url, options) : responses;
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body ?? {} };
  };
}

describe("probeElevenLabsKey", () => {
  it("valid: /v1/user returns 200", async () => {
    const result = await probeElevenLabsKey("k", makeFetch({ status: 200, body: {} }));
    expect(result).toEqual({ valid: true, error: null });
  });

  it("invalid: user 401 invalid_api_key", async () => {
    const result = await probeElevenLabsKey("k", makeFetch({ status: 401, body: { detail: { status: "invalid_api_key", message: "x" } } }));
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("invalid: user 401 detected_unusual_activity uses upstream message", async () => {
    const result = await probeElevenLabsKey("k", makeFetch({ status: 401, body: { detail: { status: "detected_unusual_activity", message: "Free tier disabled" } } }));
    expect(result).toEqual({ valid: false, error: "Free tier disabled" });
  });

  it("valid: user 401 then TTS 400 model_not_found (key passes auth before model resolves)", async () => {
    const seen = [];
    const fetchImpl = makeFetch((url, options) => {
      seen.push([url, options.body]);
      if (url.includes("/v1/user")) return { status: 401, body: { detail: { status: "missing_permissions", message: "no user_read" } } };
      return { status: 400, body: { detail: { status: "model_not_found" } } };
    });
    const result = await probeElevenLabsKey("k", fetchImpl);
    expect(result).toEqual({ valid: true, error: null });
    // Probe must hit the dummy-model TTS endpoint, not spend quota
    expect(seen[1][0].includes("/v1/text-to-speech/")).toBe(true);
    expect(JSON.parse(seen[1][1]).model_id).toBe("__probe__");
  });

  it("valid: missing_permissions on /v1/user with generic TTS response (restricted scribe-only key)", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/v1/user")) return { status: 401, body: { detail: { status: "missing_permissions", message: "no user_read" } } };
      return { status: 429, body: { detail: { message: "quota" } } };
    });
    const result = await probeElevenLabsKey("k", fetchImpl);
    expect(result).toEqual({ valid: true, error: null });
  });

  it("valid: missing_permissions on TTS response even when user response is opaque", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/v1/user")) return { status: 401, body: { detail: { message: "boom" } } };
      return { status: 403, body: { detail: { status: "missing_permissions", message: "scope" } } };
    });
    const result = await probeElevenLabsKey("k", fetchImpl);
    expect(result).toEqual({ valid: true, error: null });
  });

  it("invalid: TTS detected_unusual_activity uses upstream message", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/v1/user")) return { status: 401, body: { detail: { message: "no user_read" } } };
      return { status: 401, body: { detail: { status: "detected_unusual_activity", message: "unusual" } } };
    });
    const result = await probeElevenLabsKey("k", fetchImpl);
    expect(result).toEqual({ valid: false, error: "unusual" });
  });

  it("invalid: unknown status falls back to upstream messages", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.includes("/v1/user")) return { status: 500, body: { detail: { message: "user-side msg" } } };
      return { status: 500, body: { detail: { message: "tts-side msg" } } };
    });
    const result = await probeElevenLabsKey("k", fetchImpl);
    expect(result).toEqual({ valid: false, error: "tts-side msg" });
  });

  it("invalid: non-JSON bodies degrade to 'Invalid API key'", async () => {
    const result = await probeElevenLabsKey("k", makeFetch({ status: 403 }));
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });
});
