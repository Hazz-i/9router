"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, Badge } from "@/shared/components";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "./exampleShared";
import { chunkWords, chunksToSrt, chunksToAss } from "@/sse/utils/subtitleFormatter";

export function LiveCaptionExampleCard({ providerId }) {
  const providerAlias = getProviderAlias(providerId);
  const builtinModels = getModelsByProviderId(providerId).filter(
    (m) => m.kinds?.includes("liveCaption") || m.kinds?.includes("stt") || getModelKind(m) === "stt"
  );

  const [selectedModel, setSelectedModel] = useState(builtinModels[0]?.id ?? "");
  const [language, setLanguage] = useState("id");
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");

  const [isRecording, setIsRecording] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("idle"); // idle | connecting | connected | error
  const [statusMessage, setStatusMessage] = useState("");
  const [words, setWords] = useState([]);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [subtitles, setSubtitles] = useState({ srt: "", ass: "" });
  const [localEndpoint, setLocalEndpoint] = useState("");

  const { copied: copiedWs, copy: copyWs } = useCopyToClipboard();
  const { copied: copiedSrt, copy: copySrt } = useCopyToClipboard();
  const { copied: copiedAss, copy: copyAss } = useCopyToClipboard();

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const transcriptEndRef = useRef(null);

  const stopRecording = useCallback(() => {
    setIsRecording(false);

    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch { /* ignore */ }
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "finalize" }));
          wsRef.current.close(1000, "User stopped recording");
        }
      } catch { /* ignore */ }
      wsRef.current = null;
    }

    setConnectionStatus("idle");
  }, []);

  useEffect(() => {
    Promise.resolve().then(() => setLocalEndpoint(window.location.origin));

    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => {
        setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || "");
      })
      .catch(() => {});

    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => {
        if (d.publicUrl) setTunnelEndpoint(d.publicUrl);
      })
      .catch(() => {});

    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  // Auto-scroll transcript container to bottom when new words arrive
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [words]);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const wsProtocol = endpoint.startsWith("https") ? "wss:" : "ws:";
  const wsHost = endpoint.replace(/^https?:\/\//, "");
  const modelFull = selectedModel ? `${providerAlias}/${selectedModel}` : "";

  const wsUrl = `${wsProtocol}//${wsHost}/v1/audio/live-transcriptions?model=${encodeURIComponent(modelFull)}&language=${encodeURIComponent(language)}&encoding=linear16&sample_rate=16000${apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ""}`;

  // Convert Float32Array from microphone to 16-bit PCM Linear
  const convertFloatTo16BitPCM = (float32Array) => {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  };

  const startRecording = async () => {
    try {
      setConnectionStatus("connecting");
      setStatusMessage("Requesting microphone permission...");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      setStatusMessage("Connecting to NineRouter WebSocket...");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("connected");
        setStatusMessage("WebSocket connected. Starting audio stream...");
        setIsRecording(true);

        // Setup Web Audio API pipeline
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        audioContextRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);

        // Buffer size 4096 (~250ms chunks at 16kHz)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN) {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmBuffer = convertFloatTo16BitPCM(inputData);
            ws.send(pcmBuffer);
          }
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ready") {
            setStatusMessage(`Ready. Upstream provider: ${data.upstream}`);
          } else if (data.type === "partial") {
            setPartialTranscript(data.text || "");
          } else if (data.type === "word") {
            setPartialTranscript("");
            setWords((prev) => {
              const updated = [...prev, data];
              setActiveWordIndex(updated.length - 1);

              // Update live SRT and ASS
              const chunks = chunkWords(updated);
              setSubtitles({
                srt: chunksToSrt(chunks),
                ass: chunksToAss(chunks),
              });

              return updated;
            });
          } else if (data.type === "chunk") {
            setPartialTranscript("");
          } else if (data.type === "error") {
            setStatusMessage(`Error: ${data.error}`);
            setConnectionStatus("error");
          }
        } catch {
          // Non-JSON message
        }
      };

      ws.onerror = () => {
        setConnectionStatus("error");
        setStatusMessage("WebSocket connection failed.");
      };

      ws.onclose = (e) => {
        setIsRecording(false);
        setConnectionStatus("idle");
        setStatusMessage(e.reason ? `Connection closed: ${e.reason}` : "Connection closed.");
      };
    } catch (err) {
      console.error("Microphone or WebSocket error:", err);
      setConnectionStatus("error");
      setStatusMessage(`Microphone error: ${err.message}`);
      stopRecording();
    }
  };

  const handleClear = () => {
    setWords([]);
    setPartialTranscript("");
    setActiveWordIndex(-1);
    setSubtitles({ srt: "", ass: "" });
  };

  return (
    <Card>
      <div className="flex flex-col gap-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/40 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[22px]">closed_caption</span>
              <h2 className="text-base font-semibold">Live Caption & Streaming Playground</h2>
              <Badge variant="primary" size="sm">REALTIME WS</Badge>
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              Stream live microphone audio directly to upstream providers via NineRouter with word-level karaoke sync.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {!isRecording ? (
              <Button
                variant="primary"
                size="sm"
                onClick={startRecording}
                disabled={connectionStatus === "connecting"}
                icon="mic"
              >
                {connectionStatus === "connecting" ? "Connecting..." : "Start Microphone"}
              </Button>
            ) : (
              <Button variant="danger" size="sm" onClick={stopRecording} icon="stop">
                Stop Streaming
              </Button>
            )}

            {words.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClear} icon="delete_sweep">
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Options */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <Row label="Model">
            <select
              className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary font-mono"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isRecording}
            >
              {builtinModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Language">
            <input
              type="text"
              className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary font-mono"
              placeholder="id, en, etc."
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={isRecording}
            />
          </Row>

          {tunnelEndpoint && (
            <Row label="Endpoint Source">
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant={!useTunnel ? "primary" : "secondary"}
                  onClick={() => setUseTunnel(false)}
                >
                  Local
                </Button>
                <Button
                  size="xs"
                  variant={useTunnel ? "primary" : "secondary"}
                  onClick={() => setUseTunnel(true)}
                >
                  Tunnel
                </Button>
              </div>
            </Row>
          )}
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2 text-xs">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              isRecording
                ? "bg-red-500 animate-pulse"
                : connectionStatus === "connected"
                ? "bg-green-500"
                : connectionStatus === "error"
                ? "bg-amber-500"
                : "bg-border"
            }`}
          />
          <span className="font-mono text-text-muted">
            {isRecording ? "🔴 Streaming Audio" : connectionStatus.toUpperCase()}
          </span>
          {statusMessage && (
            <span className="text-text-muted/80 text-[11px] truncate">· {statusMessage}</span>
          )}
        </div>

        {/* Live Karaoke Caption Visualizer */}
        <div className="relative min-h-[140px] max-h-[220px] overflow-y-auto p-4 rounded-xl border border-border/60 bg-surface-2/40 backdrop-blur-sm flex flex-col justify-between">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-base sm:text-lg leading-relaxed">
            {words.length === 0 && !partialTranscript ? (
              <span className="text-xs text-text-muted/60 italic">
                {isRecording ? "Listening... Speak into your microphone" : "Click 'Start Microphone' to begin real-time live captioning"}
              </span>
            ) : (
              words.map((w, idx) => {
                const isActive = idx === activeWordIndex;
                return (
                  <span
                    key={`${w.word}-${w.start}-${idx}`}
                    className={`transition-all duration-200 px-1 py-0.5 rounded ${
                      isActive
                        ? "bg-amber-400 text-black font-bold scale-105 shadow-sm"
                        : "text-text-main hover:text-primary font-medium"
                    }`}
                    title={`Start: ${w.start?.toFixed(2)}s | End: ${w.end?.toFixed(2)}s`}
                  >
                    {w.word}
                  </span>
                );
              })
            )}
            {partialTranscript && (
              <span className="basis-full text-sm text-text-muted italic">
                In progress · {partialTranscript}
              </span>
            )}
            <div ref={transcriptEndRef} />
          </div>

          {words.length > 0 && (
            <div className="flex items-center justify-between pt-3 mt-3 border-t border-border/30 text-[11px] text-text-muted">
              <span>{words.length} words detected</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copySrt(subtitles.srt)}
                  className="px-2 py-0.5 rounded border border-border bg-background hover:bg-sidebar transition-colors"
                >
                  {copiedSrt ? "✓ Copied SRT" : "Copy .SRT"}
                </button>
                <button
                  onClick={() => copyAss(subtitles.ass)}
                  className="px-2 py-0.5 rounded border border-border bg-background hover:bg-sidebar transition-colors"
                >
                  {copiedAss ? "✓ Copied ASS" : "Copy .ASS (Karaoke)"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* WebSocket Connection Snippet */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border/30">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-muted font-medium">WebSocket Endpoint URL</span>
            <button
              onClick={() => copyWs(wsUrl)}
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">
                {copiedWs ? "check" : "content_copy"}
              </span>
              {copiedWs ? "Copied" : "Copy WS URL"}
            </button>
          </div>
          <code className="text-xs font-mono p-2.5 rounded-lg bg-sidebar border border-border/60 text-text-muted break-all select-all">
            {wsUrl}
          </code>
        </div>
      </div>
    </Card>
  );
}
