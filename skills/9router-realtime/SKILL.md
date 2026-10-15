---
name: 9router-realtime
description: Realtime bidirectional speech and voice agent via 9Router /v1/realtime using OpenAI Realtime WebSocket protocol and Gemini Live. Use when the user wants bidirectional voice conversation, low-latency audio interaction, or voice agent integration in Node.js, Python, or embedded devices (ESP32/Arduino).
---

# 9Router — Realtime Voice Agent

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth is enabled). See https://raw.githubusercontent.com/Hazz-i/9router/refs/heads/master/skills/9router/SKILL.md for setup.

## Discover Models

```bash
# Discover realtime voice models
curl $NINEROUTER_URL/v1/models/realtime
```

Supported upstream models:
- `gemini/gemini-3.8-live` (Google Gemini Live Bidi Audio)
- `gemini/gemini-2.5-flash-native-audio-preview-12-2025`

## Endpoint

- **WebSocket URL**: `ws://${NINEROUTER_HOST}:${NINEROUTER_PORT}/v1/realtime?model=gemini-3.8-live&voice=Puck`
- **Protocol**: OpenAI Realtime WebSocket API specification
- **Audio Format**: PCM 16-bit, 16kHz or 24kHz, mono, little-endian

### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `model` | string | `gemini-3.8-live` | Realtime voice model |
| `voice` | string | `Puck` | Prebuilt voice name (`Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`) |
| `apiKey` | string | - | 9Router client API key (optional query param for embedded IoT / Arduino) |

### Key Client Events

| Event Type | Direction | Payload / Purpose |
|---|---|---|
| `session.update` | Client → Server | Configure session voice, instructions, audio formats |
| `input_audio_buffer.append` | Client → Server | Append audio chunk (`{"type": "input_audio_buffer.append", "audio": "<base64_pcm16>"}`) |
| `Binary Audio Frame` | Client → Server | Direct raw PCM16 bytes sent over binary WebSocket frame |
| `input_audio_buffer.commit` | Client → Server | Commit current input audio buffer |
| `response.create` | Client → Server | Trigger assistant to respond |

### Key Server Events

| Event Type | Direction | Payload / Purpose |
|---|---|---|
| `session.created` | Server → Client | Emitted when voice session is initialized |
| `session.updated` | Server → Client | Emitted after session configuration updates |
| `response.audio_transcript.delta` | Server → Client | Incremental text transcription of assistant voice |
| `response.audio.delta` | Server → Client | Assistant audio stream chunk in base64 24kHz PCM |
| `response.done` | Server → Client | Assistant turn completed |

---

## Code Examples

### 1. Node.js

```javascript
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:20128/v1/realtime?model=gemini-3.8-live&voice=Puck", {
  headers: { Authorization: "Bearer YOUR_9ROUTER_KEY" }
});

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: "Puck",
      instructions: "You are a concise voice assistant."
    }
  }));
});

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const event = JSON.parse(data.toString());
    if (event.type === "response.audio_transcript.delta") {
      process.stdout.write(event.delta);
    }
  }
});
```

### 2. Python

```python
import asyncio
import websockets
import json

async def voice_session():
    uri = "ws://localhost:20128/v1/realtime?model=gemini-3.8-live&voice=Puck"
    headers = {"Authorization": "Bearer YOUR_9ROUTER_KEY"}
    
    async with websockets.connect(uri, extra_headers=headers) as ws:
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {"voice": "Puck", "instructions": "Halo!"}
        }))
        
        async for msg in ws:
            event = json.loads(msg)
            if event.get("type") == "response.audio_transcript.delta":
                print(event["delta"], end="", flush=True)

asyncio.run(voice_session())
```

### 3. C++ (ESP32 / Arduino)

```cpp
#include <WiFi.h>
#include <ArduinoWebsockets.h>
#include <ArduinoJson.h>

using namespace websockets;
WebsocketsClient client;

const char* ws_url = "ws://192.168.1.100:20128/v1/realtime?model=gemini-3.8-live&voice=Puck&apiKey=YOUR_9ROUTER_KEY";

void onMessageCallback(WebsocketsMessage msg) {
  if (msg.isText()) {
    JsonDocument doc;
    deserializeJson(doc, msg.data());
    if (strcmp(doc["type"], "response.audio_transcript.delta") == 0) {
      Serial.printf("AI: %s\n", doc["delta"].as<const char*>());
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin("SSID", "PASS");
  while (WiFi.status() != WL_CONNECTED) delay(500);

  client.onMessage(onMessageCallback);
  client.connect(ws_url);

  client.send("{\"type\":\"session.update\",\"session\":{\"voice\":\"Puck\",\"instructions\":\"Be concise.\"}}");
}

void loop() {
  client.poll();
}
```
