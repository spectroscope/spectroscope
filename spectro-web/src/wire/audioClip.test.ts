import { describe, expect, it } from "vitest";
import {
  base64OffsetAt,
  base64WindowAt,
  bytesOfBase64,
  clockOf,
  estimatedWordSpans,
  parseWav,
  transcriptOf,
  waveformBins,
  wordIndexAt,
} from "./audioClip";

/** A minimal PCM16 WAV, built the way wavClip.ts writes one: canonical
 *  44-byte header, little-endian samples. */
function wavFixture(samples: number[], sampleRate = 16000, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2 * channels, true);
  v.setUint16(32, 2 * channels, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return new Uint8Array(buf);
}

function b64Of(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("parseWav walks chunks, never assumes offsets", () => {
  it("reads the canonical clip wavClip.ts produces", () => {
    const clip = parseWav(wavFixture([0, 16384, -16384, 32767], 16000, 1));
    expect(clip).not.toBeNull();
    expect(clip?.sampleRate).toBe(16000);
    expect(clip?.channels).toBe(1);
    expect(clip?.dataOffset).toBe(44);
    expect(Array.from(clip?.samples ?? [])).toEqual([0, 16384, -16384, 32767]);
    expect(clip?.seconds).toBeCloseTo(4 / 16000);
  });

  it("survives an extra chunk between fmt and data", () => {
    const base = wavFixture([100, -100]);
    // splice a 4-byte "LIST" chunk in front of "data"
    const out = new Uint8Array(base.length + 12);
    out.set(base.subarray(0, 36), 0);
    out.set(new TextEncoder().encode("LIST"), 36);
    new DataView(out.buffer).setUint32(40, 4, true);
    out.set(new TextEncoder().encode("info"), 44);
    out.set(base.subarray(36), 48);
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    const clip = parseWav(out);
    expect(clip).not.toBeNull();
    expect(Array.from(clip?.samples ?? [])).toEqual([100, -100]);
  });

  it("refuses a crafted chunk size instead of walking past the end", () => {
    const bad = wavFixture([1, 2, 3]);
    new DataView(bad.buffer).setUint32(40, 0xfffffff0, true); // data size lies
    expect(parseWav(bad)).toBeNull();
  });

  it("refuses what is not PCM16 or not a WAV at all", () => {
    expect(parseWav(new Uint8Array([1, 2, 3]))).toBeNull();
    const notPcm = wavFixture([1]);
    new DataView(notPcm.buffer).setUint16(20, 3, true); // float format
    expect(parseWav(notPcm)).toBeNull();
  });
});

describe("the decode pair", () => {
  it("round-trips bytes through base64", () => {
    const bytes = wavFixture([7, -7]);
    expect(Array.from(bytesOfBase64(b64Of(bytes)) ?? [])).toEqual(Array.from(bytes));
  });
  it("answers null for text that is not base64, never throws", () => {
    expect(bytesOfBase64("not base64 !!!")).toBeNull();
  });
});

describe("waveformBins", () => {
  it("takes the peak per bin, scaled to 0..1", () => {
    const bins = waveformBins(new Int16Array([0, 16384, -32768, 100]), 2);
    expect(bins.length).toBe(2);
    expect(bins[0]).toBeCloseTo(16384 / 32768);
    expect(bins[1]).toBeCloseTo(1);
  });
  it("is calm about empty input", () => {
    expect(waveformBins(new Int16Array(0), 4)[0]).toBe(0);
  });
});

describe("the encoded-text arithmetic", () => {
  const clip = parseWav(wavFixture(new Array(1600).fill(0)))!; // 0.1 s
  const b64len = Math.ceil((44 + 3200) / 3) * 4;

  it("maps t=0 to the header's characters, not to zero audio bytes", () => {
    // 44 header bytes are 14 full 3-byte groups -> char 56
    expect(base64OffsetAt(0, clip, b64len)).toBe(Math.floor(44 / 3) * 4);
  });
  it("maps the end inside the text and clamps beyond it", () => {
    const end = base64OffsetAt(clip.seconds, clip, b64len);
    expect(end).toBeLessThan(b64len);
    expect(base64OffsetAt(999, clip, b64len)).toBe(end);
  });
  it("slides a fixed window that never leaves the text", () => {
    const text = "A".repeat(100);
    expect(base64WindowAt(text, 0, 20).text.length).toBe(20);
    expect(base64WindowAt(text, 99, 20).text.length).toBe(20);
  });
});

describe("estimated word spans say so and behave", () => {
  it("weights by length and covers the whole clip", () => {
    const spans = estimatedWordSpans("a verylongword b", 10);
    expect(spans.length).toBe(3);
    expect(spans[0].start).toBe(0);
    expect(spans[2].end).toBe(10);
    // the long word gets the lion's share
    expect(spans[1].end - spans[1].start).toBeGreaterThan(spans[0].end - spans[0].start);
  });
  it("finds the word under the playhead, and -1 before speech", () => {
    const spans = estimatedWordSpans("one two three", 3);
    expect(wordIndexAt(spans, -1)).toBe(-1);
    expect(wordIndexAt(spans, 0)).toBe(0);
    expect(wordIndexAt(spans, 2.99)).toBe(2);
  });
  it("is empty for an empty transcript or zero-length clip", () => {
    expect(estimatedWordSpans("", 5)).toEqual([]);
    expect(estimatedWordSpans("hi", 0)).toEqual([]);
  });
});

describe("transcriptOf reads both recorded shapes", () => {
  it("hosted: the provider JSON's text field", () => {
    expect(transcriptOf('{"text": "hallo welt"}')).toBe("hallo welt");
  });
  it("local: plain text verbatim", () => {
    expect(transcriptOf("  hallo welt\n")).toBe("hallo welt");
  });
  it("JSON without a text field is not a transcript", () => {
    expect(transcriptOf('{"error": "nope"}')).toBeNull();
  });
  it("null and empty stay null", () => {
    expect(transcriptOf(null)).toBeNull();
    expect(transcriptOf("   ")).toBeNull();
  });
});

describe("clockOf", () => {
  it("prints tenths with a padded second", () => {
    expect(clockOf(0)).toBe("0:00.0");
    expect(clockOf(65.27)).toBe("1:05.2");
  });
});
