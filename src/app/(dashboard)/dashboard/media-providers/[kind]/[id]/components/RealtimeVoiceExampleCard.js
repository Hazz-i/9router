"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, Badge } from "@/shared/components";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "./exampleShared";

const GEMINI_VOICES = [
  { id: "Puck", label: "Puck (Natural & Expressive)" },
  { id: "Charon", label: "Charon (Calm & Deep)" },
  { id: "Kore", label: "Kore (Warm & Friendly)" },
  { id: "Fenrir", label: "Fenrir (Energetic)" },
  { id: "Aoede", label: "Aoede (Clear & Soft)" },
];

const REALTIME_PROVIDER_COPY = {
  gemini: { name: "Gemini Live", voices: GEMINI_VOICES },
  elevenlabs: {
    name: "ElevenLabs Agents",
    note: "Realtime Voice Agent only (not TTS/STT) needs a ConvAI Agent ID in provider settings — without it the agent cannot be reached.",
  },
  deepgram: { name: "Deepgram Voice Agent" },
};

const getRealtimeOptions = (providers, field, includeCustom = false) => (providers || []).flatMap((provider) => [
  ...(provider[field] || []).map((option) => ({
    value: `${provider.type}/${option.id}`,
    label: `${provider.name || provider.type} · ${option.name || option.id}`,
  })),
  ...(includeCustom && (field === "models" || provider.customVoice)
    ? [{ value: `${provider.type}/custom:`, label: `${provider.name || provider.type} · Custom…` }]
    : []),
]);

export function RealtimeVoiceExampleCard({ providerId }) {
  const providerAlias = getProviderAlias(providerId);
  const providerCopy = REALTIME_PROVIDER_COPY[providerId] || { name: `${providerAlias} Realtime` };
  const realtimeConfig = AI_PROVIDERS[providerId]?.realtimeConfig || {};
  const realtimeModel = realtimeConfig.defaultModel
    || getModelsByProviderId(providerId).find((model) => model.kinds?.includes("realtime") || model.kind === "realtime")?.id
    || "";
  const voices = providerCopy.voices || [];
  const thinkConfig = realtimeConfig.think || {};
  const speakConfig = realtimeConfig.speak || {};
  const listenConfig = realtimeConfig.listen || {};
  const thinkProviders = thinkConfig.providers || [];
  const speakOptions = getRealtimeOptions(speakConfig.providers, "voices", true);
  const listenOptions = getRealtimeOptions(listenConfig.providers, "models", true);
  const defaultThinkProvider = thinkConfig.provider?.type || "";
  const defaultThinkModel = thinkConfig.provider?.model || "";
  const defaultSpeak = speakConfig.provider ? `${speakConfig.provider.type}/${speakConfig.provider.model}` : "";
  const defaultListen = listenConfig.provider ? `${listenConfig.provider.type}/${listenConfig.provider.model}` : "";

  const [selectedVoice, setSelectedVoice] = useState("Puck");
  const [selectedThinkProvider, setSelectedThinkProvider] = useState(defaultThinkProvider);
  const [selectedThinkModel, setSelectedThinkModel] = useState(defaultThinkModel);
  const [selectedSpeak, setSelectedSpeak] = useState(defaultSpeak);
  const [selectedListen, setSelectedListen] = useState(defaultListen);
  const [customThinkModel, setCustomThinkModel] = useState("");
  const [customSpeakId, setCustomSpeakId] = useState("");
  const [customListenId, setCustomListenId] = useState("");
  const [greeting, setGreeting] = useState("");
  const [instructions, setInstructions] = useState(
    "You are a friendly, helpful AI voice assistant. Speak naturally and concisely in Indonesian or English."
  );
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [localEndpoint, setLocalEndpoint] = useState("");

  const [isCalling, setIsCalling] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("idle"); // idle | connecting | connected | speaking | listening | error
  const [statusMessage, setStatusMessage] = useState("");
  const [messages, setMessages] = useState([]); // [{ id, role: "user" | "assistant", text: "" }]
  const [micVolume, setMicVolume] = useState(0);

  const { copied: copiedWs, copy: copyWs } = useCopyToClipboard();
  const { copied: copiedCode, copy: copyCode } = useCopyToClipboard();
  const [selectedLang, setSelectedLang] = useState("nodejs");

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
      stopCall();
    };
  }, [stopCall]);

  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const wsProtocol = endpoint.startsWith("https") ? "wss:" : "ws:";
  const wsHost = endpoint.replace(/^https?:\/\//, "");
  // The gateway resolves the provider from the model string. An unqualified id
  // like "voice-agent" is ambiguous and resolves to the wrong provider, so always
  // send "<provider>/<model>".
  const qualifiedModel = realtimeModel.includes("/") ? realtimeModel : `${providerId}/${realtimeModel}`;
  const realtimeParams = new URLSearchParams({ model: qualifiedModel });
  if (voices.length) realtimeParams.set("voice", selectedVoice);
  if (providerId === "deepgram") {
    const thinkModel = selectedThinkModel === "__custom__" ? customThinkModel.trim() : selectedThinkModel;
    if (selectedThinkProvider && thinkModel) realtimeParams.set("think", `${selectedThinkProvider}/${selectedThinkModel === "__custom__" ? `custom:${thinkModel}` : thinkModel}`);
    if (selectedSpeak && (!selectedSpeak.endsWith("/custom:") || customSpeakId.trim())) realtimeParams.set("speak", `${selectedSpeak}${selectedSpeak.endsWith("/custom:") ? customSpeakId.trim() : ""}`);
    if (selectedListen && (!selectedListen.endsWith("/custom:") || customListenId.trim())) realtimeParams.set("listen", `${selectedListen}${selectedListen.endsWith("/custom:") ? customListenId.trim() : ""}`);
    if (greeting) realtimeParams.set("greeting", greeting);
  }
  if (apiKey) realtimeParams.set("apiKey", apiKey);
  const wsUrl = `${wsProtocol}//${wsHost}/v1/realtime?${realtimeParams}`;
  const selectedThinkProviderOptions = thinkProviders.find((provider) => provider.type === selectedThinkProvider);
  const thinkModelOptions = selectedThinkProviderOptions?.models || [];
  const thinkProviderOptions = thinkProviders.length
    ? thinkProviders
    : defaultThinkProvider ? [{ type: defaultThinkProvider, name: defaultThinkProvider }] : [];
  const availableSpeakOptions = speakOptions.length
    ? speakOptions
    : defaultSpeak ? [{ value: defaultSpeak, label: defaultSpeak }] : [];
  const availableListenOptions = listenOptions.length
    ? listenOptions
    : defaultListen ? [{ value: defaultListen, label: defaultListen }] : [];

  // Auto-scroll transcript container to bottom when messages update
  useEffect(() => {
    if (messages.length === 0) return;
    const transcript = transcriptEndRef.current?.closest(".overflow-y-auto");
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
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
              ...(voices.length ? { voice: selectedVoice } : {}),
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
            <Badge variant="neutral" size="sm">{providerCopy.name}</Badge>
          </div>
          <p className="text-sm text-text-muted">
            Bidirectional real-time voice conversation with {providerCopy.name} via WebSocket (`/v1/realtime`).
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

      {providerCopy.note && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {providerCopy.note}
        </p>
      )}

      {/* Settings Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border border-border/60 rounded-xl p-4 bg-surface/50">
        {providerId === "deepgram" && (
          <>
            <div>
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">LLM (think) · Provider</label>
              <select
                value={selectedThinkProvider}
                onChange={(e) => {
                  const provider = thinkProviders.find((option) => option.type === e.target.value);
                  setSelectedThinkProvider(e.target.value);
                  setSelectedThinkModel(provider?.models?.[0]?.id || "");
                }}
                disabled={isCalling}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {thinkProviderOptions.map((provider) => (
                  <option key={provider.type} value={provider.type}>{provider.name || provider.type}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">LLM (think) · Model</label>
              <select
                value={selectedThinkModel}
                onChange={(e) => setSelectedThinkModel(e.target.value)}
                disabled={isCalling}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {(thinkModelOptions.length ? thinkModelOptions : selectedThinkModel && selectedThinkModel !== "__custom__" ? [{ id: selectedThinkModel }] : []).map((model) => (
                  <option key={model.id} value={model.id}>{model.name || model.id}</option>
                ))}
                <option value="__custom__">Custom…</option>
              </select>
              {selectedThinkModel === "__custom__" && (
                <input
                  type="text"
                  value={customThinkModel}
                  onChange={(e) => setCustomThinkModel(e.target.value)}
                  disabled={isCalling}
                  className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  placeholder="Enter a model ID"
                  aria-label="Custom LLM model ID"
                />
              )}
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Greeting (optional)</label>
              <input
                type="text"
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                disabled={isCalling}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                placeholder="The first thing the agent says..."
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Agent prompt</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={isCalling}
                rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-50"
                placeholder="Prompt for the voice agent..."
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Voice (speak)</label>
              <select
                value={selectedSpeak}
                onChange={(e) => setSelectedSpeak(e.target.value)}
                disabled={isCalling}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {availableSpeakOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {selectedSpeak.endsWith("/custom:") && (
                <input
                  type="text"
                  value={customSpeakId}
                  onChange={(e) => setCustomSpeakId(e.target.value)}
                  disabled={isCalling}
                  className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  placeholder="Enter a voice ID"
                  aria-label="Custom voice ID"
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Listen (STT)</label>
              <select
                value={selectedListen}
                onChange={(e) => setSelectedListen(e.target.value)}
                disabled={isCalling}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {availableListenOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {selectedListen.endsWith("/custom:") && (
                <input
                  type="text"
                  value={customListenId}
                  onChange={(e) => setCustomListenId(e.target.value)}
                  disabled={isCalling}
                  className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  placeholder="Enter a model ID"
                  aria-label="Custom listen model ID"
                />
              )}
            </div>
          </>
        )}

        {voices.length > 0 && (
          <div>
            <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">AI Voice</label>
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              disabled={isCalling}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>
        )}

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

        {providerId !== "deepgram" && <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">System Instructions</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={isCalling}
            rows={2}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none disabled:opacity-50"
            placeholder="Prompt for the voice agent..."
          />
        </div>}
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
            {isCalling ? "Speak into your microphone. You can interrupt anytime." : `Click below to connect your microphone and talk to ${providerCopy.name}.`}
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
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
            Developer Integration
          </span>
          <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-border">
            {[
              { id: "nodejs", label: "Node.js" },
              { id: "python", label: "Python" },
              { id: "cpp", label: "C++ (ESP32 / Arduino)" },
              { id: "wscat", label: "CLI (wscat)" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSelectedLang(tab.id)}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors cursor-pointer ${
                  selectedLang === tab.id
                    ? "bg-primary text-white shadow-sm"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {(() => {
          const baseEndpoint = wsUrl.split("?")[0];
          const activeKey = apiKey || "YOUR_9ROUTER_KEY";
          const snippetParams = new URLSearchParams(realtimeParams);
          snippetParams.delete("apiKey");
          const deviceParams = new URLSearchParams(snippetParams);
          deviceParams.set("apiKey", activeKey);
          const snippets = {
            nodejs: `// Node.js OpenAI Realtime Compatible Client
import WebSocket from "ws";

const WS_URL = "${baseEndpoint}?${snippetParams}";
const ws = new WebSocket(WS_URL, {
  headers: { Authorization: "Bearer ${activeKey}" },
});

ws.on("open", () => {
  console.log("Connected to 9Router Realtime Voice Gateway");

  // 1. Initialize session configuration
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
${selectedVoice ? `      voice: "${selectedVoice}",\n` : ""}      instructions: "${instructions.replace(/"/g, '\\"')}",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
    },
  }));

  // 2. Stream raw 16-bit 16kHz PCM audio bytes
  // ws.send(pcm16Buffer, { binary: true });
});

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const event = JSON.parse(data.toString());
    if (event.type === "response.audio_transcript.delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "response.audio.delta") {
      // 24kHz PCM audio in base64
      const pcm24k = Buffer.from(event.delta, "base64");
      // play or pipe pcm24k audio to speaker
    }
  }
});`,

            python: `# Python OpenAI Realtime Compatible Client
import asyncio
import websockets
import json
import base64

async def voice_session():
    uri = "${baseEndpoint}?${snippetParams}"
    headers = {"Authorization": "Bearer ${activeKey}"}
    
    async with websockets.connect(uri, extra_headers=headers) as ws:
        # 1. Update session
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
${selectedVoice ? `                "voice": "${selectedVoice}",\n` : ""}                "instructions": "${instructions.replace(/"/g, '\\"')}"
            }
        }))
        
        # 2. Receive stream events
        async for msg in ws:
            event = json.loads(msg)
            if event.get("type") == "response.audio_transcript.delta":
                print(event["delta"], end="", flush=True)
            elif event.get("type") == "response.audio.delta":
                pcm_chunk = base64.b64decode(event["delta"])
                # Play 24kHz 16-bit PCM audio chunk

asyncio.run(voice_session())`,

            cpp: `// ESP32 / Arduino WebSocket Realtime Voice Client (I2S Mic INMP441 + I2S DAC MAX98357A)
// Required Libraries in Arduino Library Manager:
// - ArduinoWebsockets by Gil Maimon
// - ArduinoJson (v7+)
#include <WiFi.h>
#include <ArduinoWebsockets.h>
#include <ArduinoJson.h>

using namespace websockets;
WebsocketsClient client;

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
// Tip: Use ?apiKey= query parameter for easy authentication on microcontrollers
const char* ws_url = "${baseEndpoint}?${deviceParams}";

void onMessageCallback(WebsocketsMessage message) {
  if (message.isText()) {
    JsonDocument doc;
    deserializeJson(doc, message.data());
    const char* type = doc["type"];

    // 1. Assistant text transcript
    if (strcmp(type, "response.audio_transcript.delta") == 0) {
      Serial.printf("AI: %s\\n", doc["delta"].as<const char*>());
    }
    // 2. Incoming voice audio (24kHz 16-bit PCM in base64)
    else if (strcmp(type, "response.audio.delta") == 0) {
      const char* base64_audio = doc["delta"];
      // Decode base64 and write directly to I2S DAC speaker (MAX98357A)
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }

  client.onMessage(onMessageCallback);
  client.connect(ws_url);

  // Initialize voice session
  client.send("{\\"type\\":\\"session.update\\",\\"session\\":{${selectedVoice ? `\\"voice\\":\\"${selectedVoice}\\",` : ""}\\"instructions\\":\\"Answer briefly.\\"}}");
}

void loop() {
  client.poll();

  // Stream raw 16-bit 16kHz PCM audio bytes from I2S microphone (INMP441)
  // uint8_t pcmBuffer[1024];
  // size_t bytesRead = 0;
  // i2s_read(I2S_NUM_0, pcmBuffer, sizeof(pcmBuffer), &bytesRead, portMAX_DELAY);
  // if (bytesRead > 0) {
  //   client.sendBinary((const char*)pcmBuffer, bytesRead);
  // }
}`,

            wscat: `# Connect directly via wscat CLI
wscat -c "${baseEndpoint}?${deviceParams}"

# In the wscat session, send session initialization:
{"type":"session.update","session":{${selectedVoice ? `"voice":"${selectedVoice}",` : ""}"instructions":"Answer briefly."}}`,
          };

          const currentSnippet = snippets[selectedLang] || snippets.nodejs;

          return (
            <div className="relative">
              <button
                onClick={() => copyCode(currentSnippet)}
                className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded-md bg-surface border border-border hover:bg-surface-2 text-[11px] font-medium text-text-muted hover:text-text-main transition-colors flex items-center gap-1.5 shadow-sm z-10 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[13px]">
                  {copiedCode ? "check" : "content_copy"}
                </span>
                {copiedCode ? "Copied!" : "Copy Code"}
              </button>
              <pre className="p-3.5 pt-9 rounded-lg bg-bg-subtle text-xs font-mono overflow-x-auto text-text-main border border-border max-h-96">
                {currentSnippet}
              </pre>
            </div>
          );
        })()}
      </div>
    </Card>
  );
}
