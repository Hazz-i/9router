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
 * GET /v1/audio/live-transcriptions
 * Information endpoint about the WebSocket Live Transcription protocol
 */
export async function GET() {
  return new Response(
    JSON.stringify({
      status: "ready",
      protocol: "websocket",
      message: "Connect to this endpoint using WebSocket (ws:// or wss://) to stream live audio chunks.",
      endpoint: "/v1/audio/live-transcriptions",
      supportedEncodings: ["linear16", "pcm", "webm_opus"],
      queryParameters: {
        model: "Model ID (e.g. dg/nova-3, gemini/gemini-2.5-flash-native-audio-preview-09-17)",
        language: "Language code (e.g. id, en)",
        encoding: "linear16 | webm (default: linear16)",
        sample_rate: "Sample rate in Hz (default: 16000)",
        apiKey: "NineRouter API Key (if required by settings)",
      },
      events: {
        client_to_server: [
          "Binary audio chunks (PCM 16-bit 16kHz or WebM Opus)",
          "{ type: 'keepalive' }",
          "{ type: 'finalize' }",
          "{ type: 'get_subtitles', format: 'srt' | 'ass' | 'all' }",
        ],
        server_to_client: [
          "{ type: 'connected', model, language, ... }",
          "{ type: 'ready', upstream }",
          "{ type: 'word', word, start, end, confidence, isFinal }",
          "{ type: 'chunk', chunk: { text, start, end, words } }",
          "{ type: 'subtitles', srt, ass, chunks }",
          "{ type: 'error', error }",
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
