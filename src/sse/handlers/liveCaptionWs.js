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

  let token = null;
  const settings = await getSettings();
  if (settings.requireApiKey) {
    token = extractTokenFromRequest(req, url);
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
    } else if (canonicalProvider === "elevenlabs" || canonicalProvider === "el") {
      await setupElevenLabsScribeUpstream({
        clientWs,
        credentials,
        model,
        language,
        sampleRate,
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

        // Interim results re-report the same segment every time it firms up, so
        // they must never be appended as committed words — that is what printed
        // the transcript twice. Interim text rides `partial`, which the card
        // renders as a provisional line and clears when the utterance commits.
        if (!isFinal) {
          if (alt.transcript?.trim()) {
            clientWs.send(JSON.stringify({ type: "partial", text: alt.transcript }));
          }
          return;
        }

        // A client `Finalize` makes Deepgram re-emit the segment it already
        // committed. Skip anything we have already stored so those words are not
        // counted twice. Words carry their own timings, so overlap is detectable.
        let lastEnd = sessionWords.length ? sessionWords[sessionWords.length - 1].end : -1;

        for (const w of words) {
          if (typeof w.start === "number" && w.start <= lastEnd) continue;

          const wordObj = {
            word: w.punctuated_word || w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
            isFinal,
          };

          sessionWords.push(wordObj);
          if (typeof wordObj.end === "number") lastEnd = wordObj.end;

          clientWs.send(JSON.stringify({
            type: "word",
            ...wordObj,
          }));
        }

        // If final sentence or chunk, also emit aggregated chunk
        if (alt.transcript?.trim()) {
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
 * Setup ElevenLabs Scribe real-time streaming WebSocket
 */
async function setupElevenLabsScribeUpstream({ clientWs, credentials, model, language, sampleRate, sessionWords, setUpstream, cleanup }) {
  const token = credentials.apiKey;
  if (!token) throw new Error("Missing ElevenLabs API key");

  // ElevenLabs real-time endpoint only accepts scribe_v2_realtime
  const elParams = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    audio_format: `pcm_${sampleRate || 16000}`,
    include_timestamps: "true",
  });
  if (language && language !== "auto") {
    elParams.set("language_code", language);
  }

  const elUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${elParams.toString()}`;
  const elWs = new WebSocket(elUrl, {
    headers: {
      "xi-api-key": token,
    },
  });
  setUpstream(elWs);

  elWs.on("open", () => {
    log.info("LIVE_CAPTION", "ElevenLabs Scribe upstream WebSocket connected");
  });

  let currentStart = 0;

  elWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.message_type === "session_started") {
        log.info("LIVE_CAPTION", `ElevenLabs Scribe session started: ${msg.session_id}`);
        clientWs.send(JSON.stringify({ type: "ready", upstream: "elevenlabs-scribe" }));
        return;
      }

      if (msg.message_type === "partial_transcript" && msg.text?.trim()) {
        clientWs.send(JSON.stringify({
          type: "partial",
          text: msg.text.trim(),
          isFinal: false,
        }));
      } else if (msg.message_type === "committed_transcript_with_timestamps") {
        const words = (msg.words || []).filter((w) => w.type === "word" && w.text?.trim());
        for (const w of words) {
          const wordObj = {
            word: w.text.trim(),
            start: typeof w.start === "number" ? w.start : currentStart,
            end: typeof w.end === "number" ? w.end : currentStart + 0.3,
            confidence: typeof w.logprob === "number" ? Math.min(1, Math.exp(w.logprob)) : 0.95,
            isFinal: true,
          };
          currentStart = Math.max(currentStart, wordObj.end);
          sessionWords.push(wordObj);
          clientWs.send(JSON.stringify({
            type: "word",
            ...wordObj,
          }));
        }

        if (msg.text?.trim()) {
          const firstWord = words[0];
          const lastWord = words[words.length - 1];
          clientWs.send(JSON.stringify({
            type: "chunk",
            chunk: {
              text: msg.text.trim(),
              start: firstWord?.start ?? currentStart,
              end: lastWord?.end ?? currentStart,
            },
          }));
        }
      } else if (msg.message_type === "committed_transcript" && msg.text?.trim()) {
        const text = msg.text.trim();
        const wordTokens = text.split(/\s+/);
        const duration = Math.max(0.4, wordTokens.length * 0.3);
        const chunkObj = {
          text,
          start: currentStart,
          end: currentStart + duration,
        };

        for (const w of wordTokens) {
          const wordObj = {
            word: w,
            start: currentStart,
            end: currentStart + 0.3,
            confidence: 0.95,
            isFinal: true,
          };
          sessionWords.push(wordObj);
          clientWs.send(JSON.stringify({
            type: "word",
            ...wordObj,
          }));
        }
        currentStart += duration;

        clientWs.send(JSON.stringify({
          type: "chunk",
          chunk: chunkObj,
        }));
      }
    } catch (e) {
      log.error("LIVE_CAPTION", `ElevenLabs Scribe parse error: ${e.message}`);
    }
  });

  elWs.on("error", (err) => {
    log.error("LIVE_CAPTION", `ElevenLabs Scribe upstream error: ${err.message}`);
    clientWs.send(JSON.stringify({ type: "error", error: `ElevenLabs Scribe: ${err.message}` }));
  });

  elWs.on("close", (code, reason) => {
    log.info("LIVE_CAPTION", `ElevenLabs Scribe upstream closed (${code}): ${reason}`);
    clientWs.send(JSON.stringify({ type: "upstream_closed", code, reason: reason?.toString() }));
  });

  // Client to ElevenLabs forwarding
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (elWs.readyState === WebSocket.OPEN) {
        elWs.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: Buffer.from(data).toString("base64"),
        }));
      }
    } else {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.type === "finalize") {
          if (elWs.readyState === WebSocket.OPEN) {
            elWs.send(JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: "",
              commit: true,
            }));
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

  let actualModel = model || "gemini-3.8-live";
  if (
    actualModel === "gemini-2.0-flash-exp" ||
    actualModel === "gemini-2.0-flash-realtime" ||
    actualModel === "gemini-2.5-flash-native-audio-preview-09-17"
  ) {
    actualModel = "gemini-3.8-live";
  }
  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(token)}`;

  const geminiWs = new WebSocket(wsUrl);
  setUpstream(geminiWs);

  geminiWs.on("open", () => {
    log.info("LIVE_CAPTION", "Gemini Live upstream WebSocket connected");
    // Send initial configuration handshake
    const setupFrame = {
      setup: {
        model: `models/${actualModel}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Puck" },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: language ? `Transcribe the spoken audio verbatim in language ${language}.` : "Transcribe the spoken audio verbatim." }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
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

      const delta = frame.serverContent?.outputTranscription?.text || frame.serverContent?.inputTranscription?.text;
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
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: base64Audio,
            },
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
