import { describe, expect, it } from "vitest";
import {
  MAX_CLIP_SECONDS,
  WHISPER_RATE,
  clipSeconds,
  pcm16,
  wavBytes,
  wavFromRecording,
  type Decoded,
} from "./wavClip";

/** Read the fields of a canonical 44-byte WAV header. */
function header(bytes: Uint8Array): Record<string, number | string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number): string => String.fromCharCode(...bytes.slice(at, at + 4));
  return {
    riff: text(0),
    riffSize: view.getUint32(4, true),
    wave: text(8),
    fmt: text(12),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: text(36),
    dataSize: view.getUint32(40, true),
  };
}

describe("pcm16", () => {
  it("maps the float range onto the full signed 16 bit range", () => {
    const pcm = pcm16(new Float32Array([0, 1, -1, 0.5]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(16384); // half of 32767 is 16383.5, and it rounds up
  });

  it("clamps samples outside the range instead of wrapping around", () => {
    // Web Audio may hand over values slightly past ±1; a wrap turns the loudest
    // moment of a recording into its opposite, which is audible as a click.
    const pcm = pcm16(new Float32Array([1.4, -1.4]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
  });
});

describe("wavBytes", () => {
  it("writes the header whisper.cpp expects: 16 bit PCM, one channel, 16 kHz", () => {
    const h = header(wavBytes(new Int16Array([1, 2, 3, 4]), WHISPER_RATE));
    expect(h.riff).toBe("RIFF");
    expect(h.wave).toBe("WAVE");
    expect(h.fmt).toBe("fmt ");
    expect(h.fmtSize).toBe(16);
    expect(h.audioFormat).toBe(1); // 1 = uncompressed PCM
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(16000);
    expect(h.bitsPerSample).toBe(16);
    expect(h.blockAlign).toBe(2); // one channel × two bytes
    expect(h.byteRate).toBe(32000); // and therefore 32 kB per second
    expect(h.data).toBe("data");
  });

  it("states its own sizes correctly, so a reader can trust the header", () => {
    const bytes = wavBytes(new Int16Array(100), WHISPER_RATE);
    const h = header(bytes);
    expect(bytes.length).toBe(44 + 200);
    expect(h.dataSize).toBe(200);
    expect(h.riffSize).toBe(bytes.length - 8); // everything after the size field
  });

  it("carries the samples verbatim, little endian, right after the header", () => {
    const bytes = wavBytes(new Int16Array([-2, 1000]), WHISPER_RATE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(44, true)).toBe(-2);
    expect(view.getInt16(46, true)).toBe(1000);
  });
});

describe("clipSeconds", () => {
  it("reads a duration back out of the encoded size", () => {
    expect(clipSeconds(wavBytes(new Int16Array(WHISPER_RATE * 3), WHISPER_RATE).length)).toBe(3);
  });
});

/** A decoder that answers with a fixed duration and a ramp of samples. */
function fakeAudio(duration: number): {
  decode: (bytes: ArrayBuffer) => Promise<Decoded>;
  monoAt: (decoded: Decoded, rate: number) => Promise<Float32Array>;
  asked: { bytes: number; rate: number };
} {
  const asked = { bytes: 0, rate: 0 };
  return {
    asked,
    async decode(bytes: ArrayBuffer): Promise<Decoded> {
      asked.bytes = bytes.byteLength;
      return { duration };
    },
    async monoAt(decoded: Decoded, rate: number): Promise<Float32Array> {
      asked.rate = rate;
      return new Float32Array(Math.round(decoded.duration * rate));
    },
  };
}

describe("wavFromRecording", () => {
  it("decodes the recording and asks for one channel at whisper's rate", async () => {
    const audio = fakeAudio(2);

    const wav = await wavFromRecording(new ArrayBuffer(1234), audio);

    expect(audio.asked.bytes).toBe(1234);
    expect(audio.asked.rate).toBe(WHISPER_RATE);
    expect(header(wav).sampleRate).toBe(WHISPER_RATE);
    expect(header(wav).dataSize).toBe(2 * WHISPER_RATE * 2); // two seconds, two bytes each
  });

  it("stops at the stated ceiling rather than posting an unbounded body", async () => {
    // The hook stops the recorder at the ceiling, so this is the second fence:
    // whatever arrives, the POST has a known largest size.
    const wav = await wavFromRecording(new ArrayBuffer(8), fakeAudio(MAX_CLIP_SECONDS + 90));

    expect(clipSeconds(wav.length)).toBe(MAX_CLIP_SECONDS);
  });

  it("returns a readable empty clip for a recording with no audio in it", async () => {
    const wav = await wavFromRecording(new ArrayBuffer(8), fakeAudio(0));

    expect(wav.length).toBe(44); // a valid header and no samples
    expect(header(wav).dataSize).toBe(0);
  });
});
