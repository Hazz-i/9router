import { WebSocket } from "ws";
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

const PORT = 20127;
const SPEECH_FILE = "/tmp/speech.pcm";

function get9RouterKey() {
  try {
    const dbPath = path.join(os.homedir(), ".9router", "db", "data.sqlite");
    const db = new Database(dbPath);
    const row = db.prepare("SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1").get();
    return row?.key || "";
  } catch (e) {
    console.warn("Could not read API key from DB:", e.message);
    return "";
  }
}

const NINEROUTER_KEY = get9RouterKey();
console.log("Using 9Router Client API Key:", NINEROUTER_KEY ? `${NINEROUTER_KEY.slice(0, 15)}...` : "(none)");

async function testElevenLabsLiveCaption(modelParam = "elevenlabs/scribe_v2_realtime") {
  console.log(`\n======================================================`);
  console.log(`[TEST 1] Live Caption via ElevenLabs (model: ${modelParam})`);
  console.log(`======================================================`);

  if (!fs.existsSync(SPEECH_FILE)) {
    throw new Error(`Speech file ${SPEECH_FILE} not found`);
  }
  const pcmBuffer = fs.readFileSync(SPEECH_FILE);

  const url = `ws://localhost:${PORT}/v1/audio/live-transcriptions?model=${encodeURIComponent(modelParam)}&language=en&encoding=linear16&sample_rate=16000&apiKey=${encodeURIComponent(NINEROUTER_KEY)}`;
  console.log(`Connecting to: ${url}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const receivedEvents = [];
    let isDone = false;

    const timeout = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        try { ws.close(); } catch {}
        reject(new Error("ElevenLabs Live Caption test timed out after 15s"));
      }
    }, 15000);

    ws.on("open", () => {
      console.log(`✓ WebSocket connected to 9Router Live Caption gateway`);
    });

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        receivedEvents.push(msg.type);
        console.log(`[ElevenLabs Live Caption Event]`, msg.type, msg.type === "word" ? `"${msg.word}"` : (msg.chunk?.text ? `"${msg.chunk.text}"` : (msg.text ? `"${msg.text}"` : JSON.stringify(msg))));

        if (msg.type === "error") {
          isDone = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(new Error(`ElevenLabs error: ${msg.error || JSON.stringify(msg)}`));
          return;
        }

        if (msg.type === "ready") {
          console.log(`✓ Upstream ready (${msg.upstream}). Streaming ${pcmBuffer.length} bytes of speech audio...`);
          const chunkSize = 2048;
          for (let i = 0; i < pcmBuffer.length; i += chunkSize) {
            const chunk = pcmBuffer.slice(i, i + chunkSize);
            ws.send(chunk);
            await new Promise((r) => setTimeout(r, 64));
          }
          console.log(`✓ Audio streaming completed. Sending finalize...`);
          ws.send(JSON.stringify({ type: "finalize" }));
        }

        if (msg.type === "chunk" || (msg.type === "word" && msg.isFinal)) {
          // Success: received transcription
          if (!isDone) {
            isDone = true;
            clearTimeout(timeout);
            console.log(`✓ Successfully received transcribed caption!`);
            setTimeout(() => {
              try { ws.close(); } catch {}
              resolve({ success: true, events: receivedEvents });
            }, 1000);
          }
        }
      } catch (e) {
        console.error("Failed to parse event:", e);
      }
    });

    ws.on("error", (err) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[ElevenLabs WS Closed] code=${code}, reason=${reason?.toString() || "normal"}`);
    });
  });
}

async function testGeminiRealtimeVoice(modelParam = "gemini/gemini-3.8-live") {
  console.log(`\n======================================================`);
  console.log(`[TEST 2] Realtime Voice via Gemini Live (model: ${modelParam})`);
  console.log(`======================================================`);

  if (!fs.existsSync(SPEECH_FILE)) {
    throw new Error(`Speech file ${SPEECH_FILE} not found`);
  }
  const pcmBuffer = fs.readFileSync(SPEECH_FILE);

  const url = `ws://localhost:${PORT}/v1/realtime?model=${encodeURIComponent(modelParam)}&voice=Puck&apiKey=${encodeURIComponent(NINEROUTER_KEY)}`;
  console.log(`Connecting to: ${url}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let sessionCreated = false;
    let audioDeltasReceived = 0;
    let totalAudioBytes = 0;
    let transcriptText = "";
    let isDone = false;
    let audioStreamed = false;

    const timeout = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        try { ws.close(); } catch {}
        if (audioDeltasReceived > 0) {
          resolve({ success: true, audioDeltasReceived, totalAudioBytes, transcriptText });
        } else {
          reject(new Error("Gemini Realtime Voice test timed out after 20s"));
        }
      }
    }, 20000);

    ws.on("open", () => {
      console.log(`✓ WebSocket connected to 9Router Realtime Voice gateway`);
    });

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[Gemini Realtime Event]`, msg.type, msg.type === "response.audio.delta" ? `(delta size: ${msg.delta?.length || 0})` : (msg.delta ? `"${msg.delta}"` : ""));

        if (msg.type === "error") {
          isDone = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(new Error(`Gemini error: ${msg.error?.message || JSON.stringify(msg)}`));
          return;
        }

        if (msg.type === "session.created") {
          sessionCreated = true;
          console.log(`✓ Session created: ${msg.session?.id}, voice=${msg.session?.voice}`);
        }

        if (msg.type === "session.updated" && sessionCreated && !audioStreamed) {
          audioStreamed = true;
          console.log(`✓ Session updated. Streaming speech audio into input_audio_buffer...`);
          const chunkSize = 2048;
          for (let i = 0; i < pcmBuffer.length; i += chunkSize) {
            const chunk = pcmBuffer.slice(i, i + chunkSize);
            ws.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: chunk.toString("base64"),
            }));
            await new Promise((r) => setTimeout(r, 64));
          }

          console.log(`✓ Finished appending audio. Requesting response...`);
          ws.send(JSON.stringify({
            type: "response.create",
          }));
        }

        if (msg.type === "response.audio.delta") {
          audioDeltasReceived++;
          totalAudioBytes += Buffer.from(msg.delta, "base64").length;
        }

        if (msg.type === "response.audio_transcript.delta") {
          transcriptText += msg.delta;
        }

        if (msg.type === "response.done" || (audioDeltasReceived > 3 && !isDone)) {
          if (!isDone) {
            isDone = true;
            clearTimeout(timeout);
            console.log(`✓ Received complete voice response! Audio chunks: ${audioDeltasReceived}, total audio bytes: ${totalAudioBytes}`);
            if (transcriptText) console.log(`✓ Assistant transcript: "${transcriptText}"`);
            setTimeout(() => {
              try { ws.close(); } catch {}
              resolve({ success: true, audioDeltasReceived, totalAudioBytes, transcriptText });
            }, 1000);
          }
        }
      } catch (e) {
        console.error("Failed to parse event:", e);
      }
    });

    ws.on("error", (err) => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[Gemini WS Closed] code=${code}, reason=${reason?.toString() || "normal"}`);
    });
  });
}

async function run() {
  console.log("=== STARTING 9ROUTER LIVE CAPTION & REALTIME VOICE TEST ===");
  try {
    const elResult = await testElevenLabsLiveCaption("elevenlabs/scribe_v2_realtime");
    console.log(">>> ELEVENLABS LIVE CAPTION RESULT:", elResult.success ? "PASSED ✅" : "FAILED ❌");

    const geminiResult = await testGeminiRealtimeVoice("gemini/gemini-3.8-live");
    console.log(">>> GEMINI REALTIME VOICE RESULT:", geminiResult.success ? "PASSED ✅" : "FAILED ❌");

    console.log("\n=======================================================");
    console.log("ALL TESTS COMPLETED SUCCESSFULLY! 🎉");
    console.log("=======================================================");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  }
}

run();
