// Card 390: the server's answer to a set or a clear moves the ring at once.
//
// The answer is a `window_override` event carrying the threshold, source and
// window that follow from the operator's choice. The reverted first build had
// no answer at all (review 2026-09-24, E5), so the ring could only move on the
// next run's first context_info, and the owner wrote "ich kann was eingeben und
// dann passiert nichts".

import { describe, expect, it } from "vitest";
import { initialState, reduce, type UiState } from "./reducer";
import type { RunEvent } from "../events";

const info = (extra: Partial<Record<string, unknown>> = {}): RunEvent =>
  ({
    type: "context_info",
    agentId: "main",
    turn: 3,
    messages: 12,
    estimatedTokens: 8100,
    threshold: 143_001,
    thresholdSource: "window",
    contextWindow: 204_288,
    parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
    ts: 9,
    ...extra,
  }) as RunEvent;

const answer = (extra: Partial<Record<string, unknown>>): RunEvent =>
  ({ type: "window_override", ts: 10, ...extra }) as RunEvent;

const SET = answer({
  tokens: 512_000,
  threshold: 358_400,
  thresholdSource: "window_override",
  contextWindow: 512_000,
});

describe("the answer to a set moves the ring without a run (card 390)", () => {
  it("the snapshot takes the new threshold, source and window", () => {
    const state = reduce(reduce(initialState, info()), SET);
    expect(state.context?.threshold).toBe(358_400);
    expect(state.context?.thresholdSource).toBe("window_override");
    expect(state.context?.contextWindow).toBe(512_000);
  });

  it("and keeps what only a run can measure", () => {
    const before = reduce(initialState, info());
    const after = reduce(before, SET);
    expect(after.context?.turn).toBe(3);
    expect(after.context?.messages).toBe(12);
    expect(after.context?.estimatedTokens).toBe(8100);
    expect(after.context?.parts).toEqual(before.context?.parts);
  });

  it("a clear hands back to the automatic source and drops a window it no longer knows", () => {
    const set = reduce(reduce(initialState, info()), SET);
    const cleared = reduce(set, answer({ threshold: 100_000, thresholdSource: "fallback" }));
    expect(cleared.context?.threshold).toBe(100_000);
    expect(cleared.context?.thresholdSource).toBe("fallback");
    expect("contextWindow" in (cleared.context as object)).toBe(false);
  });

  it("invents no snapshot where no run has measured one", () => {
    // Before the first context_info there is nothing to show under a ring that
    // is not rendered yet; a made-up snapshot would claim a turn and a message
    // count nobody measured.
    const state: UiState = reduce(initialState, SET);
    expect(state.context).toBeNull();
  });

  it("the next context_info of a run is the word after it, as before", () => {
    const state = reduce(
      reduce(reduce(initialState, info()), SET),
      info({ turn: 4, threshold: 358_400, thresholdSource: "window_override", contextWindow: 512_000 }),
    );
    expect(state.context?.turn).toBe(4);
    expect(state.context?.thresholdSource).toBe("window_override");
  });
});
