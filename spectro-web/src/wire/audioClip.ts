// The audio half of the structured face for an stt exchange (card 184/187).
//
// The recorded request body is the recording's own base64 of the WAV the
// browser built (fidelity "encoded", both routes). Until now the structured
// face fell back to a JSON tree over that string — a wall of base64, which is
// exactly what the measured-gap idiom exists to prevent. This module turns the
// bytes back into something a person can read: a parsed clip for a waveform
// and a player, the transcript cut into words, and the arithmetic that says
// where in the ENCODED text a moment of audio lives.
//
// Everything here is pure and pinnable; Web Audio and the canvas stay in the
// component, untested, the micLevel.ts rule.

/** A parsed PCM16 WAV — offsets are into the DECODED byte array. */
export interface WavClip {
  sampleRate: number;
  channels: number;
  /** Offset of the first sample byte inside the file. */
  dataOffset: number;
  /** Byte length of the sample data (not the file). */
  dataBytes: number;
  /** The samples, interleaved when stereo. */
  samples: Int16Array;
  /** Whole-clip length in seconds. */
  seconds: number;
}

/**
 * Decode a base64 string into bytes without touching the DOM.
 *
 * `atob` exists in every browser and in Node ≥16, which is what the test
 * runner is — so this needs no seam.
 *
 * @param b64 the base64 text
 * @return the bytes, or null when the text is not base64
 */
export function bytesOfBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Parse a PCM16 WAV by walking its chunks, the way the server's WavAudio does
 * — never by assuming fixed offsets, because a fmt chunk may carry extension
 * bytes and other chunks may sit between fmt and data.
 *
 * @param bytes the decoded file
 * @return the clip, or null for anything that is not readable 16-bit PCM
 */
export function parseWav(bytes: Uint8Array): WavClip | null {
  const ascii = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    // A crafted or truncated size must stop the walk, never run it past the
    // end — the server-side twin of this walk has an overflow finding open.
    if (size > bytes.length) return null;
    if (id === "fmt ") {
      if (at + 24 > bytes.length) return null;
      const format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
      if (format !== 1) return null; // PCM only, the recorded contract
    } else if (id === "data") {
      dataOffset = at + 8;
      dataBytes = Math.min(size, bytes.length - dataOffset);
    }
    at += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (dataOffset < 0 || sampleRate <= 0 || channels <= 0 || bits !== 16) return null;

  const sampleCount = Math.floor(dataBytes / 2);
  // Int16Array needs 2-byte alignment; a copy is cheaper than being clever.
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = view.getInt16(dataOffset + i * 2, true);
  return {
    sampleRate,
    channels,
    dataOffset,
    dataBytes,
    samples,
    seconds: sampleCount / channels / sampleRate,
  };
}

/**
 * The waveform, as one peak per column: max |sample| in the bin, 0..1.
 * Interleaved channels fold into the same bin, which is the honest picture
 * for a level display.
 *
 * @param samples the clip's samples
 * @param bins how many columns the canvas has
 * @return one peak per bin
 */
export function waveformBins(samples: Int16Array, bins: number): Float32Array {
  const out = new Float32Array(Math.max(1, bins));
  if (samples.length === 0 || bins <= 0) return out;
  const per = samples.length / bins;
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * per)));
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak / 32768;
  }
  return out;
}

/**
 * Where a moment of audio lives inside the ENCODED text.
 *
 * Three exact steps: time → sample byte inside the file, then byte → base64
 * character (every 3 bytes are 4 characters), clamped to the text.
 *
 * @param seconds  playback position
 * @param clip     the parsed clip
 * @param b64Length the length of the encoded body
 * @return the character offset into the base64 text
 */
export function base64OffsetAt(seconds: number, clip: WavClip, b64Length: number): number {
  const clamped = Math.min(Math.max(seconds, 0), clip.seconds);
  const sampleByte = Math.floor(clamped * clip.sampleRate) * 2 * clip.channels;
  const fileByte = clip.dataOffset + Math.min(sampleByte, clip.dataBytes);
  const char = Math.floor(fileByte / 3) * 4;
  return Math.min(char, Math.max(0, b64Length - 1));
}

/** A fixed window of the encoded text around a position — the sliding pane. */
export function base64WindowAt(b64: string, offset: number, width: number): { text: string; at: number } {
  const half = Math.floor(width / 2);
  const start = Math.min(Math.max(0, offset - half), Math.max(0, b64.length - width));
  return { text: b64.slice(start, start + width), at: offset };
}

/** One transcript word with its ESTIMATED time span. */
export interface WordSpan {
  word: string;
  start: number;
  end: number;
}

/**
 * Cut a transcript into words and spread them over the clip's length,
 * weighted by character count.
 *
 * An estimate, and deliberately labelled as one everywhere it is shown: the
 * record carries no timestamps on either route (whisper-cli runs with
 * --no-timestamps, the hosted call never asks for verbose_json), so equal
 * treatment of what we know and what we guess is the whole point. Longer
 * words get more time, which tracks speech closely enough to follow along
 * and never claims more.
 *
 * @param transcript the response text
 * @param seconds    the clip length
 * @return the words in order, spans covering [0, seconds]
 */
export function estimatedWordSpans(transcript: string, seconds: number): WordSpan[] {
  const words = transcript.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || seconds <= 0) return [];
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const spans: WordSpan[] = [];
  let t = 0;
  for (let i = 0; i < words.length; i++) {
    const dt = (weights[i] / total) * seconds;
    spans.push({ word: words[i], start: t, end: t + dt });
    t += dt;
  }
  spans[spans.length - 1].end = seconds; // absorb rounding
  return spans;
}

/**
 * The word under the playhead — the last span whose start is not in the
 * future, so a position between words highlights the word just spoken.
 *
 * @param spans the estimated spans
 * @param seconds playback position
 * @return the index, or -1 before the first word
 */
export function wordIndexAt(spans: WordSpan[], seconds: number): number {
  let hit = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].start <= seconds) hit = i;
    else break;
  }
  return hit;
}

/**
 * Read the transcript out of the recorded response body.
 *
 * Two shapes exist and both are recorded verbatim: the hosted route stores the
 * provider's JSON (`{"text": ...}`), the local route stores the cleaned
 * transcript as plain text. A JSON body without a string `text` yields null
 * rather than a guess.
 *
 * @param body the llm_response body, or null while the exchange is open
 * @return the transcript, or null when there is none to show
 */
export function transcriptOf(body: string | null): string | null {
  if (body === null) return null;
  const trimmed = body.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
        const text = (parsed as { text: unknown }).text;
        return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
      }
      return null;
    } catch {
      return trimmed; // JSON-looking plain text is still plain text
    }
  }
  return trimmed;
}

/** `m:ss.t` for the readouts — tenths, because whole seconds jump too coarsely. */
export function clockOf(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const tenths = Math.floor(rest * 10) / 10;
  return `${m}:${tenths < 10 ? "0" : ""}${tenths.toFixed(1)}`;
}
