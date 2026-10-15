import { WebSocketServer, WebSocket } from "ws";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getProviderCredentials, isValidApiKey } from "../services/auth.js";
import { resolveProviderId, AI_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import crypto from "crypto";

let realtimeWsServer = null;

function extractTokenFromRequest(req, url) {
  // Query param first (standard for browser WebSockets)
  const queryToken =
    url.searchParams.get("apiKey") ||
    url.searchParams.get("api_key") ||
    url.searchParams.get("token") ||
    url.searchParams.get("key");
  if (queryToken) return queryToken;

  // Authorization header
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  // x-api-key header
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey) return String(xApiKey).trim();

  return null;
}

function formatGeminiModel(modelName) {
  if (!modelName) return "models/gemini-2.0-flash-exp";
  const clean = modelName.replace(/^gemini\//, "");
  return clean.startsWith("models/") ? clean : `models/${clean}`;
}

export function getRealtimeWsServer() {
  if (!realtimeWsServer) {
    realtimeWsServer = new WebSocketServer({ noServer: true });
    realtimeWsServer.on("connection", handleRealtimeVoiceConnection);
  }
  return realtimeWsServer;
}

/**
 * Handle incoming WebSocket connection for /v1/realtime
 * @param {import("ws").WebSocket} clientWs
 * @param {import("http").IncomingMessage} req
 */
export async function handleRealtimeVoiceConnection(clientWs, req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const clientIp = req.headers["x-9r-real-ip"] || req.socket.remoteAddress;
  log.info("REALTIME_VOICE", `New client connected from ${clientIp} - ${req.url}`);

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const token = extractTokenFromRequest(req, url);
    if (!token || !(await isValidApiKey(token))) {
      log.warn("REALTIME_VOICE", "Unauthorized WebSocket rejected");
      clientWs.send(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "unauthorized",
            message: "Unauthorized: Invalid or missing API key",
          },
        })
      );
      clientWs.close(4401, "Unauthorized");
      return;
    }
  }

  // Resolve requested model & voice
  const rawModelParam = url.searchParams.get("model") || "gemini/gemini-2.0-flash-exp";
  const voiceParam = url.searchParams.get("voice") || "Puck";
  const modelInfo = await getModelInfo(rawModelParam);
  const targetModel = modelInfo?.model || "gemini-2.0-flash-exp";
  const provider = resolveProviderId(modelInfo?.provider || "gemini");

  // Lookup provider credentials
  let credentials = await getProviderCredentials(provider, null, targetModel);
  let apiKey = credentials?.apiKey || process.env.GEMINI_API_KEY;

  if (!apiKey && provider === "gemini") {
    // Check if there are other gemini accounts in db
    credentials = await getProviderCredentials("gemini", null, null);
    apiKey = credentials?.apiKey || process.env.GEMINI_API_KEY;
  }

  if (!apiKey) {
    const errMsg = "No API key configured for Gemini. Please add a Gemini connection in 9Router Dashboard or set GEMINI_API_KEY environment variable.";
    log.error("REALTIME_VOICE", errMsg);
    clientWs.send(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "provider_missing_credentials",
          message: errMsg,
        },
      })
    );
    clientWs.close(4401, "Missing provider credentials");
    return;
  }

  const geminiConfig = AI_PROVIDERS.gemini?.realtimeConfig || {};
  const bidiBaseUrl = geminiConfig.bidiUrl || "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";
  const geminiWsUrl = `${bidiBaseUrl}?key=${encodeURIComponent(apiKey)}`;

  log.info("REALTIME_VOICE", `Establishing upstream connection to Gemini Live: ${formatGeminiModel(targetModel)} with voice ${voiceParam}`);

  let upstreamWs = null;
  let setupSent = false;
  let activeVoice = voiceParam;
  let activeInstructions = "You are a helpful and concise AI voice assistant. Speak naturally in Indonesian or English.";
  let sessionId = `sess_${crypto.randomBytes(12).toString("hex")}`;
  let currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
  let currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
  const startTime = Date.now();
  let inputAudioBytes = 0;
  let outputAudioBytes = 0;
  let isClosed = false;

  const sendSetupToGemini = () => {
    if (setupSent || !upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) return;
    setupSent = true;
    const setupMsg = {
      setup: {
        model: formatGeminiModel(targetModel),
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
      },
    };
    log.info("REALTIME_VOICE", `Sending setup to Gemini: model=${setupMsg.setup.model}, voice=${activeVoice}`);
    upstreamWs.send(JSON.stringify(setupMsg));
  };

  try {
    upstreamWs = new WebSocket(geminiWsUrl);
  } catch (err) {
    log.error("REALTIME_VOICE", "Failed to construct upstream WebSocket", err);
    clientWs.send(
      JSON.stringify({
        type: "error",
        error: {
          type: "server_error",
          message: `Failed to initiate upstream connection: ${err.message}`,
        },
      })
    );
    clientWs.close(4500, "Upstream error");
    return;
  }

  // Handle upstream events from Gemini
  upstreamWs.on("open", () => {
    log.info("REALTIME_VOICE", "Upstream Gemini Live WebSocket open");
    sendSetupToGemini();
  });

  upstreamWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString("utf8"));

      // 1. Setup complete
      if (msg.setupComplete) {
        log.info("REALTIME_VOICE", "Gemini Live setup complete");
        clientWs.send(
          JSON.stringify({
            type: "session.created",
            session: {
              id: sessionId,
              object: "realtime.session",
              model: targetModel,
              modalities: ["audio", "text"],
              voice: activeVoice,
              turn_detection: { type: "server_vad" },
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
            },
          })
        );
        clientWs.send(
          JSON.stringify({
            type: "session.updated",
            session: {
              id: sessionId,
              object: "realtime.session",
              model: targetModel,
              voice: activeVoice,
            },
          })
        );
        return;
      }

      // 2. Server content / Model turn
      if (msg.serverContent) {
        const sc = msg.serverContent;

        // User interrupted the model
        if (sc.interrupted) {
          log.info("REALTIME_VOICE", "Model speech interrupted by user");
          clientWs.send(
            JSON.stringify({
              type: "input_audio_buffer.speech_started",
              audio_start_ms: Date.now() - startTime,
              item_id: currentItemId,
            })
          );
          clientWs.send(
            JSON.stringify({
              type: "response.cancelled",
              response_id: currentResponseId,
            })
          );
          currentResponseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
          currentItemId = `item_${crypto.randomBytes(12).toString("hex")}`;
          return;
        }

        // Parts in model turn
        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            // Audio chunk
            if (part.inlineData?.data) {
              const audioBase64 = part.inlineData.data;
              outputAudioBytes += Buffer.byteLength(audioBase64, "base64");
              clientWs.send(
                JSON.stringify({
                  type: "response.audio.delta",
                  response_id: currentResponseId,
                  item_id: currentItemId,
                  output_index: 0,
                  content_index: 0,
                  delta: audioBase64,
                })
              );
            }
            // Text transcription
            if (part.text) {
              clientWs.send(
                JSON.stringify({
                  type: "response.audio_transcript.delta",
                  response_id: currentResponseId,
                  item_id: currentItemId,
                  output_index: 0,
                  content_index: 0,
                  delta: part.text,
                })
              );
            }
          }
        }

        // Turn complete
        if (sc.turnComplete) {
          clientWs.send(
            JSON.stringify({
              type: "response.audio.done",
              response_id: currentResponseId,
              item_id: currentItemId,
            })
          );
          clientWs.send(
            JSON.stringify({
              type: "response.done",
              response: {
                id: currentResponseId,
                object: "realtime.response",
                status: "completed",
              },
            })
          );
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
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "error",
          error: {
            type: "upstream_error",
            message: `Gemini Live error: ${err.message}`,
          },
        })
      );
    }
  });

  upstreamWs.on("close", (code, reason) => {
    log.info("REALTIME_VOICE", `Upstream closed with code=${code} reason=${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1000, "Upstream closed");
    }
    recordSessionUsage();
  });

  // Handle client messages (OpenAI Realtime Protocol)
  clientWs.on("message", (data, isBinary) => {
    try {
      // 1. Binary payload: raw audio chunk from client
      if (isBinary || Buffer.isBuffer(data)) {
        inputAudioBytes += data.length;
        if (!setupSent) sendSetupToGemini();
        if (upstreamWs?.readyState === WebSocket.OPEN) {
          upstreamWs.send(
            JSON.stringify({
              realtimeInput: {
                mediaChunks: [
                  {
                    mimeType: "audio/pcm;rate=16000",
                    data: data.toString("base64"),
                  },
                ],
              },
            })
          );
        }
        return;
      }

      // 2. JSON events
      const text = data.toString("utf8");
      const event = JSON.parse(text);

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
            clientWs.send(
              JSON.stringify({
                type: "session.updated",
                session: {
                  id: sessionId,
                  object: "realtime.session",
                  model: targetModel,
                  voice: activeVoice,
                },
              })
            );
          }
          break;
        }

        case "input_audio_buffer.append": {
          if (event.audio) {
            inputAudioBytes += Buffer.byteLength(event.audio, "base64");
            if (!setupSent) sendSetupToGemini();
            if (upstreamWs?.readyState === WebSocket.OPEN) {
              upstreamWs.send(
                JSON.stringify({
                  realtimeInput: {
                    mediaChunks: [
                      {
                        mimeType: "audio/pcm;rate=16000",
                        data: event.audio,
                      },
                    ],
                  },
                })
              );
            }
          }
          break;
        }

        case "input_audio_buffer.clear": {
          // Client cleared buffer
          break;
        }

        case "response.create": {
          // If client explicitly triggers a response
          if (upstreamWs?.readyState === WebSocket.OPEN) {
            upstreamWs.send(
              JSON.stringify({
                clientContent: {
                  turns: [
                    {
                      role: "user",
                      parts: [{ text: "Please respond." }],
                    },
                  ],
                  turnComplete: true,
                },
              })
            );
          }
          break;
        }

        case "conversation.item.create": {
          // Client sent text message or injected context
          if (event.item?.content) {
            const parts = [];
            for (const c of event.item.content) {
              if (c.type === "input_text" && c.text) parts.push({ text: c.text });
            }
            if (parts.length > 0 && upstreamWs?.readyState === WebSocket.OPEN) {
              upstreamWs.send(
                JSON.stringify({
                  clientContent: {
                    turns: [{ role: "user", parts }],
                    turnComplete: true,
                  },
                })
              );
            }
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      log.warn("REALTIME_VOICE", "Error handling client event", err.message);
    }
  });

  clientWs.on("close", () => {
    log.info("REALTIME_VOICE", "Client disconnected");
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close(1000, "Client closed");
    }
    recordSessionUsage();
  });

  clientWs.on("error", (err) => {
    log.error("REALTIME_VOICE", "Client socket error", err.message);
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
    recordSessionUsage();
  });

  const recordSessionUsage = async () => {
    if (isClosed) return;
    isClosed = true;

    const durationMs = Date.now() - startTime;
    // Estimate audio tokens (~25 tokens per second of PCM audio)
    const inSeconds = inputAudioBytes / (16000 * 2);
    const outSeconds = outputAudioBytes / (24000 * 2);
    const promptTokens = Math.max(1, Math.round(inSeconds * 25));
    const completionTokens = Math.max(1, Math.round(outSeconds * 25));

    log.info(
      "REALTIME_VOICE",
      `Session ended: ${Math.round(durationMs / 1000)}s | Audio In: ${Math.round(inSeconds)}s (${promptTokens} tok) | Out: ${Math.round(outSeconds)}s (${completionTokens} tok)`
    );

    try {
      await saveRequestUsage({
        connectionId: credentials?.id || null,
        provider: "gemini",
        model: targetModel,
        rawModel: targetModel,
        endpoint: "/v1/realtime",
        promptTokens,
        completionTokens,
        cachedTokens: 0,
        cost: 0,
        status: "success",
        statusCode: 200,
        durationMs,
      });
    } catch (err) {
      log.error("REALTIME_VOICE", "Failed to record session usage", err);
    }
  };
}
