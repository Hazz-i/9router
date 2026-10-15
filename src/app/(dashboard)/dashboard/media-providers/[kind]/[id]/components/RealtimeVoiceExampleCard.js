"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, Badge } from "@/shared/components";
import { getProviderAlias } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "./exampleShared";

const GEMINI_VOICES = [
  { id: "Puck", label: "Puck (Natural & Expressive)" },
  { id: "Charon", label: "Charon (Calm & Deep)" },
  { id: "Kore", label: "Kore (Warm & Friendly)" },
  { id: "Fenrir", label: "Fenrir (Energetic)" },
  { id: "Aoede", label: "Aoede (Clear & Soft)" },
];

export function RealtimeVoiceExampleCard({ providerId }) {
  const providerAlias = getProviderAlias(providerId);

  const [selectedVoice, setSelectedVoice] = useState("Puck");
  const [instructions, setInstructions] = useState(
    "You are a friendly, helpful AI voice assistant. Speak naturally and concisely in Indonesian or English."
  );
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");

  const [isCalling, setIsCalling] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("idle"); // idle | connecting | connected | speaking | listening | error
  const [statusMessage, setStatusMessage] = useState("");
  const [messages, setMessages] = useState([]); // [{ id, role: "user" | "assistant", text: "" }]
  const [micVolume, setMicVolume] = useState(0);

  const { copied: copiedWs, copy: copyWs } = useCopyToClipboard();

  const wsRef = useRef(null);
  const audioContextInRef = useRef(null);
  const audioContextOutRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef([]);
  const transcriptEndRef = useRef(null);

  const stopCall = useCallback(() => {
    setIsCalling(false);

    // Stop microphone processing
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch { /* ignore */ }
      processorRef.current = null;
    }
    if (audioContextInRef.current) {
      try { audioContextInRef.current.close(); } catch { /* ignore */ }
      audioContextInRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    // Stop all playing audio sources
    for (const src of activeSourcesRef.current) {
      try { src.stop(); } catch { /* ignore */ }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;

    if (audioContextOutRef.current) {
      try { audioContextOutRef.current.close(); } catch { /* ignore */ }
      audioContextOutRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close(1000, "User ended call");
        }
      } catch { /* ignore */ }
      wsRef.current = null;
    }

    setConnectionStatus("idle");
    setStatusMessage("");
    setMicVolume(0);
  }, []);

  useEffect(() => {
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
      stopCall();
    };
  }, [stopCall]);

  const localEndpoint = typeof window !== "undefined" ? window.location.origin : "";
  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const wsProtocol = endpoint.startsWith("https") ? "wss:" : "ws:";
  const wsHost = endpoint.replace(/^https?:\/\//, "");
  const wsUrl = `${wsProtocol}//${wsHost}/v1/realtime?model=gemini-3.8-live&voice=${encodeURIComponent(selectedVoice)}${apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ""}`;

  // Auto-scroll transcript container to bottom when messages update
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  const arrayBufferToBase64 = (buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  // Play incoming 24kHz PCM audio chunk smoothly
  const playPcm24kChunk = (base64Audio) => {
    try {
      if (!audioContextOutRef.current) {
        audioContextOutRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      }
      const ctx = audioContextOutRef.current;
      if (ctx.state === "suspended") ctx.resume();

      const binaryStr = window.atob(base64Audio);
      const len = binaryStr.length;
      const buffer = new ArrayBuffer(len);
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const pcm16 = new Int16Array(buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768.0;
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;

      activeSourcesRef.current.push(source);
      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
        if (activeSourcesRef.current.length === 0) {
          setConnectionStatus("listening");
        }
      };

      setConnectionStatus("speaking");
    } catch (e) {
      console.warn("[VoicePlayground] Audio play error:", e);
    }
  };

  const startCall = async () => {
    try {
      setConnectionStatus("connecting");
      setStatusMessage("Requesting microphone permission...");
      setMessages([]);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextInRef.current = audioCtx;

      const sourceNode = audioCtx.createMediaStreamSource(stream);
      // Analyser for UI mic volume wave
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      sourceNode.connect(analyser);

      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVolume = () => {
        if (!processorRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        setMicVolume(Math.min(100, Math.round((sum / dataArray.length) * 1.5)));
        requestAnimationFrame(updateVolume);
      };
      requestAnimationFrame(updateVolume);

      setStatusMessage("Connecting to 9Router Voice Gateway...");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("connected");
        setStatusMessage("Connected! Say something or listen...");
        setIsCalling(true);

        // Send session.update with user instructions & voice
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              voice: selectedVoice,
              instructions,
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
            },
          })
        );

        // Hook up audio processor to stream mic chunks
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmBuffer = convertFloatTo16BitPCM(inputData);
          const base64Audio = arrayBufferToBase64(pcmBuffer);

          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64Audio,
            })
          );
        };

        sourceNode.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          if (msg.type === "response.audio.delta" && msg.delta) {
            playPcm24kChunk(msg.delta);
          } else if (msg.type === "response.audio_transcript.delta" && msg.delta) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant" && !last.isDone) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, text: last.text + msg.delta },
                ];
              }
              return [
                ...prev,
                { id: Date.now(), role: "assistant", text: msg.delta, isDone: false },
              ];
            });
          } else if (msg.type === "response.done") {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === "assistant") {
                return [...prev.slice(0, -1), { ...last, isDone: true }];
              }
              return prev;
            });
          } else if (msg.type === "input_audio_buffer.speech_started") {
            // User interrupted AI: cancel pending audio playback immediately
            for (const s of activeSourcesRef.current) {
              try { s.stop(); } catch { /* ignore */ }
            }
            activeSourcesRef.current = [];
            if (audioContextOutRef.current) {
              nextPlayTimeRef.current = audioContextOutRef.current.currentTime;
            }
            setConnectionStatus("listening");
          } else if (msg.type === "error") {
            console.error("[VoicePlayground] Server error:", msg.error);
            setStatusMessage(`Error: ${msg.error?.message || "Unknown error"}`);
            setConnectionStatus("error");
          }
        } catch (err) {
          console.warn("[VoicePlayground] Message parse error:", err);
        }
      };

      ws.onerror = () => {
        setConnectionStatus("error");
        setStatusMessage("WebSocket connection error. Check server logs or API key.");
      };

      ws.onclose = () => {
        stopCall();
      };
    } catch (err) {
      console.error("[VoicePlayground] Start failed:", err);
      setConnectionStatus("error");
      setStatusMessage(`Failed to access microphone: ${err.message}`);
      stopCall();
    }
  };

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Realtime Voice Agent</h2>
            <Badge variant="primary" size="sm">OpenAI Realtime Protocol</Badge>
            <Badge variant="neutral" size="sm">Gemini Live</Badge>
          </div>
          <p className="text-sm text-text-muted">
            Bidirectional real-time voice conversation with Gemini 2.0 Flash via WebSocket (`/v1/realtime`).
          </p>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2">
          {connectionStatus === "connected" && <Badge variant="success" size="sm">Connected</Badge>}
          {connectionStatus === "speaking" && <Badge variant="primary" size="sm" className="animate-pulse">AI Speaking...</Badge>}
          {connectionStatus === "listening" && <Badge variant="neutral" size="sm" className="animate-pulse">Listening...</Badge>}
          {connectionStatus === "connecting" && <Badge variant="warning" size="sm">Connecting...</Badge>}
          {connectionStatus === "error" && <Badge variant="error" size="sm">Error</Badge>}
          {connectionStatus === "idle" && <Badge variant="neutral" size="sm">Ready</Badge>}
        </div>
      </div>

      {/* Settings Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border border-border/60 rounded-xl p-4 bg-surface/50">
        <div>
          <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">AI Voice</label>
          <select
            value={selectedVoice}
            onChange={(e) => setSelectedVoice(e.target.value)}
            disabled={isCalling}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
          >
            {GEMINI_VOICES.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider">Connection Endpoint</label>
            {tunnelEndpoint && (
              <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={useTunnel}
                  onChange={(e) => setUseTunnel(e.target.checked)}
                  disabled={isCalling}
                  className="rounded border-border text-primary focus:ring-primary/50"
                />
                Use Public Tunnel
              </label>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={wsUrl}
              className="flex-1 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs font-mono text-text-muted truncate select-all"
            />
            <Button variant="secondary" size="sm" onClick={() => copyWs(wsUrl)}>
              {copiedWs ? "Copied!" : "Copy"}
            </Button>
          </div>
        </div>

        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">System Instructions</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={isCalling}
            rows={2}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-50"
            placeholder="Prompt for the voice agent..."
          />
        </div>
      </div>

      {/* Main Interactive Call Box */}
      <div className="flex flex-col items-center justify-center py-6 px-4 rounded-xl border border-border/80 bg-bg-subtle/40 gap-4">
        {/* Pulsing visualizer circle */}
        <div className="relative flex items-center justify-center size-28">
          {isCalling && (
            <>
              <div
                className={`absolute inset-0 rounded-full transition-all duration-150 ${connectionStatus === "speaking" ? "bg-primary/20 animate-ping" : "bg-success/20"}`}
                style={{
                  transform: `scale(${1 + (micVolume / 100) * 0.5})`,
                }}
              />
              <div
                className={`absolute inset-2 rounded-full opacity-60 transition-all duration-100 ${connectionStatus === "speaking" ? "bg-primary/30" : "bg-success/30"}`}
                style={{
                  transform: `scale(${1 + (micVolume / 100) * 0.3})`,
                }}
              />
            </>
          )}

          <div
            className={`size-20 rounded-full flex items-center justify-center text-white shadow-lg transition-all ${
              isCalling
                ? connectionStatus === "speaking"
                  ? "bg-primary shadow-primary/30"
                  : "bg-success shadow-success/30"
                : "bg-text-muted/30"
            }`}
          >
            <span className="material-symbols-outlined text-3xl">
              {isCalling ? (connectionStatus === "speaking" ? "volume_up" : "mic") : "phone_in_talk"}
            </span>
          </div>
        </div>

        {/* Status message */}
        <div className="text-center">
          <p className="text-sm font-medium text-text-main">
            {isCalling ? statusMessage || (connectionStatus === "speaking" ? "AI is speaking..." : "Listening to you...") : "Ready to start voice conversation"}
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            {isCalling ? "Speak into your microphone. You can interrupt anytime." : "Click below to connect your microphone and talk to Gemini Live."}
          </p>
        </div>

        {/* Start / Stop action button */}
        {!isCalling ? (
          <Button variant="primary" size="md" onClick={startCall} className="gap-2 px-6">
            <span className="material-symbols-outlined text-lg">mic</span>
            Start Voice Conversation
          </Button>
        ) : (
          <Button variant="danger" size="md" onClick={stopCall} className="gap-2 px-6">
            <span className="material-symbols-outlined text-lg">call_end</span>
            End Voice Call
          </Button>
        )}
      </div>

      {/* Live Transcript Log */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Live Transcript</span>
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-xs text-text-muted hover:text-text-main transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <div className="h-44 overflow-y-auto rounded-xl border border-border/80 bg-surface p-3 flex flex-col gap-2 text-xs">
          {messages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-text-muted italic">
              Spoken conversation and AI responses will appear here in real time...
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col gap-1 ${m.role === "assistant" ? "items-start" : "items-end"}`}
              >
                <div
                  className={`px-3 py-2 rounded-xl max-w-[85%] leading-relaxed ${
                    m.role === "assistant"
                      ? "bg-bg-subtle text-text-main border border-border"
                      : "bg-primary text-white"
                  }`}
                >
                  <p className="font-semibold text-[10px] uppercase opacity-75 mb-0.5">
                    {m.role === "assistant" ? "Gemini Voice" : "You"}
                  </p>
                  <p>{m.text}</p>
                </div>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>
      </div>

      {/* Developer Integration Code Snippet */}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Developer Integration (Python / OpenAI Realtime Client)</span>
        <pre className="p-3 rounded-lg bg-bg-subtle text-xs font-mono overflow-x-auto text-text-main border border-border">
{`# Connect using any OpenAI Realtime compatible client
import asyncio
import websockets
import json

async function voice_session():
    uri = "${wsUrl.split("?")[0]}?model=gemini-3.8-live"
    headers = {"Authorization": "Bearer YOUR_9ROUTER_KEY"}
    async with websockets.connect(uri, extra_headers=headers) as ws:
        # 1. Update session
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {"voice": "${selectedVoice}", "instructions": "Halo!"}
        }))
        
        # 2. Send 16kHz PCM audio chunk
        # await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": "<base64_pcm16>"}))

asyncio.run(voice_session())`}
        </pre>
      </div>
    </Card>
  );
}
