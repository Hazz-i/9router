# Realtime Voice Agent (Gemini Live & OpenAI Realtime Protocol) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Realtime Voice Agent WebSocket gateway to 9Router (`/v1/realtime`), exposing the standard OpenAI Realtime event protocol backed by Google Gemini Multimodal Live API, complete with media usage tracking and an interactive web Voice Playground in the dashboard.

**Architecture:** A WebSocket upgrade server in `custom-server.js` routes `/v1/realtime` traffic to `realtimeVoiceWs.js`. The handler transparently translates client-side OpenAI Realtime JSON events and base64 PCM audio into Google Gemini's Multimodal Live Bidi protocol (and vice-versa). On session completion, the handler records usage metrics to SQLite, automatically integrating with 9Router's Media Overview dashboard.

**Tech Stack:** Node.js, `ws` (WebSocket), Web Audio API (PCM 16-bit 16kHz/24kHz streaming), Next.js 16, React 19, SQLite (`better-sqlite3` / `bun:sqlite` / `node:sqlite`).

## Global Constraints

- OpenAI Realtime protocol compatibility (`session.update`, `input_audio_buffer.append`, `response.audio.delta`, `response.audio_transcript.delta`).
- Upstream engine: Google Gemini Multimodal Live API (`wss://generativelanguage.googleapis.com/...`).
- Default model: `gemini-2.0-flash-exp` with configurable voices (`Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`).
- All media usage tracked under `type: "media"` and visible in `/dashboard/usage?tab=media-overview`.
- Zero external client library requirements for the browser playground (uses native Web Audio API).

---

### Task 1: Provider Registry & Constants

**Files:**
- Modify: `src/shared/constants/providers.js:5-15, 75-90, 105-140`
- Modify: `open-sse/providers/registry/gemini.js:1-40`
- Test: `bun -e 'import { MEDIA_PROVIDER_KINDS, hasMediaCapability } from "./src/shared/constants/providers.js"; console.log(MEDIA_PROVIDER_KINDS.find(k => k.id === "realtime"), hasMediaCapability("gemini"));'`

**Interfaces:**
- Consumes: `MEDIA_ENTRY_KEYS`, `MEDIA_PROVIDER_KINDS`, `MEDIA_SERVICE_KINDS`.
- Produces: `realtime` media kind entry, `realtimeConfig` in Gemini registry, `hasMediaCapability("gemini") === true`.

- [ ] **Step 1: Update `src/shared/constants/providers.js`**
  - Add `"realtimeConfig"` to `MEDIA_ENTRY_KEYS`.
  - Add `{ id: "realtime", label: "Realtime Voice", icon: "record_voice_over", endpoint: { method: "WS", path: "/v1/realtime" } }` to `MEDIA_PROVIDER_KINDS`.
  - Add `"realtime"` to `MEDIA_SERVICE_KINDS`.
  - Add `"/v1/realtime"` to `MEDIA_ENDPOINT_PREFIXES`.

- [ ] **Step 2: Update `open-sse/providers/registry/gemini.js`**
  - Add `"realtime"` to `serviceKinds` array in Gemini provider definition.
  - Add `realtimeConfig`:
    ```javascript
    realtimeConfig: {
      bidiUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent",
      defaultModel: "gemini-2.0-flash-exp",
      supportedVoices: ["Puck", "Charon", "Kore", "Fenrir", "Aoede"],
      audioInRate: 16000,
      audioOutRate: 24000,
    },
    ```

- [ ] **Step 3: Verify constants in bun**
  - Run verification script to check that `realtime` is registered and `hasMediaCapability("gemini")` returns `true`.

---

### Task 2: Realtime Voice WebSocket Handler & Translation Engine

**Files:**
- Create: `src/sse/handlers/realtimeVoiceWs.js`
- Test: `scripts/test-realtime-voice.mjs`

**Interfaces:**
- Consumes: Client WebSocket connection, Gemini credentials from `getProviderConnections()` / `process.env.GEMINI_API_KEY`.
- Produces: `handleRealtimeVoiceUpgrade(req, socket, head)` and `getRealtimeWsServer()`.

- [ ] **Step 1: Write test verification script `scripts/test-realtime-voice.mjs`**
  - Connect via WebSocket to `ws://localhost:20127/v1/realtime?model=gemini-2.0-flash-exp`.
  - Send `session.update` with greeting instructions.
  - Send small dummy PCM 16kHz audio chunk via `input_audio_buffer.append`.
  - Verify receipt of `session.created`, `session.updated`, or `response.audio.delta`.

- [ ] **Step 2: Implement `src/sse/handlers/realtimeVoiceWs.js`**
  - Create singleton `WebSocketServer({ noServer: true })`.
  - Implement connection lifecycle:
    - Auth check: Extract API key from query / header / cookie or fall back to internal auth.
    - Resolve Gemini API key: lookup active connection for `gemini` in localDb or `process.env.GEMINI_API_KEY`.
    - Establish upstream WebSocket to Gemini Multimodal Live API:
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`
  - Implement protocol translation:
    - **Client $\rightarrow$ Gemini:**
      - On `session.update`: send Gemini `setup` message (`model`, `generationConfig` with `AUDIO`, voice config, and `systemInstruction`).
      - On `input_audio_buffer.append`: send `realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: audioBase64 }] }`.
      - On `response.create`: optional manual trigger.
    - **Gemini $\rightarrow$ Client:**
      - On `setupComplete`: emit `session.created` and `session.updated`.
      - On `serverContent.modelTurn.parts`:
        - If `inlineData` has `audio/pcm`: emit `response.audio.delta` with base64 PCM.
        - If `text` present: emit `response.audio_transcript.delta`.
      - On `serverContent.interrupted`: emit `input_audio_buffer.speech_started` and `response.cancelled`.
      - On `serverContent.turnComplete`: emit `response.audio.done` and `response.done`.
  - Track duration & audio frame counts for usage recording.

- [ ] **Step 3: Run unit validation on translator functions**
  - Verify message serialization and error resilience against corrupt frames.

---

### Task 3: Server WebSocket Upgrades & Usage Tracking Integration

**Files:**
- Modify: `custom-server.js:105-125`
- Create: `src/app/api/v1/realtime/route.js`
- Modify: `src/lib/db/repos/usageRepo.js:4-30`

**Interfaces:**
- Consumes: HTTP server upgrade event in `custom-server.js`.
- Produces: Seamless WS upgrade on `/v1/realtime` and `/api/v1/realtime`, usage entry saved to `usageHistory`.

- [ ] **Step 1: Wire upgrade in `custom-server.js`**
  - Import `getRealtimeWsServer` from `./src/sse/handlers/realtimeVoiceWs.js`.
  - In `server.emit("upgrade", ...)`:
    Check `if (pathname === "/v1/realtime" || pathname === "/api/v1/realtime")`.
    Handle upgrade using `getRealtimeWsServer().handleUpgrade(...)`.

- [ ] **Step 2: Create Next.js route fallback `src/app/api/v1/realtime/route.js`**
  - Return HTTP 426 Upgrade Required for plain HTTP requests, with instructions that this endpoint expects a WebSocket connection.

- [ ] **Step 3: Hook `saveRequestUsage` into `realtimeVoiceWs.js`**
  - When connection terminates, calculate elapsed seconds and token estimation (`~25` tokens/sec for audio).
  - Call `saveRequestUsage({ provider: "gemini", model, endpoint: "/v1/realtime", promptTokens, completionTokens, status: "success" })`.

---

### Task 4: Interactive Dashboard Voice Playground Component

**Files:**
- Create: `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/RealtimeVoiceExampleCard.js`
- Modify: `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js:20-60`

**Interfaces:**
- Consumes: WebSocket `/v1/realtime` from browser client.
- Produces: Interactive React UI component with mic capture, audio playback queue, visualizer, and transcript.

- [ ] **Step 1: Implement `RealtimeVoiceExampleCard.js`**
  - Build UI layout:
    - Status pill (`Disconnected`, `Connecting`, `Connected`, `Speaking`, `Listening`).
    - Start / End Voice Session button.
    - Voice dropdown selector (`Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`).
    - System instruction textarea (default: "You are a friendly AI voice assistant. Speak naturally and concisely in Indonesian or English.").
    - Live audio visualizer (pulsing rings/wave when user speaks or AI responds).
    - Realtime conversation transcript feed (chat bubbles showing user & AI turns).
  - Implement Web Audio mic capture:
    - Request `navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } })`.
    - Resample Float32 audio buffers to signed 16-bit PCM at 16kHz and send base64 in `input_audio_buffer.append`.
  - Implement Web Audio streaming playback:
    - Create `AudioContext({ sampleRate: 24000 })`.
    - On `response.audio.delta`, decode base64 PCM 24kHz and append to continuous audio buffer queue without audio pops or gaps.
    - If user interrupts (speech started / interrupted event), cancel pending playback queue immediately.

- [ ] **Step 2: Integrate into `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js`**
  - When `kind === "realtime"`, render `<RealtimeVoiceExampleCard provider={provider} />`.

---

### Task 5: End-to-End Verification & Documentation

**Files:**
- Modify: `TODO_LIVE_CAPTION.md` or create `TODO_REALTIME_VOICE.md`
- Run: `npm run build` and `npx eslint`

- [ ] **Step 1: Run automated test script**
  - Run `node scripts/test-realtime-voice.mjs` against the running 9Router dev server.
  - Verify handshake, session setup, and audio response.

- [ ] **Step 2: Run linter and build check**
  - Run `npx eslint` on all created and modified files.
  - Run `npm run build` to verify zero build errors.

- [ ] **Step 3: Manual dashboard verification**
  - Open `/dashboard/media-providers/realtime/gemini` in browser.
  - Test voice conversation and verify audio round-trip.
  - Check `/dashboard/usage?tab=media-overview` to confirm that Gemini voice usage is recorded and shown in topology and recent requests.
