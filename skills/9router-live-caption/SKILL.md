---
name: 9router-live-caption
description: Real-time speech transcription & karaoke subtitle streaming via 9Router /v1/audio/live-transcriptions using ElevenLabs Scribe, Deepgram Nova-3, or Gemini Live. Use when the user wants real-time audio captioning, word-level timestamps, or live SRT/ASS subtitle generation.
---

# 9Router — Live Caption & Subtitle Streaming

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth is enabled). See https://raw.githubusercontent.com/Hazz-i/9router/refs/heads/master/skills/9router/SKILL.md for setup.

## Discover Models

```bash
# Discover Live Caption models
curl $NINEROUTER_URL/v1/models/live-caption
```

Supported upstream models:
- `elevenlabs/scribe_v2_realtime` (ElevenLabs Scribe Realtime STT)
- `deepgram/nova-3` (Deepgram Nova-3 Realtime)
- `gemini/gemini-3.8-live` (Gemini Live Audio Transcription)

## Endpoint

- **WebSocket URL**: `ws://${NINEROUTER_HOST}:${NINEROUTER_PORT}/v1/audio/live-transcriptions?model=elevenlabs/scribe_v2_realtime&language=en&sample_rate=16000`
- **Protocol**: WebSocket (Streaming PCM or WebM Opus chunks)

### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `model` | string | `elevenlabs/scribe_v2_realtime` | Live caption model |
| `language` | string | `en` | Spoken language code (`id`, `en`, `es`, etc.) |
| `encoding` | string | `linear16` | Audio encoding (`linear16`, `pcm`, `webm_opus`) |
| `sample_rate` | number | `16000` | Audio sample rate in Hz (16000 recommended) |
| `apiKey` | string | - | 9Router client API key |

### Key Events

| Event Type | Direction | Payload / Purpose |
|---|---|---|
| `Binary Audio Frame` | Client → Server | Stream raw 16kHz PCM audio bytes continuously |
| `ready` | Server → Client | Upstream provider connection established |
| `partial` | Server → Client | Interim partial speech transcript |
| `word` | Server → Client | Word-level timing `{ word, start, end, isFinal }` |
| `chunk` | Server → Client | Rhythm-chunked caption for subtitle display |
| `get_subtitles` | Client → Server | Request formatted `.srt` or `.ass` karaoke subtitle document |
| `subtitles` | Server → Client | Generated `.srt` / `.ass` string |

---

## Code Example (Node.js)

```javascript
import WebSocket from "ws";
import fs from "node:fs";

const wsUrl = "ws://localhost:20128/v1/audio/live-transcriptions?model=elevenlabs/scribe_v2_realtime&language=en&sample_rate=16000&apiKey=YOUR_KEY";
const ws = new WebSocket(wsUrl);

ws.on("open", () => {
  console.log("Connected to Live Caption Gateway");
  // Stream audio file chunks or microphone buffer
  const audioStream = fs.createReadStream("audio_16k.pcm", { highWaterMark: 1024 });
  audioStream.on("data", (chunk) => ws.send(chunk));
  audioStream.on("end", () => {
    ws.send(JSON.stringify({ type: "finalize" }));
  });
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "partial") {
    process.stdout.write(`\rCaption: ${msg.text}`);
  } else if (msg.type === "word") {
    console.log(`Word: ${msg.word} [${msg.start}s - ${msg.end}s]`);
  }
});
```
