// The audio that goes up WHILE someone is still speaking (card 187 step 6).
//
// The batch path in wavClip.ts waits for the recorder to stop, converts once and
// POSTs a whole file. A live session is the opposite shape: small pieces of the
// same PCM, sent as they are captured, so the far side can answer with words
// before the sentence is finished. Everything here is the arithmetic of that,
// and none of it touches Web Audio — the capture chain lives in the hook, for
// the same reason wavClip.ts leaves `decodeAudioData` to the browser: a claim
// about a browser is checked by running it, not by a unit test.
//
// Measured against the live API on 2026-08-09: 200 ms appends of 24 kHz mono
// PCM16 produced word-level deltas from 2.1 s into a 19 s clip, 59 of the 64
// deltas arriving before the audio had finished going out.

import { pcm16 } from "./wavClip";

/**
 * How much audio rides in one `input_audio_buffer.append`.
 *
 * Small enough that the far side hears a word soon after it is spoken, large
 * enough that the socket is not carrying more framing than sound. The value is
 * the one the measurement used, so the timings recorded on card 187 describe
 * this cadence and not a nearby one.
 */
export const APPEND_MS = 200;

/** Base64's alphabet, and the chunk size the encoder walks the bytes in.
 *  0x8000 samples at a time keeps `String.fromCharCode` inside every engine's
 *  argument limit while still being one call per 32 kB. */
const FROM_CHAR_CODE_WINDOW = 0x8000;

/**
 * How many frames one append carries at a given rate.
 *
 * @param rate the capture rate, from `captureRate`
 * @param ms the window; defaults to {@link APPEND_MS}
 * @return the frame count, never zero — an append with no audio in it is pure
 *         overhead on a socket that is carrying a conversation in real time
 */
export function appendFrames(rate: number, ms: number = APPEND_MS): number {
  return Math.max(1, Math.round((rate * ms) / 1000));
}

/**
 * Float samples to the base64 PCM16 the realtime session appends.
 *
 * Signed 16 bit little endian, because that is what `audio/pcm` means to the
 * far side and nothing in the handshake negotiates it — byte order backwards
 * still transcribes to *something*, which is the worst kind of wrong.
 *
 * @param samples the captured channel, nominally -1…1
 * @return the base64 payload, or the empty string for an empty buffer
 */
export function base64Pcm(samples: Float32Array): string {
  if (samples.length === 0) return "";
  const pcm = pcm16(samples);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // Spreading the whole array into fromCharCode is the obvious version and it
  // blows the call stack in the tens of thousands of arguments — which is an
  // ordinary chunk, not an exotic one, as soon as a backgrounded tab catches
  // up on its buffer.
  let binary = "";
  for (let at = 0; at < bytes.length; at += FROM_CHAR_CODE_WINDOW) {
    binary += String.fromCharCode(...bytes.subarray(at, at + FROM_CHAR_CODE_WINDOW));
  }
  return btoa(binary);
}
