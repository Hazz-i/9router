// Tuned ElevenLabs API-key probe, shared by /api/providers/validate and the
// connection-test path (testUtils). Real-world behavior this encodes:
// - GET /v1/user 401 missing_permissions ⇒ key still valid for STT/scribe-only scopes.
// - TTS probe with dummy model "__probe__" returns 400 model_not_found for a valid
//   key (auth happens before model resolution) without spending quota.
// Do not redesign; `fetchImpl` is injectable for unit tests.
export async function probeElevenLabsKey(apiKey, fetchImpl) {
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));

  // 1. Try GET /v1/user first (standard for full/unrestricted keys)
  const userRes = await doFetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(8000),
  });
  if (userRes.ok) {
    return { valid: true, error: null };
  }
  const userJson = await userRes.json().catch(() => ({}));
  if (userJson.detail?.status === "invalid_api_key") {
    return { valid: false, error: "Invalid API key" };
  }
  if (userJson.detail?.status === "detected_unusual_activity") {
    return {
      valid: false,
      error: userJson.detail.message || "Free Tier access disabled by ElevenLabs (unusual activity detected)",
    };
  }

  // 2. If user_read permission is missing, probe TTS with a non-existent dummy model (__probe__)
  // ElevenLabs authenticates the key FIRST; model_not_found (400) confirms a valid key without consuming character quota.
  const ttsProbe = await doFetch("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb", {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "test", model_id: "__probe__" }),
    signal: AbortSignal.timeout(8000),
  });
  const ttsJson = await ttsProbe.json().catch(() => ({}));

  if (ttsProbe.status === 400 && ttsJson.detail?.status === "model_not_found") {
    // Key is valid and allowed to access TTS!
    return { valid: true, error: null };
  }
  if (ttsJson.detail?.status === "detected_unusual_activity") {
    return {
      valid: false,
      error: ttsJson.detail.message || "Free Tier access disabled by ElevenLabs (unusual activity detected)",
    };
  }
  if (ttsJson.detail?.status === "invalid_api_key") {
    return { valid: false, error: "Invalid API key" };
  }
  // If the key is authenticated but missing a specific permission (e.g. only scribe/STT allowed)
  if (userJson.detail?.status === "missing_permissions" || ttsJson.detail?.status === "missing_permissions") {
    return { valid: true, error: null };
  }

  return {
    valid: false,
    error: ttsJson.detail?.message || userJson.detail?.message || "Invalid API key",
  };
}
