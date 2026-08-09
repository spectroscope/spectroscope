import { describe, expect, it } from "vitest";
import { APPEND_MS, appendFrames, base64Pcm } from "./pcmChunks";
import { LIVE_RATE } from "./liveTranscription";

/** Decode base64 back to bytes the way the far side would. */
function bytesOf(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

describe("the chunks that go up while someone is still speaking", () => {
  it("encodes signed 16 bit little endian, which is what pcm16 means", () => {
    // The far side is told `audio/pcm` at a rate and nothing else, so byte
    // order is not negotiated anywhere — it is simply assumed, and getting it
    // backwards produces audible noise that still transcribes to *something*.
    const bytes = bytesOf(base64Pcm(new Float32Array([0, 1, -1])));
    expect(bytes.length).toBe(6);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
  });

  it("clamps instead of wrapping, so a shout does not become its opposite", () => {
    const bytes = bytesOf(base64Pcm(new Float32Array([1.4, -1.4])));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it("survives a chunk far larger than one append", () => {
    // The naive encoder is String.fromCharCode(...bytes), which blows the call
    // stack somewhere in the tens of thousands of arguments. A long chunk is
    // exactly what arrives when a tab is backgrounded and the buffer catches
    // up, so this is the ordinary case and not the exotic one.
    const long = new Float32Array(200_000);
    for (let i = 0; i < long.length; i++) long[i] = Math.sin(i / 20);
    const encoded = base64Pcm(long);
    expect(bytesOf(encoded).length).toBe(long.length * 2);
  });

  it("encodes an empty buffer as an empty string, not as a broken frame", () => {
    expect(base64Pcm(new Float32Array(0))).toBe("");
  });

  it("counts one append as 200 ms of the live rate", () => {
    // 200 ms is what the 2026-08-09 measurement fed the session; word-level
    // deltas came back from 2.1 s onward on a 19 s clip.
    expect(APPEND_MS).toBe(200);
    expect(appendFrames(LIVE_RATE)).toBe(4800);
    expect(appendFrames(LIVE_RATE, 1000)).toBe(LIVE_RATE);
  });

  it("never produces a zero-frame append, however small the window", () => {
    // A zero-length append is a message with no audio in it: pure overhead on
    // a socket that is carrying a conversation in real time.
    expect(appendFrames(LIVE_RATE, 0)).toBeGreaterThan(0);
  });
});
