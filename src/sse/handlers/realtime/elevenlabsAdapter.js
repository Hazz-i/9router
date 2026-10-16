// ElevenLabs Conversational AI adapter for /v1/realtime.
//
// Upstream protocol (wss://api.elevenlabs.io/v1/convai/conversation?agent_id=…):
//   - NO auth header on the WS. Public agents connect with just `agent_id`;
//     private agents dial a signed URL fetched server-side with the stored
//     ElevenLabs key (`GET /v1/convai/conversation/get-signed-url` with
//     `xi-api-key`), falling back to the plain agent_id URL for public agents.
//   - Client → server: {"user_audio_chunk": "<base64 pcm>"}, initiated with
//     {"type":"conversation_initiation_client_data"}.
//   - Server types mapped here: conversation_initiation_metadata (→ session.created/
//     session.updated; reported audio formats are parsed, never assumed),
//     audio → response.audio.delta, agent_response → response.audio_transcript.delta,
//     agent_response_complete → response.audio.done + response.done,
//     interruption → input_audio_buffer.speech_started (+ response.cancelled),
//     ping → MUST pong {"type":"pong","event_id":…}, client_error → client error.
//   - user_transcript has no OpenAI Realtime counterpart in the browser contract — logged, not forwarded.
import { WebSocket } from "ws";
import crypto from "crypto";
import * as log from "../../utils/logger.js";
import {
  sendClientError, sendSessionCreated, sendSessionUpdated, sendAudioDelta,
  sendTranscriptDelta, sendSpeechStarted, sendResponseCancelled, sendTurnComplete,
} from "./openaiEvents.js";

function parsePcmRate(format) {
  // format enum e.g. "pcm_16000"/"pcm_8000" → sample rate in Hz
  const m = /(\d+)/.exec(String(format || ""));
  return m ? Number(m[1]) : null;
}

const isOpen = (ws) => ws && ws.readyState === WebSocket.OPEN;

export function createElevenLabsAdapter(ctx) {
  const config = ctx.config || {};
  const agentId = ctx.credentials?.providerSpecificData?.agentId || ctx.query?.get("agent_id") || null;
  if (!agentId) {
    throw new Error(
      "ElevenLabs agent id is not configured. Add your ConvAI agent id to the ElevenLabs connection's provider-specific data (agentId) or pass ?agent_id=<id> on the realtime URL."
    );
  }
  // Data-residency host selection (connection providerSpecificData.residency
  // wins over ?region= on the realtime URL). Applies to both the signed-url
  // REST call and the WS dial; default global keeps both URLs untouched.
  const residencyHosts = config.residencyHosts || {};
  const residency = ctx.credentials?.providerSpecificData?.residency || ctx.query?.get("region") || "global";
  const host = residencyHosts[residency];
  if (!host) {
    throw new Error(`Unknown ElevenLabs residency "${residency}". Valid values: global, us, eu, in, sg`);
  }
  const relocate = (url) => (residency === "global"
    ? url
    : url.replace(/^wss:\/\/[^/]+/, `wss://${host}`).replace(/^https:\/\/[^/]+/, `https://${host}`));

  let upstreamWs = null;
  let sessionId = `sess_${crypto.randomBytes(12).toString("hex")}`;
  let currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
  let currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;

  const sendUserAudio = (base64) => {
    if (isOpen(upstreamWs)) {
      upstreamWs.send(JSON.stringify({ user_audio_chunk: base64 }));
    }
  };

  async function resolveUpstreamUrl() {
    const plainUrl = relocate(`${config.wsUrl || "wss://api.elevenlabs.io/v1/convai/conversation"}?agent_id=${encodeURIComponent(agentId)}`);
    if (!ctx.apiKey) return plainUrl;
    // Private agents need a signed URL minted server-side with the stored key.
    try {
      const res = await fetch(
        relocate(`${config.signedUrlEndpoint || "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"}?agent_id=${encodeURIComponent(agentId)}`),
        { headers: { [config.authHeader || "xi-api-key"]: ctx.apiKey } }
      );
      if (res.ok) {
        const body = await res.json();
        if (body?.signed_url) return body.signed_url;
      }
      log.warn("REALTIME_VOICE", `ElevenLabs signed-url call failed (HTTP ${res.status}); falling back to plain agent_id URL (public agents)`);
    } catch (err) {
      log.warn("REALTIME_VOICE", `ElevenLabs signed-url call errored (${err.message}); falling back to plain agent_id URL (public agents)`);
    }
    return plainUrl;
  }

  return {
    async connect() {
      const url = await resolveUpstreamUrl();
      log.info("REALTIME_VOICE", `Connecting upstream ElevenLabs ConvAI agent ${agentId.slice(0, 8)}… (signed_url: ${ctx.apiKey ? "attempted" : "no"}, dialing ${url.startsWith("wss://") ? url.split("?")[0] : url})`);
      upstreamWs = new WebSocket(url);

      upstreamWs.on("open", () => {
        log.info("REALTIME_VOICE", "Upstream ElevenLabs ConvAI WebSocket open");
        upstreamWs.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
      });

      upstreamWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString("utf8"));
          switch (msg.type) {
            case "conversation_initiation_metadata": {
              const md = msg.conversation_initiation_metadata_event || {};
              const inRate = parsePcmRate(md.user_input_audio_format);
              const outRate = parsePcmRate(md.agent_output_audio_format);
              if (inRate) ctx.setInputRate(inRate);
              if (outRate) ctx.setOutputRate(outRate);
              log.info("REALTIME_VOICE", `ElevenLabs session ${md.conversation_id || "?"} | in=${md.user_input_audio_format} out=${md.agent_output_audio_format}`);
              sendSessionCreated(ctx, { sessionId, model: ctx.model });
              sendSessionUpdated(ctx, { sessionId, model: ctx.model });
              break;
            }

            case "audio": {
              const base64 = msg.audio_event?.audio_base_64;
              if (base64) {
                ctx.countOutput(Buffer.byteLength(base64, "base64"));
                sendAudioDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, base64 });
              }
              break;
            }

            case "user_transcript": {
              // No OpenAI Realtime event in the browser contract carries the user transcript.
              break;
            }

            case "agent_response": {
              const text = msg.agent_response_event?.agent_response;
              if (text) {
                sendTranscriptDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, text });
              }
              break;
            }

            case "agent_response_complete": {
              sendTurnComplete(ctx, { responseId: currentResponseId, itemId: currentItemId });
              currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
              currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
              break;
            }

            case "interruption": {
              sendSpeechStarted(ctx, { itemId: currentItemId });
              sendResponseCancelled(ctx, currentResponseId);
              currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
              currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
              break;
            }

            case "ping": {
              // Protocol requires echoing the exact event_id back.
              upstreamWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }));
              break;
            }

            case "client_error": {
              const e = msg.error_event || {};
              sendClientError(ctx, `${e.error_name || "client_error"}${e.code ? ` (${e.code})` : ""}: ${e.message || "ElevenLabs client error"}`);
              break;
            }

            default:
              break;
          }
        } catch (err) {
          log.error("REALTIME_VOICE", "Error processing ElevenLabs upstream message", err);
        }
      });

      upstreamWs.on("error", (err) => {
        log.error("REALTIME_VOICE", "Upstream ElevenLabs error", err.message);
        if (ctx.isClientOpen()) {
          sendClientError(ctx, `ElevenLabs ConvAI error: ${err.message}`);
        }
      });

      upstreamWs.on("close", (code, reason) => {
        log.info("REALTIME_VOICE", `ElevenLabs upstream closed code=${code} reason=${reason}`);
        if (ctx.isClientOpen()) {
          ctx.closeClient(1000, "Upstream closed");
        }
      });
    },

    handleClientEvent(event) {
      switch (event.type) {
        case "session.update": {
          // Voice/instructions are owned by the ConvAI agent configuration — echo only.
          if (event.session?.instructions) log.warn("REALTIME_VOICE", "ElevenLabs: session.instructions ignored (agent prompt is configured in ConvAI)");
          sendSessionUpdated(ctx, { sessionId, model: ctx.model });
          break;
        }

        case "input_audio_buffer.append": {
          if (event.audio) sendUserAudio(event.audio);
          break;
        }

        default:
          break;
      }
    },

    handleClientAudio(buffer) {
      sendUserAudio(buffer.toString("base64"));
    },

    close() {
      if (isOpen(upstreamWs)) {
        upstreamWs.close(1000, "Client closed");
      }
    },
  };
}
