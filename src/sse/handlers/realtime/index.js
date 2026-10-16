// Adapter registry for /v1/realtime upstreams. Every adapter implements the
// same contract against a shared context object (see realtimeVoiceWs.js):
//   connect()            — dial the upstream WS (async; throws on config errors
//                          like a missing agent id / think credentials, rejects
//                          on socket construction failure)
//   handleClientEvent(e) — one parsed client JSON event (OpenAI Realtime protocol)
//   handleClientAudio(b) — one client binary PCM16 frame
//   close()              — close the upstream cleanly (client disconnected)
// Adapters never touch the client contract directly; they emit through
// ./openaiEvents.js builders and the ctx senders, so one adapter's failure
// cannot spill into the others.
import { createGeminiAdapter } from "./geminiAdapter.js";
import { createDeepgramAdapter } from "./deepgramAdapter.js";

export const REALTIME_ADAPTERS = {
  gemini: createGeminiAdapter,
  deepgram: createDeepgramAdapter,
};

export function createRealtimeAdapter(providerId, ctx) {
  const factory = REALTIME_ADAPTERS[providerId];
  if (!factory) {
    throw new Error(`Provider "${providerId}" does not support realtime voice`);
  }
  return factory(ctx);
}
