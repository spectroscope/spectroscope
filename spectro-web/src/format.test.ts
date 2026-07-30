// Pins for the duration/offset formatters. Long sessions (card 87 stamps the
// answer footer with real wall-clock spans) must not read "1210 m 12 s".

import { describe, expect, it } from "vitest";
import { cacheSplit, formatDuration, formatRelMs } from "./format";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("formatDuration", () => {
  it("keeps the sub-minute tiers", () => {
    expect(formatDuration(412)).toBe("DELIBERATELY BROKEN");
    expect(formatDuration(0)).toBe("0.0 s");
    expect(formatDuration(-5)).toBe("0.0 s");
    expect(formatDuration(12300)).toBe("12 s");
  });

  it("keeps the minute tier", () => {
    expect(formatDuration(96000)).toBe("1 m 36 s");
    expect(formatDuration(59 * MINUTE + 59 * SECOND)).toBe("59 m 59 s");
  });

  it("reads a long session in hours", () => {
    expect(formatDuration(20 * HOUR + 10 * MINUTE + 12 * SECOND)).toBe("20 h 10 m");
    expect(formatDuration(HOUR)).toBe("1 h 0 m");
    expect(formatDuration(2 * HOUR + 5 * MINUTE)).toBe("2 h 5 m");
  });

  it("carries rounding at the boundaries instead of overflowing a unit", () => {
    // Every rendered sub-unit stays below its base, whatever the input.
    expect(formatDuration(59 * MINUTE + 59.6 * SECOND)).toBe("1 h 0 m");
    expect(formatDuration(HOUR - 1)).toBe("1 h 0 m");
    expect(formatDuration(59.6 * SECOND)).toBe("1 m 0 s");
    expect(formatDuration(MINUTE - 1)).toBe("1 m 0 s");
  });

  it("never renders a sub-unit at or above its base", () => {
    for (let ms = 9000; ms < 3 * HOUR; ms += 137) {
      const out = formatDuration(ms);
      const minuteTier = /^(\d+) m (\d+) s$/.exec(out);
      const hourTier = /^(\d+) h (\d+) m$/.exec(out);
      if (minuteTier) expect(Number(minuteTier[2])).toBeLessThan(60);
      if (hourTier) expect(Number(hourTier[2])).toBeLessThan(60);
      expect(out).toMatch(/^(\d+(\.\d)? s|\d+ m \d+ s|\d+ h \d+ m)$/);
    }
  });
});

describe("cacheSplit", () => {
  it("is empty for a provider that reported no cache at all", () => {
    expect(cacheSplit({})).toEqual([]);
  });

  it("is empty for reported zeros — a zero is the provider saying 'none'", () => {
    expect(cacheSplit({ cacheReadTokens: 0, cacheCreationTokens: 0 })).toEqual([]);
  });

  it("reads a cache hit", () => {
    expect(cacheSplit({ cacheReadTokens: 3758 })).toEqual([{ kind: "read", tokens: 3758 }]);
  });

  it("reads a cache write on its own (the first turn of a session)", () => {
    expect(cacheSplit({ cacheCreationTokens: 3758 })).toEqual([{ kind: "write", tokens: 3758 }]);
  });

  it("reads both, hit first — the incremental case: read the prefix, write the increment", () => {
    expect(cacheSplit({ cacheReadTokens: 3410, cacheCreationTokens: 314 })).toEqual([
      { kind: "read", tokens: 3410 },
      { kind: "write", tokens: 314 },
    ]);
  });

  it("drops only the zero half when the other half is real", () => {
    expect(cacheSplit({ cacheReadTokens: 0, cacheCreationTokens: 314 })).toEqual([
      { kind: "write", tokens: 314 },
    ]);
  });
});

describe("formatRelMs", () => {
  it("keeps the sub-minute and minute tiers", () => {
    expect(formatRelMs(0)).toBe("t+0.00s");
    expect(formatRelMs(2310)).toBe("t+2.31s");
    expect(formatRelMs(96000)).toBe("t+1m36s");
    expect(formatRelMs(59 * MINUTE + 59 * SECOND)).toBe("t+59m59s");
  });

  it("reads a long offset in hours, keeping seconds so nodes stay distinct", () => {
    expect(formatRelMs(20 * HOUR + 10 * MINUTE + 12 * SECOND)).toBe("t+20h10m12s");
    expect(formatRelMs(HOUR)).toBe("t+1h00m00s");
    expect(formatRelMs(HOUR + 5 * MINUTE + 3 * SECOND)).toBe("t+1h05m03s");
  });

  it("truncates rather than rounding up into an impossible unit", () => {
    expect(formatRelMs(HOUR - 1)).toBe("t+59m59s");
    expect(formatRelMs(2 * HOUR - 1)).toBe("t+1h59m59s");
  });
});
