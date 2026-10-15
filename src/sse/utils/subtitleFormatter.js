/**
 * Subtitle formatting utilities for Live Caption streaming.
 * Produces word-rhythm chunks, .srt, and .ass (karaoke tags \k).
 */

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimeSrt(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * Format seconds to ASS timestamp: H:MM:SS.cc (centiseconds)
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimeAss(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Chunk a list of words into readable subtitle segments based on rhythm, length, and punctuation.
 * @param {Array<{word: string, start: number, end: number, confidence?: number}>} words
 * @param {Object} [options]
 * @param {number} [options.maxWords=5]
 * @param {number} [options.maxDuration=2.5]
 * @param {number} [options.maxGap=0.8]
 * @returns {Array<{text: string, start: number, end: number, words: Array}>}
 */
export function chunkWords(words, options = {}) {
  const { maxWords = 5, maxDuration = 2.5, maxGap = 0.8 } = options;
  if (!Array.isArray(words) || words.length === 0) return [];

  const chunks = [];
  let currentWords = [];
  let chunkStart = null;
  let lastEnd = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wordText = String(w.word || "").trim();
    if (!wordText) continue;

    const start = Number(w.start) || 0;
    const end = Number(w.end) || start + 0.3;

    if (currentWords.length === 0) {
      chunkStart = start;
      currentWords.push({ ...w, word: wordText, start, end });
      lastEnd = end;
      continue;
    }

    const durationSoFar = end - chunkStart;
    const gapFromLast = start - (lastEnd ?? start);
    const hasPunctuation = /[.?!]$/.test(currentWords[currentWords.length - 1].word);

    if (currentWords.length >= maxWords || durationSoFar > maxDuration || gapFromLast > maxGap || hasPunctuation) {
      chunks.push({
        text: currentWords.map((cw) => cw.word).join(" "),
        start: chunkStart,
        end: lastEnd ?? end,
        words: [...currentWords],
      });
      chunkStart = start;
      currentWords = [{ ...w, word: wordText, start, end }];
    } else {
      currentWords.push({ ...w, word: wordText, start, end });
    }
    lastEnd = end;
  }

  if (currentWords.length > 0) {
    chunks.push({
      text: currentWords.map((cw) => cw.word).join(" "),
      start: chunkStart,
      end: lastEnd,
      words: [...currentWords],
    });
  }

  return chunks;
}

/**
 * Convert word-level chunks into SRT subtitle string
 * @param {Array<{text: string, start: number, end: number}>} chunks
 * @returns {string}
 */
export function chunksToSrt(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return "";
  return chunks
    .map((chunk, idx) => {
      const index = idx + 1;
      const timecode = `${formatTimeSrt(chunk.start)} --> ${formatTimeSrt(chunk.end)}`;
      return `${index}\n${timecode}\n${chunk.text}\n`;
    })
    .join("\n");
}

/**
 * Convert word-level chunks into ASS subtitle with karaoke timing tags (\k)
 * @param {Array<{text: string, start: number, end: number, words: Array<{word: string, start: number, end: number}>}>} chunks
 * @param {Object} [options]
 * @param {string} [options.title="Live Caption"]
 * @param {number} [options.width=1080]
 * @param {number} [options.height=1920]
 * @returns {string}
 */
export function chunksToAss(chunks, options = {}) {
  const { title = "Live Caption", width = 1080, height = 1920 } = options;

  const header = `[Script Info]
Title: ${title}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,60,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,40,40,240,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  if (!Array.isArray(chunks) || chunks.length === 0) return header;

  const events = chunks.map((chunk) => {
    const startStr = formatTimeAss(chunk.start);
    const endStr = formatTimeAss(chunk.end);

    // Build karaoke tags: \k<duration in centiseconds>
    let karaokeText = "";
    if (Array.isArray(chunk.words) && chunk.words.length > 0) {
      karaokeText = chunk.words
        .map((w) => {
          const durCentisecs = Math.max(1, Math.round(((w.end - w.start) || 0.2) * 100));
          return `{\\k${durCentisecs}}${w.word}`;
        })
        .join(" ");
    } else {
      karaokeText = chunk.text;
    }

    return `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${karaokeText}`;
  });

  return header + events.join("\n") + "\n";
}
