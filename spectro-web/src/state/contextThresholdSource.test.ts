// Card 300, step 4: the TypeScript catch-up for a field Java has been writing
// since card 263.
//
// WHY THIS IS NOT A WIRE CHANGE. `RunEvent.ContextInfo` already carries
// `thresholdSource` and drops it when null — pinned on the Java side by
// ContextInfoThresholdSourceAdditivityTest, which asserts both that the key
// rides ("window") and that a pre-263 line replays with the field absent. The
// web reader simply never declared it, so every consumer had to guess whether
// a threshold was measured or invented. These tests hold the reader to the
// same additivity contract: the value arrives when it is there, and its
// absence stays an absence rather than becoming a made-up default.

import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer";
import type { RunEvent } from "../events";

const info = (extra: Partial<Record<string, unknown>> = {}): RunEvent =>
  ({
    type: "context_info",
    agentId: "main",
    turn: 3,
    messages: 12,
    estimatedTokens: 8100,
    threshold: 153216,
    parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
    ts: 9,
    ...extra,
  }) as RunEvent;

describe("context_info carries where its threshold came from (card 300)", () => {
  it("the snapshot keeps the provenance the frame stated", () => {
    const state = reduce(initialState, info({ thresholdSource: "window" }));
    expect(state.context?.thresholdSource).toBe("window");
    expect(state.context?.threshold).toBe(153216);
  });

  it("an explicit setting reads as an override, not as a window", () => {
    const state = reduce(initialState, info({ thresholdSource: "override", threshold: 5000 }));
    expect(state.context?.thresholdSource).toBe("override");
  });

  it("a harness that learned nothing says so", () => {
    const state = reduce(initialState, info({ thresholdSource: "fallback", threshold: 100000 }));
    expect(state.context?.thresholdSource).toBe("fallback");
  });

  it("a pre-263 line states no provenance and may not invent one", () => {
    const state = reduce(initialState, info());
    expect(state.context?.thresholdSource).toBeUndefined();
    // and the absence is an ABSENCE — not a key holding undefined, which would
    // survive JSON.stringify as nothing but survives `in` as something.
    expect("thresholdSource" in (state.context as object)).toBe(false);
    expect(state.context?.threshold).toBe(153216);
  });
});
