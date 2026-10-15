import WebSocket from "ws";

const PORT = process.env.PORT || 20127;
const WS_URL = `ws://localhost:${PORT}/v1/realtime?model=gemini-2.0-flash-exp&voice=Puck`;

console.log(`[TEST] Connecting to ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("[TEST] WebSocket connected!");
  
  // Send session.update
  const sessionUpdate = {
    type: "session.update",
    session: {
      voice: "Puck",
      instructions: "Halo! Jawab dengan singkat dalam bahasa Indonesia.",
    },
  };
  console.log("[TEST] Sending session.update...");
  ws.send(JSON.stringify(sessionUpdate));

  // Send a tiny 100ms dummy PCM16 16kHz silence chunk (3200 bytes)
  const dummyPcm = Buffer.alloc(3200);
  ws.send(JSON.stringify({
    type: "input_audio_buffer.append",
    audio: dummyPcm.toString("base64"),
  }));
  console.log("[TEST] Sent dummy audio chunk.");

  setTimeout(() => {
    console.log("[TEST] Closing connection after 3 seconds...");
    ws.close(1000);
  }, 3000);
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString("utf8"));
    console.log(`[TEST] Received event: ${msg.type}`, msg.error ? msg.error : msg.session ? msg.session : "");
  } catch {
    console.log(`[TEST] Received raw data (${data.length} bytes)`);
  }
});

ws.on("close", (code, reason) => {
  console.log(`[TEST] WebSocket closed: code=${code}, reason=${reason.toString()}`);
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[TEST] WebSocket error:", err.message);
  process.exit(1);
});
