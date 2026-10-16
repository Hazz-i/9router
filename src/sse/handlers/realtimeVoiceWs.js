import { WebSocketServer, WebSocket } from "ws";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getProviderCredentials, isValidApiKey } from "../services/auth.js";
import { resolveProviderId, AI_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import crypto from "crypto";
import { createRealtimeAdapter } from "./realtime/index.js";

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

export function getRealtimeWsServer() {
  if (!realtimeWsServer) {
    realtimeWsServer = new WebSocketServer({ noServer: true });
    realtimeWsServer.on("connection", handleRealtimeVoiceConnection);
  }
  return realtimeWsServer;
}

/**
 * Handle incoming WebSocket connection for /v1/realtime
 * Provider-specific upstream speak lives in ./realtime/*Adapter.js — this entry
 * keeps auth, model/credential resolution, the client socket plumbing and
 * session usage accounting.
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

  // Resolve requested model & provider
  const rawModelParam = url.searchParams.get("model") || "gemini/gemini-3.8-live";
  const voiceParam = url.searchParams.get("voice") || "Puck";
  const modelInfo = await getModelInfo(rawModelParam);
  const targetModel = modelInfo?.model || "gemini-3.8-live";
  const provider = resolveProviderId(modelInfo?.provider || "gemini");

  const realtimeConfig = AI_PROVIDERS[provider]?.realtimeConfig;
  if (!realtimeConfig) {
    const errMsg = `Provider ${provider} does not support realtime voice`;
    log.error("REALTIME_VOICE", errMsg);
    clientWs.send(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", code: "provider_unsupported", message: errMsg },
      })
    );
    clientWs.close(4400, "Unsupported provider");
    return;
  }

  // Lookup provider credentials
  let credentials = await getProviderCredentials(provider, null, targetModel);
  let apiKey = credentials?.apiKey || process.env[`${provider.toUpperCase()}_API_KEY`];

  if (!apiKey && provider === "gemini") {
    // Check if there are other gemini accounts in db
    credentials = await getProviderCredentials("gemini", null, null);
    apiKey = credentials?.apiKey || process.env.GEMINI_API_KEY;
  }
  if (!apiKey) {
    const errMsg = `No API key configured for ${provider}. Please add a ${provider} connection in 9Router Dashboard or set ${provider.toUpperCase()}_API_KEY environment variable.`;
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

  // Shared adapter context: client senders + usage accounting knobs.
  const startTime = Date.now();
  let inputAudioBytes = 0;
  let outputAudioBytes = 0;
  let inputRate = realtimeConfig.audioInRate || 16000;
  let outputRate = realtimeConfig.audioOutRate || 24000;
  const ctx = {
    config: realtimeConfig,
    provider,
    model: targetModel,
    voice: voiceParam,
    instructions: "You are a helpful and concise AI voice assistant. Speak naturally in Indonesian or English.",
    credentials,
    apiKey,
    query: url.searchParams,
    sendClient: (obj) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj));
    },
    closeClient: (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
    },
    isClientOpen: () => clientWs.readyState === WebSocket.OPEN,
    countInput: (bytes) => {
      inputAudioBytes += bytes;
    },
    countOutput: (bytes) => {
      outputAudioBytes += bytes;
    },
    setInputRate: (r) => {
      inputRate = r;
    },
    setOutputRate: (r) => {
      outputRate = r;
    },
    // For Gemini's speech_started audio_start_ms field
    millisSinceStart: () => Date.now() - startTime,
  };

  let isClosed = false;
  let adapter = null;
  try {
    adapter = createRealtimeAdapter(provider, ctx);
  } catch (err) {
    // Adapter config errors (missing agent id / think credentials) surface here
    log.error("REALTIME_VOICE", err.message);
    ctx.sendClient({
      type: "error",
      error: { type: "invalid_request_error", code: "realtime_config_error", message: err.message },
    });
    clientWs.close(4400, err.message.slice(0, 100));
    return;
  }

  adapter
    .connect()
    .then(() => {
      log.info("REALTIME_VOICE", `Upstream adapter for ${provider} connected`);
    })
    .catch((err) => {
      log.error("REALTIME_VOICE", "Failed to initiate upstream connection", err);
      ctx.sendClient({
        type: "error",
        error: { type: "server_error", message: `Failed to initiate upstream connection: ${err.message}` },
      });
      clientWs.close(4500, "Upstream error");
    });

  // Handle client messages (OpenAI Realtime Protocol) — routing only; all
  // upstream translation is the adapter's job.
  clientWs.on("message", (data, isBinary) => {
    if (!adapter) return;
    try {
      // Binary payload: raw audio chunk from client
      if (isBinary) {
        ctx.countInput(data.length);
        adapter.handleClientAudio(data);
        return;
      }
      const event = JSON.parse(data.toString("utf8"));
      if (event.type === "input_audio_buffer.append" && event.audio) {
        ctx.countInput(Buffer.byteLength(event.audio, "base64"));
      }
      adapter.handleClientEvent(event);
    } catch (err) {
      log.warn("REALTIME_VOICE", "Error handling client event", err.message);
    }
  });

  clientWs.on("close", () => {
    log.info("REALTIME_VOICE", "Client disconnected");
    adapter?.close();
    recordSessionUsage();
  });

  clientWs.on("error", (err) => {
    log.error("REALTIME_VOICE", "Client socket error", err.message);
    adapter?.close();
    recordSessionUsage();
  });

  const recordSessionUsage = async () => {
    if (isClosed) return;
    isClosed = true;

    const durationMs = Date.now() - startTime;
    // Estimate audio tokens (~25 tokens per second of PCM audio)
    const inSeconds = inputAudioBytes / (inputRate * 2);
    const outSeconds = outputAudioBytes / (outputRate * 2);
    const promptTokens = Math.max(1, Math.round(inSeconds * 25));
    const completionTokens = Math.max(1, Math.round(outSeconds * 25));

    log.info(
      "REALTIME_VOICE",
      `Session ended: ${Math.round(durationMs / 1000)}s | Audio In: ${Math.round(inSeconds)}s (${promptTokens} tok) | Out: ${Math.round(outSeconds)}s (${completionTokens} tok)`
    );

    try {
      await saveRequestUsage({
        connectionId: credentials?.id || null,
        provider,
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
