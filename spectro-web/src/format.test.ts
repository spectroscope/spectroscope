// Pins for the duration/offset formatters. Long sessions (card 87 stamps the
// answer footer with real wall-clock spans) must not read "1210 m 12 s".

import { describe, expect, it } from "vitest";
import {
  answerLineSegments,
  cacheSplit,
  fileLabel,
  formatDuration,
  formatRelMs,
  tokensPerSecond,
  type AnswerLineTurn,
} from "./format";
import type { AnswerLineMode } from "./state/answerLine";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("formatDuration", () => {
  it("keeps the sub-minute tiers", () => {
    expect(formatDuration(412)).toBe("0.4 s");
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

describe("tokensPerSecond (card 245)", () => {
  it("reads whole tokens per second at speed", () => {
    // 1237 tokens over 20 s — the cloud tier.
    expect(tokensPerSecond(1237, 20000)).toBe("62 tok/s");
  });

  it("keeps a decimal below ten, where the digit is the story", () => {
    // 30 tokens over 6.3 s — the local-model tier.
    expect(tokensPerSecond(30, 6300)).toBe("4.8 tok/s");
  });

  it("never renders a rate that reads '10.0' — the boundary carries first", () => {
    expect(tokensPerSecond(996, 100000)).toBe("10 tok/s");
  });

  it("refuses an unmeasured answer — no duration, no rate", () => {
    expect(tokensPerSecond(30, undefined)).toBeNull();
  });

  it("refuses a zero or negative duration instead of printing Infinity", () => {
    expect(tokensPerSecond(30, 0)).toBeNull();
    expect(tokensPerSecond(30, -5)).toBeNull();
  });

  it("refuses zero output tokens — nothing generated has no speed", () => {
    expect(tokensPerSecond(0, 2000)).toBeNull();
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

describe("answerLineSegments (card 374)", () => {
  // The owner's own backend: LM Studio reports no cache at all, so the two
  // cache fields are absent from the event (Agent.java:589 to :590 turns a
  // zero into null). This is what an operator on a local LM Studio host sees, every answer.
  const lmStudio: AnswerLineTurn = {
    usage: { inputTokens: 7498, outputTokens: 84 },
    durationMs: 3300,
    endTs: Date.UTC(2026, 8, 18, 9, 0, 3, 300),
    model: "/models/lmstudio/deepseek-v4-flash-0731@iq1_m.gguf",
  };

  // An Anthropic answer with a warm cache: the only shape that carries all four
  // numbers, and the one where the labelled "in" is the SMALL number.
  const anthropic: AnswerLineTurn = {
    usage: {
      inputTokens: 812,
      outputTokens: 1040,
      cacheReadTokens: 40100,
      cacheCreationTokens: 1200,
    },
    durationMs: 8200,
    endTs: Date.UTC(2026, 8, 18, 9, 0, 8, 200),
    model: "claude-sonnet-5",
  };

  const kinds = (mode: AnswerLineMode, turn: AnswerLineTurn): string[] =>
    answerLineSegments(mode, turn).map((s) => s.kind);

  it("normal carries exactly the three numbers the owner asked for", () => {
    expect(kinds("normal", anthropic)).toEqual(["in", "out", "duration"]);
    expect(kinds("normal", lmStudio)).toEqual(["in", "out", "duration"]);
  });

  it("extended carries the owner's list, in order", () => {
    expect(kinds("extended", anthropic)).toEqual([
      "in",
      "cacheRead",
      "cacheWrite",
      "out",
      "context",
      "rate",
      "duration",
      "window",
      "model",
    ]);
  });

  it("draws a cache segment only where the provider reported one", () => {
    const at = (usage: Record<string, number>): string[] =>
      kinds("extended", {
        ...anthropic,
        usage: { inputTokens: 10, outputTokens: 2, ...usage },
      });
    expect(at({})).not.toContain("cacheRead");
    expect(at({ cacheReadTokens: 0 })).not.toContain("cacheRead");
    expect(at({ cacheReadTokens: 120 }).filter((k) => k === "cacheRead")).toHaveLength(1);
    expect(at({})).not.toContain("cacheWrite");
    expect(at({ cacheCreationTokens: 0 })).not.toContain("cacheWrite");
    expect(at({ cacheCreationTokens: 120 }).filter((k) => k === "cacheWrite")).toHaveLength(1);
    // The positive twin: an absent cache half does not swallow the rest.
    expect(at({})).toEqual(["in", "out", "rate", "duration", "window", "model"]);
  });

  it("names the context total, and it is the sum Agent.contextTokens computes", () => {
    const segments = answerLineSegments("extended", anthropic);
    const raw = segments.find((s) => s.kind === "in");
    const total = segments.find((s) => s.kind === "context");
    expect(raw?.value).toBe("812");
    expect(total?.value).toBe(String(812 + 40100 + 1200));
    expect(total?.label).not.toBe(raw?.label);
    expect(total?.label).not.toBe("");
  });

  it("leaves the context total out when it would repeat the in count", () => {
    expect(kinds("extended", lmStudio)).not.toContain("context");
    expect(kinds("extended", lmStudio).filter((k) => k === "in")).toHaveLength(1);
    expect(kinds("extended", anthropic)).toContain("context");
  });

  it("shortens the model and keeps the whole string on hover", () => {
    const model = (m: string) =>
      answerLineSegments("extended", { ...lmStudio, model: m }).find((s) => s.kind === "model");
    expect(model("/models/a/b/deepseek-v4-flash-0731@iq1_m.gguf")?.value).toBe(
      fileLabel("deepseek-v4-flash-0731@iq1_m.gguf"),
    );
    expect(model("gpt-4o-mini")?.value).toBe("gpt-4o-mini");
    // 28 characters, no separator: the cap applies to every string, not only
    // to paths, and this is the id the owner actually runs.
    const bare = model("deepseek-v4-flash-0731@iq1_m");
    expect(bare?.value).not.toBe("deepseek-v4-flash-0731@iq1_m");
    expect(bare?.value).toContain("…");
    expect(bare?.title).toBe("deepseek-v4-flash-0731@iq1_m");
    expect(model("gpt-4o-mini")?.title).toBe("gpt-4o-mini");
  });

  it("draws nothing at all for an answer nobody measured", () => {
    expect(answerLineSegments("normal", {})).toEqual([]);
    expect(answerLineSegments("extended", {})).toEqual([]);
    expect(answerLineSegments("extended", { durationMs: 3300, model: "x" })).toEqual([]);
  });

  it("reads the wall clock window by shape, since clockTime is local", () => {
    const window = answerLineSegments("extended", anthropic).find((s) => s.kind === "window");
    expect(window?.value).toMatch(/^\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2}$/);
  });
});
