# Roadmap & TODO: Fitur Live Caption (Opsi A)

Dokumen ini berisi daftar tugas implementasi fitur **Live Caption** di **NineRouter** (`my-ninerouter`), dirancang untuk bekerja sama dengan project **Cliper**.

---

## 📋 Daftar Tugas (TODO List)

### Fase 1: Menu Baru "Live Caption" di Dashboard (Media Providers)
- [x] Daftarkan kind baru di `src/shared/constants/providers.js`:
  ```javascript
  { id: "liveCaption", label: "Live Caption", icon: "closed_caption", endpoint: { method: "WS", path: "/v1/audio/live-transcriptions" } }
  ```
- [x] Tambahkan `"liveCaption"` ke `VISIBLE_MEDIA_KINDS` di `src/shared/components/Sidebar.js`.
- [x] Daftarkan provider yang mendukung streaming (`serviceKinds: ["liveCaption", ...]`) di `src/shared/constants/providers.js` / provider registry:
  - `deepgram` (Nova 3, Nova 2, Whisper Large, Nova)
  - `gemini` (Gemini Live realtime audio bidi)
  - `elevenlabs` (Scribe v1, Scribe v2)
  - `selfhosted-stt` (Whisper 1)

### Fase 2: Streaming Endpoint & Proxy Handler
- [x] Buat handler WebSocket di `src/sse/handlers/liveCaptionWs.js` dan integrasikan ke `custom-server.js` (serta route info di `src/app/api/v1/audio/live-transcriptions/route.js`).
- [x] Implementasikan proxy pipeline:
  - Terima binary audio chunk dari client (format PCM / Opus / WebM).
  - Teruskan stream ke upstream provider secara aman (menggunakan API Key yang tersimpan di NineRouter).
  - Kirimkan kembali event delta kata (`{ word, start, end, isFinal }`) ke client secara real-time.
- [x] Dukungan output subtitle formatter di `src/sse/utils/subtitleFormatter.js` (menghasilkan chunk ritme kata, format `.srt`, dan format `.ass` karaoke dengan tag `\k` siap pakai).

### Fase 3: Testing Playground di Dashboard
- [x] Buat komponen `LiveCaptionExampleCard.js` di `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/`:
  - Input dari mikrofon langsung (Browser Web Audio API 16kHz PCM).
  - Tampilan teks takarir karaoke yang langsung menyala kata per kata secara real-time.
  - Tombol Copy .SRT dan Copy .ASS (Karaoke).
  - Tampilan Endpoint WebSocket & status koneksi upstream.

### Fase 4: Integrasi dengan Cliper
- [x] Sederhanakan `.env` di Cliper (`apps/api/.env.example` & `.dev.vars.example`): hanya butuh `NINEROUTER_BASE_URL` dan `NINEROUTER_API_KEY`.
- [x] Hubungkan audio player / consumer Cliper ke endpoint WebSocket `/v1/audio/live-transcriptions` via helper `createLiveCaptionClient` di `@cliper/core` (`packages/core/src/live-caption.ts`).
- [x] Pertahankan proses *burn-in* video di lokal Cliper menggunakan FFmpeg (`ass=filename=...`).
