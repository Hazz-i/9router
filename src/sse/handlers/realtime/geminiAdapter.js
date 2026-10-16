// Gemini Live BidiGenerateContent adapter for /v1/realtime.
// Behaviour is verbatim-moved from the former inline Gemini path in
// realtimeVoiceWs.js — do not "improve" the wire format here; the
// tests/unit/gemini-realtime-wire.test.js regression test locks:
//   - setup frame carries top-level inputAudioTranscription / outputAudioTranscription
//     (siblings of generationConfig, never nested inside it);
//   - client audio rides realtimeInput.audio{mimeType,data} (never mediaChunks);
//   - VAD is left to Gemini defaults.
import { WebSocket } from "ws";
import crypto from "crypto";
import * as log from "../../utils/logger.js";
import {
  sendClientError, sendSessionCreated, sendSessionUpdated, sendAudioDelta,
  sendTranscriptDelta, sendSpeechStarted, sendResponseCancelled, sendTurnComplete,
} from "./openaiEvents.js";

const DEFAULT_BIDI_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export function formatGeminiModel(modelName) {
  if (!modelName) return "models/gemini-3.8-live";
  let clean = modelName.replace(/^gemini\//, "").replace(/^models\//, "");
  // Map older / deprecated preview models to current supported live models
  if (
    clean === "gemini-2.0-flash-exp" ||
    clean === "gemini-2.0-flash-realtime" ||
    clean === "gemini-2.5-flash-native-audio-preview-09-17"
  ) {
    clean = "gemini-3.8-live";
  }
  return `models/${clean}`;
}

export function createGeminiAdapter(ctx) {
  const bidiBaseUrl = ctx.config?.bidiUrl || DEFAULT_BIDI_URL;
  const wsUrl = `${bidiBaseUrl}?key=${encodeURIComponent(ctx.apiKey)}`;
  if (ctx.config?.audioOutRate) ctx.setOutputRate(ctx.config.audioOutRate);

  let upstreamWs = null;
  let setupSent = false;
  let activeVoice = ctx.voice || "Puck";
  let activeInstructions = ctx.instructions;
  let sessionId = `sess_${crypto.randomBytes(12).toString("hex")}`;
  let currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
  let currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
  let silenceHeartbeat = null;
  // Gemini Live's server VAD only closes a turn if it keeps receiving audio
  // after the user stops: with speech bursts alone it sends ACTIVITY_START but
  // never ACTIVITY_END, so no model turn ever fires. Feed a continuous real-time
  // silence track from upstream open, like a live mic does (0.125s frames).
  const SILENCE_FRAME_B64 = Buffer.alloc(2048).toString("base64");
  const startSilenceHeartbeat = () => {
    if (silenceHeartbeat) return;
    silenceHeartbeat = setInterval(() => {
      if (setupSent && upstreamWs?.readyState === WebSocket.OPEN) {
        upstreamWs.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: SILENCE_FRAME_B64 } } }));
      }
    }, 125);
  };

  const sendSetupToGemini = () => {
    if (setupSent || !upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) return;
    setupSent = true;
    const setupMsg = {
      setup: {
        model: formatGeminiModel(ctx.model),
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: activeVoice,
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: activeInstructions }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
    log.info("REALTIME_VOICE", `Sending setup to Gemini: model=${setupMsg.setup.model}, voice=${activeVoice}`);
    upstreamWs.send(JSON.stringify(setupMsg));
  };

  const forwardAudio = (base64) => {
    if (!setupSent) sendSetupToGemini();
    if (upstreamWs?.readyState === WebSocket.OPEN) {
      upstreamWs.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: base64,
            },
          },
        })
      );
    }
  };

  const sendClientContent = (turns) => {
    if (upstreamWs?.readyState === WebSocket.OPEN) {
      upstreamWs.send(JSON.stringify({ clientContent: { turns, turnComplete: true } }));
    }
  };

  return {
    async connect() {
      try {
        upstreamWs = new WebSocket(wsUrl);
      } catch (err) {
        log.error("REALTIME_VOICE", "Failed to construct upstream WebSocket", err);
        throw err;
      }
      log.info("REALTIME_VOICE", `Establishing upstream connection to Gemini Live: ${formatGeminiModel(ctx.model)} with voice ${activeVoice}`);

      upstreamWs.on("open", () => {
        log.info("REALTIME_VOICE", "Upstream Gemini Live WebSocket open");
        sendSetupToGemini();
        startSilenceHeartbeat();
      });

      upstreamWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString("utf8"));

          // Error from Gemini frame
          if (msg.error) {
            log.error("REALTIME_VOICE", `Gemini returned error frame: ${JSON.stringify(msg.error)}`);
            sendClientError(ctx, msg.error.message || "Gemini Live error");
            return;
          }

          // 1. Setup complete
          if (msg.setupComplete) {
            log.info("REALTIME_VOICE", "Gemini Live setup complete");
            sendSessionCreated(ctx, { sessionId, model: ctx.model, voice: activeVoice });
            sendSessionUpdated(ctx, { sessionId, model: ctx.model, voice: activeVoice });
            return;
          }

          // 2. Server content / Model turn
          if (msg.serverContent) {
            const sc = msg.serverContent;

            // User interrupted the model
            if (sc.interrupted) {
              log.info("REALTIME_VOICE", "Model speech interrupted by user");
              sendSpeechStarted(ctx, { itemId: currentItemId, audioStartMs: ctx.millisSinceStart() });
              sendResponseCancelled(ctx, currentResponseId);
              currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
              currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
              return;
            }

            // Audio output transcription
            if (sc.outputTranscription?.text) {
              sendTranscriptDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, text: sc.outputTranscription.text });
            }

            // Parts in model turn
            if (sc.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                // Audio chunk
                if (part.inlineData?.data) {
                  const audioBase64 = part.inlineData.data;
                  ctx.countOutput(Buffer.byteLength(audioBase64, "base64"));
                  sendAudioDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, base64: audioBase64 });
                }
                // Text transcription
                if (part.text) {
                  sendTranscriptDelta(ctx, { responseId: currentResponseId, itemId: currentItemId, text: part.text });
                }
              }
            }

            // Turn complete
            if (sc.turnComplete) {
              sendTurnComplete(ctx, { responseId: currentResponseId, itemId: currentItemId });
              currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
              currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
            }
          }
        } catch (err) {
          log.error("REALTIME_VOICE", "Error processing upstream message", err);
        }
      });

      upstreamWs.on("error", (err) => {
        log.error("REALTIME_VOICE", "Upstream Gemini error", err.message);
        if (ctx.isClientOpen()) {
          sendClientError(ctx, `Gemini Live error: ${err.message}`);
        }
      });

      upstreamWs.on("close", (code, reason) => {
        log.info("REALTIME_VOICE", `Upstream closed with code=${code} reason=${reason}`);
        if (ctx.isClientOpen()) {
          ctx.closeClient(1000, "Upstream closed");
        }
      });
    },

    handleClientEvent(event) {
      switch (event.type) {
        case "session.update": {
          if (event.session) {
            if (event.session.voice) activeVoice = event.session.voice;
            if (event.session.instructions) activeInstructions = event.session.instructions;
          }
          if (!setupSent) {
            sendSetupToGemini();
          } else {
            // Echo back session updated
            sendSessionUpdated(ctx, { sessionId, model: ctx.model, voice: activeVoice });
          }
          break;
        }

        case "input_audio_buffer.append": {
          if (event.audio) forwardAudio(event.audio);
          break;
        }

        case "input_audio_buffer.clear": {
          // Client cleared buffer
          break;
        }

        case "input_audio_buffer.commit":
        case "response.create": {
          // If client explicitly triggers a response or commits audio
          sendClientContent([{ role: "user", parts: [{ text: "" }] }]);
          break;
        }

        case "conversation.item.create": {
          // Client sent text message or injected context
          if (event.item?.content) {
            const parts = [];
            for (const c of event.item.content) {
              if (c.type === "input_text" && c.text) parts.push({ text: c.text });
            }
            if (parts.length > 0) {
              sendClientContent([{ role: "user", parts }]);
            }
          }
          break;
        }

        default:
          break;
      }
    },

    handleClientAudio(buffer) {
      forwardAudio(buffer.toString("base64"));
    },

    close() {
      if (silenceHeartbeat) {
        clearInterval(silenceHeartbeat);
        silenceHeartbeat = null;
      }
      if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.close(1000, "Client closed");
      }
    },
  };
}
