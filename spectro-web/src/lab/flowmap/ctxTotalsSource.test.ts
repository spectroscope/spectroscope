// Card 300: the root's context totals carry WHERE the threshold came from, so
// a surface does not have to scan the stream a second time to find out.
//
// deriveDetail already keeps the root's latest context_info and already
// ignores every other agent's (children emit none anyway). The provenance
// rides along on the same fold rather than in a second one.

import { describe, expect, it } from "vitest";
import { deriveDetail } from "./sceneToFlow";
import type { RunEvent } from "../../events";

const info = (extra: Record<string, unknown> = {}): RunEvent =>
  ({
    type: "context_info",
    agentId: "main",
    turn: 1,
    messages: 4,
    estimatedTokens: 43_000,
    threshold: 153_216,
    parts: [],
    ts: 5,
    ...extra,
  }) as RunEvent;

const rootStart: RunEvent = {
  type: "run_start",
  runId: "r",
  agentId: "main",
  prompt: "go",
  ts: 1,
} as RunEvent;

describe("ctxTotals carries the threshold's provenance (card 300)", () => {
  it("the source arrives when the frame stated one", () => {
    const d = deriveDetail([rootStart, info({ thresholdSource: "window" })]);
    expect(d.ctxTotals).toEqual({
      messages: 4,
      estimatedTokens: 43_000,
      threshold: 153_216,
      thresholdSource: "window",
    });
  });

  it("a frame that stated none leaves the key absent, not undefined", () => {
    const d = deriveDetail([rootStart, info()]);
    expect(d.ctxTotals).not.toBeNull();
    expect("thresholdSource" in (d.ctxTotals as object)).toBe(false);
    expect(d.ctxTotals?.threshold).toBe(153_216);
  });

  it("the latest root frame wins, provenance included", () => {
    const d = deriveDetail([
      rootStart,
      info({ thresholdSource: "fallback", threshold: 100_000 }),
      info({ thresholdSource: "override", threshold: 5_000, ts: 9 }),
    ]);
    expect(d.ctxTotals?.thresholdSource).toBe("override");
    expect(d.ctxTotals?.threshold).toBe(5_000);
  });
});

// Card 377: the WINDOW rides the same fold. The panel divides by it now, so a
// fold that drops it would leave the lab reading a compaction point while the
// header ring reads the window: one run, two scales.
describe("ctxTotals carries the window too (card 377)", () => {
  it("the window arrives when the frame stated one", () => {
    const d = deriveDetail([rootStart, info({ thresholdSource: "window", contextWindow: 250_368 })]);
    expect(d.ctxTotals?.contextWindow).toBe(250_368);
  });

  it("a frame that stated none leaves the key absent, not undefined", () => {
    const d = deriveDetail([rootStart, info({ thresholdSource: "window" })]);
    expect("contextWindow" in (d.ctxTotals as object)).toBe(false);
  });

  it("the latest root frame wins, window included", () => {
    const d = deriveDetail([
      rootStart,
      info({ thresholdSource: "window", contextWindow: 131_072 }),
      info({ thresholdSource: "window", contextWindow: 250_368, ts: 9 }),
    ]);
    expect(d.ctxTotals?.contextWindow).toBe(250_368);
  });
});
