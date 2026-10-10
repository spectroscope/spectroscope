// Card 471: what a /clear leaves in the chat and in the ring.
//
// The server answers clear_context with a context_cleared event. The chat
// draws a divider that says "context cleared" with the time, and the ring
// stops counting the conversation that went: the next prompt starts empty, so
// the gauge must not keep showing the old fill until that prompt's usage
// arrives.
//
// Review round: the ring stays on screen. Until the next answer measures again
// it reads what the clear kept, the system prompt and the tool schemas, as the
// last snapshot estimated them. A gauge at zero hid itself, and with it the
// window override in its popover.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, type UiState } from "./reducer";
import { buildTextFeed, feedToPlainText } from "./textFeed";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerMeta } from "../components/ComposerMeta";

const cleared = (removedMessages: number, ts = 1_760_000_000_000): RunEvent =>
  ({ type: "context_cleared", agentId: "main", removedMessages, ts }) as RunEvent;

/** A state after one answered run, with the ring and the snapshot filled. */
function afterARun(): UiState {
  let state = reduce(initialState, {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "remember 7",
    ts: 1,
  } as RunEvent);
  state = reduce(state, {
    type: "context_info",
    agentId: "main",
    turn: 1,
    messages: 40,
    estimatedTokens: 9_000,
    threshold: 100_000,
    parts: [
      { label: "system prompt", chars: 4_000, estTokens: 1_000, text: "s" },
      { label: "tool schemas", chars: 8_000, estTokens: 2_000, text: "t" },
      { label: "conversation", chars: 24_000, estTokens: 6_000, text: "c" },
    ],
    ts: 2,
  } as RunEvent);
  state = reduce(state, { type: "text_delta", agentId: "main", text: "ok", ts: 3 } as RunEvent);
  state = reduce(state, {
    type: "usage",
    agentId: "main",
    inputTokens: 9_100,
    outputTokens: 5,
    ts: 4,
  } as RunEvent);
  return reduce(state, { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 5 } as RunEvent);
}

describe("a context_cleared event in the chat", () => {
  it("draws a divider that says context cleared and carries the time", () => {
    const state = reduce(afterARun(), cleared(40, 1_760_000_123_000));

    const last = state.turns[state.turns.length - 1];
    expect(last.kind).toBe("info");
    if (last.kind !== "info") return;
    expect(last.divider).toBe(true);
    expect(last.infoKey).toBe("chat.contextCleared");
    expect(last.ts).toBe(1_760_000_123_000);
    expect(last.text).toBe("context cleared");
  });

  it("keeps every turn before it on screen", () => {
    const before = afterARun();
    const state = reduce(before, cleared(40));

    expect(state.turns.slice(0, before.turns.length)).toEqual(before.turns);
    expect(state.turns.length).toBe(before.turns.length + 1);
  });
});

describe("a context_cleared event in the ring", () => {
  it("premise: the run filled the ring", () => {
    const state = afterARun();
    expect(state.lastInputTokens).toBe(9_100);
    expect(state.context?.estimatedTokens).toBe(9_000);
  });

  it("reads what the clear kept, the system prompt and the tools, until the next answer measures", () => {
    const state = reduce(afterARun(), cleared(40));

    expect(state.lastInputTokens).toBe(3_000);
  });

  it("stays on screen under the composer and reads near zero", () => {
    const state = reduce(afterARun(), cleared(40));
    const html = renderToStaticMarkup(
      createElement(ComposerMeta, {
        provider: "ollama",
        model: "qwen3",
        status: "open",
        onApplyProvider: () => {},
        liveView: true,
        lastInputTokens: state.lastInputTokens,
        aiCredits: state.aiCredits,
        context: state.context,
        onWindowOverride: () => {},
      }),
    );

    expect(html, "the ring is drawn").toContain("context-wrap");
    const pct = Number(/aria-label="Context (\d+) percent full/.exec(html)?.[1]);
    expect(pct, "3,000 of a 100,000 threshold").toBe(3);
  });

  it("drops the conversation from the snapshot and keeps what stays", () => {
    const state = reduce(afterARun(), cleared(40));

    expect(state.context).not.toBeNull();
    expect(state.context?.messages).toBe(0);
    expect(state.context?.estimatedTokens).toBe(3_000);
    expect(state.context?.threshold).toBe(100_000);
    const parts = state.context?.parts ?? [];
    expect(parts.find((p) => p.label === "system prompt")?.estTokens).toBe(1_000);
    expect(parts.find((p) => p.label === "tool schemas")?.estTokens).toBe(2_000);
    expect(parts.find((p) => p.label === "conversation")).toEqual({
      label: "conversation",
      chars: 0,
      estTokens: 0,
      text: "",
    });
  });

  // Round three (owner decision 1): the ring never disappears after a clear.
  // A ring that was drawn stays drawn, also when there is no snapshot to
  // estimate from or the snapshot held nothing but the conversation.
  it("stays drawn when the ring was drawn and no snapshot came to estimate from", () => {
    let state = reduce(initialState, {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "go",
      ts: 1,
    } as RunEvent);
    state = reduce(state, {
      type: "usage",
      agentId: "main",
      inputTokens: 4_000,
      outputTokens: 5,
      ts: 2,
    } as RunEvent);
    state = reduce(state, { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 } as RunEvent);
    expect(state.context, "premise: no snapshot").toBeNull();
    expect(state.lastInputTokens, "premise: the ring was drawn").toBe(4_000);

    const after = reduce(state, cleared(2));

    expect(after.lastInputTokens).toBeGreaterThan(0);
    expect(after.lastInputTokens, "near zero, not the old fill").toBeLessThan(4_000);
  });

  it("stays drawn when the snapshot held nothing but the conversation", () => {
    let state = afterARun();
    state = reduce(state, {
      type: "context_info",
      agentId: "main",
      turn: 2,
      messages: 4,
      estimatedTokens: 500,
      threshold: 100_000,
      parts: [{ label: "conversation", chars: 2_000, estTokens: 500, text: "c" }],
      ts: 6,
    } as RunEvent);

    const after = reduce(state, cleared(4));

    expect(after.lastInputTokens).toBeGreaterThan(0);
  });

  it("leaves a state that never measured anything as it was", () => {
    const state = reduce(initialState, cleared(0));

    expect(state.context).toBeNull();
    expect(state.lastInputTokens).toBe(0);
  });
});

describe("a context_cleared event in the text feed", () => {
  it("is a marker line, never the model's words", () => {
    const feed = buildTextFeed([cleared(40)]);
    expect(feed.map((segment) => segment.kind)).toEqual(["marker"]);
    expect(feedToPlainText(feed)).toBe("[context_cleared 40 messages]");
  });
});
