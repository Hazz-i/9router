import http from "node:http";
import { WebSocket } from "ws";

// Set up server using custom-server.js logic
process.env.NINEROUTER_PEER_TOKEN = "test-token";
const { getProvidersByKind } = await import("../src/shared/constants/providers.js");
const { chunkWords, chunksToSrt, chunksToAss } = await import("../src/sse/utils/subtitleFormatter.js");

console.log("1. Verifying Live Caption Providers...");
const providers = getProvidersByKind("liveCaption");
const providerIds = providers.map((p) => p.id);
console.log("   Found liveCaption providers:", providerIds);
if (!providerIds.includes("deepgram") || !providerIds.includes("gemini")) {
  throw new Error("Missing expected providers in liveCaption kind");
}

console.log("2. Verifying Subtitle Formatter...");
const sampleWords = [
  { word: "Halo", start: 0.0, end: 0.4 },
  { word: "dunia,", start: 0.45, end: 0.8 },
  { word: "ini", start: 0.9, end: 1.1 },
  { word: "live", start: 1.15, end: 1.5 },
  { word: "caption!", start: 1.55, end: 2.1 },
];
const chunks = chunkWords(sampleWords);
const srt = chunksToSrt(chunks);
const ass = chunksToAss(chunks);

if (!srt.includes("Halo dunia, ini live caption!")) {
  throw new Error("SRT format mismatch");
}
if (!ass.includes("{\\k40}Halo")) {
  throw new Error("ASS karaoke tag mismatch");
}
console.log("   Subtitle formatting verified successfully.");

console.log("3. Verifying WebSocket Upgrade Mock Server...");
const { WebSocketServer } = await import("ws");
const { handleLiveTranscriptionConnection } = await import("../src/sse/handlers/liveCaptionWs.js");

const testServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  handleLiveTranscriptionConnection(ws, req);
});

testServer.on("upgrade", (req, socket, head) => {
  const pathname = (req.url || "").split("?")[0];
  if (pathname === "/v1/audio/live-transcriptions") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
const port = testServer.address().port;
console.log(`   Test server listening on port ${port}`);

try {
  const clientWs = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/live-transcriptions?model=dg/nova-3&language=id`);

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS connection timed out")), 4000);
    clientWs.on("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    clientWs.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  console.log("   Received WebSocket initial event:", response);
  if (response.type !== "connected" && response.type !== "error") {
    throw new Error(`Unexpected WS response: ${JSON.stringify(response)}`);
  }
  console.log("   WebSocket handshake verified successfully!");
  clientWs.close();
} finally {
  testServer.close();
}

console.log("\n✅ ALL LIVE CAPTION INTEGRATION CHECKS PASSED!");
