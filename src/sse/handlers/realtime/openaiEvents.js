// Shared OpenAI Realtime client-event builders for /v1/realtime adapters.
// The browser-facing contract is the OpenAI Realtime protocol — every adapter
// maps its upstream events through these builders (never invent new wire types).

export function sendClientError(ctx, message) {
  ctx.sendClient({
    type: "error",
    error: { type: "upstream_error", message },
  });
}

export function sendSessionCreated(ctx, { sessionId, model, voice }) {
  const session = {
    id: sessionId,
    object: "realtime.session",
    model,
    modalities: ["audio", "text"],
    turn_detection: { type: "server_vad" },
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
  };
  if (voice !== undefined && voice !== null) session.voice = voice;
  ctx.sendClient({ type: "session.created", session });
}

export function sendSessionUpdated(ctx, { sessionId, model, voice }) {
  const session = { id: sessionId, object: "realtime.session", model };
  if (voice !== undefined && voice !== null) session.voice = voice;
  ctx.sendClient({ type: "session.updated", session });
}

export function sendAudioDelta(ctx, { responseId, itemId, base64 }) {
  ctx.sendClient({
    type: "response.audio.delta",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: base64,
  });
}

export function sendTranscriptDelta(ctx, { responseId, itemId, text }) {
  ctx.sendClient({
    type: "response.audio_transcript.delta",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
}

export function sendSpeechStarted(ctx, { itemId, audioStartMs }) {
  const event = { type: "input_audio_buffer.speech_started", item_id: itemId };
  if (audioStartMs !== undefined) event.audio_start_ms = audioStartMs;
  ctx.sendClient(event);
}

export function sendResponseCancelled(ctx, responseId) {
  ctx.sendClient({ type: "response.cancelled", response_id: responseId });
}

// Turn completion: audio.done followed by response.done (consecutive events)
export function sendTurnComplete(ctx, { responseId, itemId }) {
  ctx.sendClient({ type: "response.audio.done", response_id: responseId, item_id: itemId });
  ctx.sendClient({
    type: "response.done",
    response: { id: responseId, object: "realtime.response", status: "completed" },
  });
}
