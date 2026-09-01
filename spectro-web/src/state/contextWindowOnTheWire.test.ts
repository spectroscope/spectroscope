// Card 366, AC 6: the window the harness measured against reaches the reader.
//
// WHY THIS IS NOT A WIRE CHANGE EITHER. `RunEvent.ContextInfo` carries
// `contextWindow` and drops it when null — pinned on the Java side by
// ContextInfoWindowAdditivityTest, which asserts both that the key rides and
// that a pre-366 line replays with the field absent. These tests hold the web
// reader to the same contract, and they are the reason the gauge may finally
// say what its denominator is a share OF: before this, the web answered that
// question from a hand-typed vendor prefix table that returned null for every
// local model, so the line never rendered on the backend the owner tests with.

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
    threshold: 175257,
    parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
    ts: 9,
    ...extra,
  }) as RunEvent;

describe("context_info carries the window it measured against (card 366)", () => {
  it("the snapshot keeps the window the frame stated", () => {
    // The owner's own loaded instance: 250,368, and 70 % of it is the threshold.
    const state = reduce(initialState, info({ contextWindow: 250368, thresholdSource: "window" }));
    expect(state.context?.contextWindow).toBe(250368);
    expect(state.context?.threshold).toBe(175257);
  });

  it("a cloud run carries the published window and the fourth provenance", () => {
    const state = reduce(
      initialState,
      info({ threshold: 700000, contextWindow: 1000000, thresholdSource: "model" }),
    );
    expect(state.context?.thresholdSource).toBe("model");
    expect(state.context?.contextWindow).toBe(1000000);
  });

  it("a pre-366 line states no window and may not invent one", () => {
    const state = reduce(initialState, info({ thresholdSource: "window" }));
    expect(state.context?.contextWindow).toBeUndefined();
    // and the absence is an ABSENCE — not a key holding undefined, which would
    // survive JSON.stringify as nothing but survives `in` as something.
    expect("contextWindow" in (state.context as object)).toBe(false);
    expect(state.context?.threshold).toBe(175257);
  });
});
