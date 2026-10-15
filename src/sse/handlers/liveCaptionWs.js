import { WebSocket } from "ws";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getProviderCredentials, isValidApiKey } from "../services/auth.js";
import { chunkWords, chunksToSrt, chunksToAss } from "../utils/subtitleFormatter.js";
import { resolveProviderId, AI_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

function extractTokenFromRequest(req, url) {
  // Query param first (preferred for browser WebSockets)
  const queryToken = url.searchParams.get("apiKey")
    || url.searchParams.get("api_key")
    || url.searchParams.get("token")
    || url.searchParams.get("key");
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

/**
 * Convert REST baseUrl to Gemini Live WebSocket URL
 */
function toGeminiLiveWsUrl(baseUrl, model, token) {
  const url = new URL(baseUrl);
  url.protocol = "wss:";
  if (!url.pathname.startsWith("/ws/")) url.pathname = `/ws/api${url.pathname}`;
  const base = url.toString().replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(model)}:bidiGenerateContent?key=${encodeURIComponent(token || "")}`;
}

/**
 * Handle new WebSocket connection for Live Caption / Audio Streaming
 * @param {import("ws").WebSocket} clientWs
 * @param {import("http").IncomingMessage} req
 */
export async function handleLiveTranscriptionConnection(clientWs, req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  log.info("LIVE_CAPTION", `New WS connection from ${req.headers["x-9r-real-ip"] || req.socket.remoteAddress} - ${req.url}`);

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const token = extractTokenFromRequest(req, url);
    if (!token || !(await isValidApiKey(token))) {
      log.warn("LIVE_CAPTION", "Unauthorized WS connection rejected");
      clientWs.send(JSON.stringify({ type: "error", code: 4401, error: "Unauthorized: Invalid or missing API key" }));
      clientWs.close(4401, "Unauthorized");
      return;
    }
  }

  const modelParam = url.searchParams.get("model") || "dg/nova-3";
  const language = url.searchParams.get("language") || url.searchParams.get("lang") || "id";
  const requestedEncoding = url.searchParams.get("encoding") || "linear16";
  const sampleRate = parseInt(url.searchParams.get("sample_rate") || url.searchParams.get("sampleRate") || "16000", 10);

  const modelInfo = await getModelInfo(modelParam);
  if (!modelInfo.provider) {
    clientWs.send(JSON.stringify({ type: "error", error: `Invalid model specification: ${modelParam}` }));
    clientWs.close(4400, "Invalid model");
    return;
  }

  const { provider, model } = modelInfo;
  const canonicalProvider = resolveProviderId(provider);
  const providerMeta = AI_PROVIDERS[canonicalProvider];

  if (!providerMeta?.serviceKinds?.includes("liveCaption") && !providerMeta?.serviceKinds?.includes("stt")) {
    clientWs.send(JSON.stringify({ type: "error", error: `Provider ${provider} does not support live caption / STT` }));
    clientWs.close(4400, "Unsupported provider");
    return;
  }

  // Retrieve provider credentials from NineRouter
  const credentials = await getProviderCredentials(canonicalProvider, null, model);
  if (!credentials || credentials.allRateLimited) {
    const err = credentials?.lastError || `No credentials configured for provider: ${provider}`;
    clientWs.send(JSON.stringify({ type: "error", error: err }));
    clientWs.close(4503, err);
    return;
  }

  log.info("LIVE_CAPTION", `Connecting to upstream ${canonicalProvider} (${model}) using account: ${credentials.connectionName}`);

  // Notify client of successful connection handshake & active model
  clientWs.send(JSON.stringify({
    type: "connected",
    provider: canonicalProvider,
    model,
    language,
    sampleRate,
    encoding: requestedEncoding,
  }));

  // Accumulated word timings for this live session
  const sessionWords = [];
  let upstreamWs = null;
  let isClosing = false;
  let usageSaved = false;

  const cleanup = () => {
    isClosing = true;
    if (upstreamWs && (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING)) {
      try { upstreamWs.close(); } catch { /* ignore */ }
    }
    if (!usageSaved) {
      usageSaved = true;
      saveRequestUsage({
        provider: canonicalProvider,
        model,
        connectionId: credentials?.connectionId,
        apiKey: token,
        endpoint: "/v1/audio/live-transcriptions",
        tokens: { prompt_tokens: sessionWords.length, completion_tokens: 0 },
        status: "success",
      }).catch(() => {});
    }
  };

  clientWs.on("close", cleanup);
  clientWs.on("error", (err) => {
    log.error("LIVE_CAPTION", `Client WS error: ${err.message}`);
    cleanup();
  });

  // Dispatch upstream based on provider format
  try {
    if (canonicalProvider === "deepgram" || canonicalProvider === "dg") {
      await setupDeepgramUpstream({
        clientWs,
        credentials,
        model,
        language,
        sampleRate,
        requestedEncoding,
        sessionWords,
        setUpstream: (ws) => { upstreamWs = ws; },
        cleanup,
      });
    } else if (canonicalProvider === "gemini") {
      await setupGeminiLiveUpstream({
        clientWs,
        credentials,
        model,
        language,
        sessionWords,
        setUpstream: (ws) => { upstreamWs = ws; },
        cleanup,
      });
    } else {
      // Fallback for self-hosted or other providers
      await setupSelfhostedUpstream({
        clientWs,
        credentials,
        model,
        language,
        sessionWords,
        setUpstream: (ws) => { upstreamWs = ws; },
        cleanup,
      });
    }
  } catch (err) {
    log.error("LIVE_CAPTION", `Failed to initialize upstream connection: ${err.message}`);
    clientWs.send(JSON.stringify({ type: "error", error: `Upstream error: ${err.message}` }));
    clientWs.close(4502, "Upstream connection failed");
  }
}

/**
 * Setup Deepgram real-time streaming WebSocket
 */
async function setupDeepgramUpstream({ clientWs, credentials, model, language, sampleRate, requestedEncoding, sessionWords, setUpstream, cleanup }) {
  const token = credentials.apiKey;
  if (!token) throw new Error("Missing Deepgram API key");

  const dgParams = new URLSearchParams({
    model: model || "nova-3",
    language: language || "id",
    smart_format: "true",
    interim_results: "true",
    punctuate: "true",
    endpointing: "300",
  });

  if (requestedEncoding === "linear16" || requestedEncoding === "pcm") {
    dgParams.set("encoding", "linear16");
    dgParams.set("sample_rate", String(sampleRate || 16000));
  }

  const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;
  const dgWs = new WebSocket(dgUrl, {
    headers: {
      Authorization: `Token ${token}`,
    },
  });
  setUpstream(dgWs);

  dgWs.on("open", () => {
    log.info("LIVE_CAPTION", "Deepgram upstream WebSocket connected");
    clientWs.send(JSON.stringify({ type: "ready", upstream: "deepgram" }));
  });

  dgWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        const isFinal = Boolean(msg.is_final);
        const words = alt.words || [];

        for (const w of words) {
          const wordObj = {
            word: w.punctuated_word || w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
            isFinal,
          };

          if (isFinal) {
            sessionWords.push(wordObj);
          }

          clientWs.send(JSON.stringify({
            type: "word",
            ...wordObj,
          }));
        }

        // If final sentence or chunk, also emit aggregated chunk
        if (isFinal && alt.transcript?.trim()) {
          const recentChunks = chunkWords(sessionWords.slice(-20));
          const latestChunk = recentChunks[recentChunks.length - 1];
          if (latestChunk) {
            clientWs.send(JSON.stringify({
              type: "chunk",
              chunk: latestChunk,
            }));
          }
        }
      }
    } catch (e) {
      log.error("LIVE_CAPTION", `Deepgram message parse error: ${e.message}`);
    }
  });

  dgWs.on("error", (err) => {
    log.error("LIVE_CAPTION", `Deepgram upstream error: ${err.message}`);
    clientWs.send(JSON.stringify({ type: "error", error: `Deepgram: ${err.message}` }));
  });

  dgWs.on("close", (code, reason) => {
    log.info("LIVE_CAPTION", `Deepgram upstream closed (${code}): ${reason}`);
    clientWs.send(JSON.stringify({ type: "upstream_closed", code, reason: reason?.toString() }));
  });

  // Client to Deepgram message forwarding
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (dgWs.readyState === WebSocket.OPEN) {
        dgWs.send(data);
      }
    } else {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.type === "keepalive") {
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: "KeepAlive" }));
          }
        } else if (cmd.type === "finalize") {
          if (dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(JSON.stringify({ type: "Finalize" }));
          }
        } else if (cmd.type === "get_subtitles") {
          const chunks = chunkWords(sessionWords);
          const srt = chunksToSrt(chunks);
          const ass = chunksToAss(chunks);
          clientWs.send(JSON.stringify({
            type: "subtitles",
            format: cmd.format || "all",
            srt,
            ass,
            chunks,
          }));
        }
      } catch {
        // Not a control JSON command, ignore
      }
    }
  });
}

/**
 * Setup Gemini Live bidirectional streaming WebSocket
 */
async function setupGeminiLiveUpstream({ clientWs, credentials, model, language, sessionWords, setUpstream, cleanup }) {
  const token = credentials.apiKey;
  if (!token) throw new Error("Missing Gemini API key");

  const actualModel = model || "gemini-2.5-flash-native-audio-preview-09-17";
  const baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
  const wsUrl = toGeminiLiveWsUrl(baseUrl, actualModel, token);

  const geminiWs = new WebSocket(wsUrl);
  setUpstream(geminiWs);

  geminiWs.on("open", () => {
    log.info("LIVE_CAPTION", "Gemini Live upstream WebSocket connected");
    // Send initial configuration handshake
    const setupFrame = {
      setup: {
        model: `models/${actualModel}`,
        generationConfig: {
          responseModalities: ["TEXT"],
          inputAudioTranscription: {},
        },
        systemInstruction: {
          parts: [{ text: language ? `Transcribe the spoken audio verbatim in language ${language}.` : "Transcribe the spoken audio verbatim." }],
        },
      },
    };
    geminiWs.send(JSON.stringify(setupFrame));
    clientWs.send(JSON.stringify({ type: "ready", upstream: "gemini-live" }));
  });

  let currentStart = 0;

  geminiWs.on("message", (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.error) {
        clientWs.send(JSON.stringify({ type: "error", error: frame.error.message || "Gemini Live error" }));
        return;
      }

      const delta = frame.serverContent?.inputTranscription?.text;
      if (typeof delta === "string" && delta.trim()) {
        const now = Date.now();
        const wordText = delta.trim();
        const wordObj = {
          word: wordText,
          start: currentStart,
          end: currentStart + 0.4,
          isFinal: true,
        };
        currentStart += 0.4;
        sessionWords.push(wordObj);

        clientWs.send(JSON.stringify({
          type: "word",
          ...wordObj,
        }));
      }
    } catch (e) {
      log.error("LIVE_CAPTION", `Gemini message parse error: ${e.message}`);
    }
  });

  geminiWs.on("error", (err) => {
    log.error("LIVE_CAPTION", `Gemini upstream error: ${err.message}`);
    clientWs.send(JSON.stringify({ type: "error", error: `Gemini: ${err.message}` }));
  });

  geminiWs.on("close", (code, reason) => {
    log.info("LIVE_CAPTION", `Gemini upstream closed (${code}): ${reason}`);
    clientWs.send(JSON.stringify({ type: "upstream_closed", code, reason: reason?.toString() }));
  });

  // Client to Gemini streaming
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (geminiWs.readyState === WebSocket.OPEN) {
        const base64Audio = Buffer.from(data).toString("base64");
        geminiWs.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: base64Audio,
              },
            ],
          },
        }));
      }
    } else {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.type === "get_subtitles") {
          const chunks = chunkWords(sessionWords);
          clientWs.send(JSON.stringify({
            type: "subtitles",
            format: cmd.format || "all",
            srt: chunksToSrt(chunks),
            ass: chunksToAss(chunks),
            chunks,
          }));
        }
      } catch { /* ignore */ }
    }
  });
}

/**
 * Setup Self-hosted / OpenAI-compatible STT streaming
 */
async function setupSelfhostedUpstream({ clientWs, credentials, model, language, sessionWords, setUpstream, cleanup }) {
  log.info("LIVE_CAPTION", "Using Self-hosted STT handler");
  clientWs.send(JSON.stringify({ type: "ready", upstream: "selfhosted-stt" }));

  let audioBuffer = [];
  let bufferBytes = 0;
  const CHUNK_THRESHOLD = 32000 * 2; // ~2 seconds of 16kHz 16-bit mono

  const baseUrl = credentials.providerSpecificData?.baseUrl || "http://localhost:8080/v1/audio/transcriptions";

  const flushBuffer = async () => {
    if (audioBuffer.length === 0) return;
    const combined = Buffer.concat(audioBuffer);
    audioBuffer = [];
    bufferBytes = 0;

    try {
      const formData = new FormData();
      formData.append("file", new Blob([combined], { type: "audio/wav" }), "audio.wav");
      formData.append("model", model || "whisper-1");
      formData.append("response_format", "verbose_json");
      if (language) formData.append("language", language);

      const headers = {};
      if (credentials.apiKey && credentials.apiKey !== "none") {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }

      const res = await fetch(baseUrl, {
        method: "POST",
        headers,
        body: formData,
      });

      if (res.ok) {
        const result = await res.json();
        const words = result.words || [];
        for (const w of words) {
          const wordObj = {
            word: w.word,
            start: w.start,
            end: w.end,
            isFinal: true,
          };
          sessionWords.push(wordObj);
          clientWs.send(JSON.stringify({ type: "word", ...wordObj }));
        }
      }
    } catch (e) {
      log.error("LIVE_CAPTION", `Self-hosted STT flush error: ${e.message}`);
    }
  };

  clientWs.on("message", async (data, isBinary) => {
    if (isBinary) {
      audioBuffer.push(Buffer.from(data));
      bufferBytes += data.length;
      if (bufferBytes >= CHUNK_THRESHOLD) {
        await flushBuffer();
      }
    } else {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.type === "finalize") {
          await flushBuffer();
        } else if (cmd.type === "get_subtitles") {
          const chunks = chunkWords(sessionWords);
          clientWs.send(JSON.stringify({
            type: "subtitles",
            format: cmd.format || "all",
            srt: chunksToSrt(chunks),
            ass: chunksToAss(chunks),
            chunks,
          }));
        }
      } catch { /* ignore */ }
    }
  });
}
