// Card 504, hub and spoke review round 2: the web twin of the Java cut. A text
// cut at a fixed number of UTF-16 units ends in half of a surrogate pair when
// an emoji stands across the cap. The page then draws a broken character, and
// JSON.stringify prints the half as the six characters \ud83d.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { pairSafeCut } from "../pairSafeCut";
import { summarize } from "../components/TraceView";
import { summarize as labSummarize } from "../lab/LabTrace";
import { initialState, reduce, type Turn, type UiState } from "./reducer";

/** A high half with no low half after it, or a low half with no high half before it. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = "\u{1F600}";

/** A text whose emoji starts on the last unit a cut at `cap` keeps. */
const across = (cap: number): string => `${"x".repeat(cap - 1)}${EMOJI} and more`;

function messages(state: UiState): Extract<Turn, { kind: "message" }>[] {
  return state.turns.filter((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message");
}

describe("pairSafeCut", () => {
  it("keeps one unit fewer when the last kept unit is the high half of a pair", () => {
    const cut = pairSafeCut(across(200), 200);
    expect(cut).toBe("x".repeat(199));
    expect(LONE.test(cut)).toBe(false);
  });

  it("keeps the whole pair when the cap falls after it", () => {
    expect(pairSafeCut(across(200), 201)).toBe(`${"x".repeat(199)}${EMOJI}`);
  });

  it("cuts text without pairs exactly at the cap, and leaves a short text whole", () => {
    expect(pairSafeCut("abcdef", 3)).toBe("abc");
    expect(pairSafeCut("abc", 3)).toBe("abc");
    expect(pairSafeCut("abc", 10)).toBe("abc");
    expect(pairSafeCut("abc", 0)).toBe("");
  });

  it("positive: the plain cut it replaces does split the pair", () => {
    expect(LONE.test(across(200).slice(0, 200))).toBe(true);
  });
});

describe("the message paths cut without splitting a pair", () => {
  it("the summary of a peer frame without its own summary", () => {
    const state = reduce(initialState, {
      type: "peer_message",
      kind: "message",
      direction: "received",
      msgId: "m1",
      name: "Other-01",
      from: "Other-01",
      text: across(200),
      ts: 1,
    } as unknown as RunEvent);
    const [turn] = messages(state);
    expect(turn?.summary).toBe("x".repeat(199));
    expect(LONE.test(turn?.summary ?? "\uD83D")).toBe(false);
  });

  it("the summary of an agent_message record with role peer", () => {
    const state = reduce(initialState, {
      type: "agent_message",
      from: "Other-01",
      to: "main",
      role: "peer",
      state: "delivered",
      text: across(200),
      label: "m2",
      ts: 1,
    });
    const [turn] = messages(state);
    expect(turn?.summary).toBe("x".repeat(199));
    expect(LONE.test(turn?.summary ?? "\uD83D")).toBe(false);
  });

  it("the trace row of an agent_message", () => {
    const line = summarize(
      {
        seq: 1,
        dir: "in",
        ts: 0,
        type: "agent_message",
        payload: { from: "a", to: "b", state: "sent", text: across(60) },
      },
      "en",
    );
    expect(line).toContain(JSON.stringify("x".repeat(59)));
    expect(line).not.toMatch(/\\ud83d/i);
    expect(LONE.test(line)).toBe(false);
  });

  it("the Lab trace row of an agent_message", () => {
    const line = labSummarize({
      type: "agent_message",
      from: "a",
      to: "b",
      role: "peer",
      state: "sent",
      text: across(40),
      ts: 0,
    });
    expect(line).toContain(JSON.stringify("x".repeat(39)));
    expect(line).not.toMatch(/\\ud83d/i);
    expect(LONE.test(line)).toBe(false);
  });
});
