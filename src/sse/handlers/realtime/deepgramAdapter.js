// Deepgram Voice Agent adapter for /v1/realtime.
//
// Upstream protocol (wss://agent.deepgram.com/v1/agent/converse, Authorization: Token <key>):
//   - First message MUST be the Settings JSON, then raw binary PCM frames + periodic KeepAlive.
//   - Text JSON events mapped: SettingsApplied → session.created/session.updated,
//     ConversationText(assistant) → response.audio_transcript.delta,
//     UserStartedSpeaking → input_audio_buffer.speech_started (+ response.cancelled),
//     AgentAudioDone → response.audio.done + response.done, Error → client error.
//   - Audio comes back as a *binary* WebSocket frame (raw linear16 PCM) — the only
//     adapter here with binary upstream; mapped to response.audio.delta (base64).
import { WebSocket } from "ws";
import crypto from "crypto";
import * as log from "../../utils/logger.js";
import {
  sendClientError, sendSessionCreated, sendSessionUpdated, sendAudioDelta,
  sendTranscriptDelta, sendSpeechStarted, sendResponseCancelled, sendTurnComplete,
} from "./openaiEvents.js";

const isOpen = (ws) => ws && ws.readyState === WebSocket.OPEN;

export function createDeepgramAdapter(ctx) {
  const config = ctx.config || {};
  const psd = ctx.credentials?.providerSpecificData || {};
  // Optional ONLY. Deepgram runs the built-in think providers (open_ai /
  // anthropic / google / groq) on their own credentials — their playground emits
  // `think.provider = {type, model}` with no key field at all. These two fields
  // exist for the custom-endpoint case only.
  const thinkApiKey = psd.thinkApiKey || null;
  const thinkUrl = psd.thinkUrl || null;
  const customThinkEndpoint = thinkApiKey && thinkUrl;

  // ?listen=/?think=/?speak= overrides (<provider.type>/<id> per registry
  // realtimeConfig.<kind>.providers groups); ?greeting= maps to agent.greeting.
  // `custom:<raw-id>` passes any id through verbatim (provider still validated,
  // id free-form). Unknown choices throw so a bogus Settings frame is never
  // forwarded upstream. No query params → registry defaults, i.e. byte-identical
  // Settings to pre-override behaviour.
  const substituteCustomId = (obj, rawId) => {
    if (typeof obj === "string") return obj === "@id" ? rawId : obj;
    if (Array.isArray(obj)) return obj.map((v) => substituteCustomId(v, rawId));
    if (obj && typeof obj === "object") {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, substituteCustomId(v, rawId)]));
    }
    return obj;
  };
  const resolveOverride = (kind, raw) => {
    if (!raw) return null;
    const [prov, ...rest] = String(raw).split("/");
    const group = (config[kind]?.providers || []).find((g) => g.type === prov);
    if (!group) {
      const valid = (config[kind]?.providers || [])
        .flatMap((g) => (g.models || g.voices || []).map((o) => `${g.type}/${o.id}`))
        .join(", ");
      throw new Error(`Unknown realtime ${kind} choice "${raw}". Valid options: ${valid}`);
    }
    const id = rest.join("/");
    if (id.startsWith("custom:")) {
      const rawId = id.slice("custom:".length);
      if (!rawId) throw new Error(`Missing custom ${kind} id for provider "${prov}" (use ${prov}/custom:<id>).`);
      // speak groups carry a customVoice template; think/listen are {type, model} fragments.
      const settings = group.customVoice
        ? substituteCustomId(group.customVoice, rawId)
        : { provider: { type: prov, model: rawId } };
      return { settings };
    }
    const entry = (group.models || group.voices || []).find((o) => o.id === id);
    if (!entry) {
      const valid = (config[kind]?.providers || [])
        .flatMap((g) => (g.models || g.voices || []).map((o) => `${g.type}/${o.id}`))
        .join(", ");
      throw new Error(`Unknown realtime ${kind} choice "${raw}". Valid options: ${valid}`);
    }
    return { settings: entry.settings || { provider: { type: prov, model: id } } };
  };
  const listenOverride = resolveOverride("listen", ctx.query?.get?.("listen"));
  const thinkOverride = resolveOverride("think", ctx.query?.get?.("think"));
  const speakOverride = resolveOverride("speak", ctx.query?.get?.("speak"));
  const greeting = ctx.query?.get?.("greeting") || null;

  let upstreamWs = null;
  let keepAliveTimer = null;
  let ready = false;
  let sessionId = `sess_${crypto.randomBytes(12).toString("hex")}`;
  let currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
  let currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
  let activeInstructions = ctx.instructions;

  // Think (LLM) config comes from the registry. Deepgram manages credentials for
  // its built-in providers, so `{provider:{type,model}}` alone is enough — see
  // registry/deepgram.js realtimeConfig.think. The endpoint hop below is only for
  // a custom/self-hosted LLM (not a documented first-class key field).
  const buildSettings = () => ({
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: config.audioInRate || 16000 },
      output: { encoding: "linear16", sample_rate: config.audioOutRate || 24000, container: "none" },
    },
    agent: {
      listen: listenOverride ? listenOverride.settings : { provider: config.listen?.provider },
      think: {
        ...(thinkOverride ? thinkOverride.settings : { provider: config.think?.provider }),
        prompt: activeInstructions,
        ...(customThinkEndpoint ? { endpoint: { url: thinkUrl, headers: { Authorization: `Bearer ${thinkApiKey}` } } } : {}),
      },
      speak: speakOverride ? speakOverride.settings : { provider: config.speak?.provider },
      ...(greeting ? { greeting } : {}),
    },
  });

  const startKeepAlive = () => {
    if (keepAliveTimer) return;
    const intervalMs = config.keepAliveMs || 5000;
    keepAliveTimer = setInterval(() => {
      if (isOpen(upstreamWs)) upstreamWs.send(JSON.stringify({ type: "KeepAlive" }));
    }, intervalMs);
    if (keepAliveTimer.unref) keepAliveTimer.unref();
  };

  return {
    async connect() {
      const effectiveThink = thinkOverride?.settings?.provider || config.think?.provider;
      const thinkDesc = customThinkEndpoint
        ? `custom endpoint ${new URL(thinkUrl).host}`
        : `built-in ${effectiveThink?.type || "?"}/${effectiveThink?.model || "?"}`;
      log.info("REALTIME_VOICE", `Connecting upstream Deepgram Voice Agent (think: ${thinkDesc})`);
      upstreamWs = new WebSocket(config.wsUrl || "wss://agent.deepgram.com/v1/agent/converse", {
        headers: { [config.authHeader || "Authorization"]: `${config.authScheme || "Token"} ${ctx.apiKey}` },
      });

      upstreamWs.on("open", () => {
        log.info("REALTIME_VOICE", "Upstream Deepgram Voice Agent WebSocket open — sending Settings");
        upstreamWs.send(JSON.stringify(buildSettings()));
        startKeepAlive();
      });

      upstreamWs.on("message", (data, isBinary) => {
        // Audio output is a raw binary frame of linear16 PCM, not JSON.
        if (isBinary) {
          const base64 = Buffer.from(data).toString("base64");
          ctx.countOutput(Buffer.byteLength(base64, "base64"));
          sendAudioDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, base64 });
          return;
        }
        try {
          const msg = JSON.parse(data.toString("utf8"));
          switch (msg.type) {
            case "Welcome": {
              log.info("REALTIME_VOICE", `Deepgram welcome (request_id=${msg.request_id || "?"})`);
              break;
            }

            case "SettingsApplied": {
              if (ready) break;
              ready = true;
              log.info("REALTIME_VOICE", "Deepgram settings applied — upstream ready");
              sendSessionCreated(ctx, { sessionId, model: ctx.model });
              sendSessionUpdated(ctx, { sessionId, model: ctx.model });
              break;
            }

            case "ConversationText": {
              if (msg.role === "assistant" && msg.content) {
                sendTranscriptDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, text: msg.content });
              }
              break;
            }

            case "UserStartedSpeaking": {
              sendSpeechStarted(ctx, { itemId: currentItemId });
              sendResponseCancelled(ctx, currentResponseId);
              currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
              currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
              break;
            }

            case "AgentThinking":
            case "AgentStartedSpeaking": {
              // No client protocol event; the agent audio deltas carry the actual output.
              break;
            }

            case "AgentAudioDone": {
              sendTurnComplete(ctx, { responseId: currentResponseId, itemId: currentItemId });
              currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
              currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
              break;
            }

            case "Error": {
              sendClientError(ctx, `${msg.code ? `${msg.code}: ` : ""}${msg.description || "Deepgram agent error"}`);
              break;
            }

            default:
              break;
          }
        } catch (err) {
          log.error("REALTIME_VOICE", "Error processing Deepgram upstream message", err);
        }
      });

      upstreamWs.on("error", (err) => {
        log.error("REALTIME_VOICE", "Upstream Deepgram error", err.message);
        if (ctx.isClientOpen()) {
          sendClientError(ctx, `Deepgram Voice Agent error: ${err.message}`);
        }
      });

      upstreamWs.on("close", (code, reason) => {
        log.info("REALTIME_VOICE", `Deepgram upstream closed code=${code} reason=${reason}`);
        if (ctx.isClientOpen()) {
          ctx.closeClient(1000, "Upstream closed");
        }
      });
    },

    handleClientEvent(event) {
      switch (event.type) {
        case "session.update": {
          // Captured before Settings is sent on open; applied at connect time.
          if (event.session?.instructions) activeInstructions = event.session.instructions;
          if (ready) sendSessionUpdated(ctx, { sessionId, model: ctx.model });
          break;
        }

        case "input_audio_buffer.append": {
          if (event.audio && isOpen(upstreamWs)) {
            upstreamWs.send(Buffer.from(event.audio, "base64"));
          }
          break;
        }

        default:
          break;
      }
    },

    handleClientAudio(buffer) {
      if (isOpen(upstreamWs)) upstreamWs.send(buffer);
    },

    close() {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (isOpen(upstreamWs)) {
        upstreamWs.close(1000, "Client closed");
      }
    },
  };
}
