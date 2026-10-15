export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/realtime
 * Information endpoint about the OpenAI-compatible Realtime Voice WebSocket protocol
 */
export async function GET() {
  return new Response(
    JSON.stringify({
      status: "ready",
      protocol: "websocket",
      message: "Connect to this endpoint using WebSocket (ws:// or wss://) for bidirectional realtime voice conversation.",
      endpoint: "/v1/realtime",
      protocolFormat: "OpenAI Realtime API compatible",
      backend: "Google Gemini Multimodal Live API",
      defaultModel: "gemini-3.8-live",
      supportedVoices: ["Puck", "Charon", "Kore", "Fenrir", "Aoede"],
      queryParameters: {
        model: "Model ID (default: gemini/gemini-3.8-live)",
        voice: "Voice name (default: Puck)",
        apiKey: "NineRouter API Key (if required by settings)",
      },
      events: {
        client_to_server: [
          "{ type: 'session.update', session: { voice, instructions } }",
          "{ type: 'input_audio_buffer.append', audio: '<base64 PCM16>' }",
          "{ type: 'input_audio_buffer.clear' }",
          "{ type: 'response.create' }",
          "{ type: 'conversation.item.create', item: { content: [...] } }",
          "Binary WebSocket frames (PCM 16-bit 16kHz audio)",
        ],
        server_to_client: [
          "{ type: 'session.created', session: { ... } }",
          "{ type: 'session.updated', session: { ... } }",
          "{ type: 'response.audio.delta', delta: '<base64 PCM24k>' }",
          "{ type: 'response.audio_transcript.delta', delta: '...' }",
          "{ type: 'input_audio_buffer.speech_started' }",
          "{ type: 'response.cancelled' }",
          "{ type: 'response.audio.done' }",
          "{ type: 'response.done' }",
          "{ type: 'error', error: { ... } }",
        ],
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

export async function POST() {
  return new Response(
    JSON.stringify({
      error: "Upgrade Required: /v1/realtime requires a WebSocket connection (ws:// or wss://)",
    }),
    {
      status: 426,
      headers: {
        "Content-Type": "application/json",
        "Upgrade": "WebSocket",
        "Connection": "Upgrade",
      },
    }
  );
}
