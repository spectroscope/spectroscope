// The sidebar list's two folds: what a session's glyph says, and which rows
// are so alike that showing all of them is noise.
import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../events";
import {
  countLabel,
  groupSessions,
  sessionSignal,
  sessionModelLabel,
  sessionTitleLines,
} from "./sessionRows";

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: over.id ?? "20260727-120000-aaaaaaaa",
    startedAt: 1_000,
    firstPrompt: "report your pid",
    tokens: 7,
    agentCount: 1,
    turnCount: 1,
    stopReason: "end_turn",
    ...over,
  };
}

describe("sessionSignal", () => {
  it("draws one bar per agent, the main agent heaviest", () => {
    const single = sessionSignal(session({ agentCount: 1 }));
    expect(single.bars).toHaveLength(1);
    expect(single.bars[0].token).toBe("var(--agent-root)");

    const fanOut = sessionSignal(session({ agentCount: 4 }));
    expect(fanOut.bars).toHaveLength(4);
    expect(fanOut.bars[0].width).toBeGreaterThan(fanOut.bars[1].width);
    expect(fanOut.bars[1].token).not.toBe(fanOut.bars[0].token);
  });

  it("caps the comb and counts the overflow instead of drawing mush", () => {
    const wide = sessionSignal(session({ agentCount: 12 }));
    expect(wide.bars).toHaveLength(5);
    expect(wide.more).toBe(7);
  });

  it("treats a session with no agent count as the single run it is", () => {
    const legacy = sessionSignal(session({ agentCount: undefined }));
    expect(legacy.bars).toHaveLength(1);
    expect(legacy.more).toBe(0);
  });

  it("folds the recorded stop reason into how the run finished", () => {
    expect(sessionSignal(session({ stopReason: "end_turn" })).outcome).toBe("clean");
    expect(sessionSignal(session({ stopReason: "error" })).outcome).toBe("failed");
    expect(sessionSignal(session({ stopReason: "aborted" })).outcome).toBe("cut");
    expect(sessionSignal(session({ stopReason: "max_turns" })).outcome).toBe("cut");
    expect(sessionSignal(session({ stopReason: "max_tokens" })).outcome).toBe("cut");
  });

  it("says open when no run_end closed the file, and never guesses clean", () => {
    expect(sessionSignal(session({ stopReason: undefined })).outcome).toBe("open");
    expect(sessionSignal(session({ stopReason: null })).outcome).toBe("open");
    // A reason this edition does not know is still not a plain finish.
    expect(sessionSignal(session({ stopReason: "tool_use" })).outcome).toBe("cut");
  });

  it("marks the gate, and marks a refusal harder than a wave-through", () => {
    const none = sessionSignal(session({ gateCount: 0, denyCount: 0 }));
    expect(none.gate).toBe("none");
    const allowed = sessionSignal(session({ gateCount: 3, denyCount: 0 }));
    expect(allowed.gate).toBe("asked");
    const refused = sessionSignal(session({ gateCount: 3, denyCount: 1 }));
    expect(refused.gate).toBe("denied");
  });
});

describe("sessionModelLabel", () => {
  it("names the model, falling back to the provider that ran it", () => {
    expect(sessionModelLabel(session({ model: "claude-sonnet-5", provider: "anthropic" }))).toBe(
      "claude-sonnet-5",
    );
    expect(sessionModelLabel(session({ model: undefined, provider: "ollama" }))).toBe("ollama");
  });

  it("shows nothing rather than the store's placeholder dash", () => {
    expect(sessionModelLabel(session({ model: undefined, provider: "-" }))).toBe("");
    expect(sessionModelLabel(session({ model: undefined, provider: undefined }))).toBe("");
  });
});

describe("countLabel", () => {
  it("counts one of a thing in the singular, in both languages", () => {
    expect(countLabel("en", "turn", 1)).toBe("1 turn");
    expect(countLabel("en", "turn", 11)).toBe("11 turns");
    expect(countLabel("de", "turn", 1)).toBe("1 Turn");
    expect(countLabel("de", "turn", 11)).toBe("11 Turns");
    expect(countLabel("en", "agent", 1)).toBe("1 agent");
    expect(countLabel("de", "agent", 4)).toBe("4 Agenten");
  });

  it("takes the plural from the count and the text from the display form", () => {
    // The row abbreviates 34000 to "34.0k", which is no longer a number the
    // plural rule can be read off. Zero is plural in both languages.
    expect(countLabel("en", "token", 34_000, "34.0k")).toBe("34.0k tokens");
    expect(countLabel("en", "token", 1, "1")).toBe("1 token");
    expect(countLabel("en", "token", 0, "0")).toBe("0 tokens");
    expect(countLabel("de", "token", 0, "0")).toBe("0 Tokens");
  });
});

describe("sessionTitleLines", () => {
  it("spells out every channel the glyph draws", () => {
    const text = sessionTitleLines(
      session({
        firstPrompt: "fan out",
        provider: "anthropic",
        model: "claude-sonnet-5",
        agentCount: 4,
        turnCount: 11,
        tokens: 34000,
        gateCount: 3,
        denyCount: 1,
        stopReason: "error",
        startedAt: 1_000,
        endedAt: 6_000,
      }),
      "en",
      100_000,
    );
    expect(text).toContain("fan out");
    expect(text).toContain("anthropic · claude-sonnet-5");
    expect(text).toContain("ended in an error");
    expect(text).toContain("refused 1×");
    expect(text).toContain("4 agents");
    expect(text).toContain("11 turns");
    expect(text).toContain("ran for 5.0 s");
  });

  it("never says one turns", () => {
    const text = sessionTitleLines(session({ turnCount: 1, tokens: 1 }), "en", 100_000);
    expect(text).toContain("1 turn ");
    expect(text).toContain("1 token");
    expect(text).not.toContain("1 turns");
    expect(text).not.toContain("1 tokens");
  });

  it("leaves out what the file never recorded", () => {
    const text = sessionTitleLines(
      session({ model: undefined, provider: "-", gateCount: 0, endedAt: undefined }),
      "en",
      100_000,
    );
    expect(text).not.toContain("gate:");
    expect(text).not.toContain("ran for");
    expect(text).toContain("finished cleanly");
  });

  it("does not date a run that has no recorded end", () => {
    const text = sessionTitleLines(
      session({ startedAt: 1_000, endedAt: 1_000, stopReason: undefined }),
      "en",
      100_000,
    );
    expect(text).not.toContain("ran for");
    expect(text).toContain("no run_end recorded");
  });

  it("speaks German too", () => {
    const text = sessionTitleLines(session({ stopReason: "aborted" }), "de", 100_000);
    expect(text).toContain("vorzeitig gestoppt (aborted)");
  });
});

describe("groupSessions", () => {
  const throwaway = (id: string, startedAt: number): SessionMeta =>
    session({ id, startedAt, firstPrompt: "report your pid" });

  it("leaves a list of distinct sessions alone", () => {
    const groups = groupSessions([
      session({ id: "a", firstPrompt: "one" }),
      session({ id: "b", firstPrompt: "two" }),
      session({ id: "c", firstPrompt: "three" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.sessions.length === 1)).toBe(true);
  });

  it("collapses a run of indistinguishable sessions into one group", () => {
    const groups = groupSessions([
      throwaway("a", 5),
      throwaway("b", 4),
      throwaway("c", 3),
      throwaway("d", 2),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves a pair alone — two rows are not yet noise", () => {
    const groups = groupSessions([throwaway("a", 5), throwaway("b", 4)]);
    expect(groups).toHaveLength(2);
  });

  it("lets a session that differs in SHAPE out of the group", () => {
    // Same prompt ten times, but one of them fanned out. That one is the
    // session a reader is looking for, so it must not hide inside the pile.
    const groups = groupSessions([
      throwaway("a", 9),
      throwaway("b", 8),
      throwaway("c", 7),
      session({ id: "fan", startedAt: 6, firstPrompt: "report your pid", agentCount: 4 }),
      throwaway("d", 5),
      throwaway("e", 4),
      throwaway("f", 3),
    ]);
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([
      ["a", "b", "c"],
      ["fan"],
      ["d", "e", "f"],
    ]);
  });

  it("keeps an errored run out of a pile of clean ones", () => {
    const groups = groupSessions([
      throwaway("a", 5),
      throwaway("b", 4),
      throwaway("c", 3),
      session({ id: "bad", startedAt: 2, firstPrompt: "report your pid", stopReason: "error" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["bad"]);
  });

  it("keeps a gated run out of a pile of ungated ones", () => {
    const groups = groupSessions([
      throwaway("a", 5),
      throwaway("b", 4),
      throwaway("c", 3),
      session({ id: "gated", startedAt: 2, firstPrompt: "report your pid", gateCount: 1 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1].sessions[0].id).toBe("gated");
  });

  it("never groups across different prompts", () => {
    const groups = groupSessions([
      throwaway("a", 6),
      throwaway("b", 5),
      throwaway("c", 4),
      session({ id: "x", startedAt: 3, firstPrompt: "something else" }),
      session({ id: "y", startedAt: 2, firstPrompt: "something else" }),
      session({ id: "z", startedAt: 1, firstPrompt: "something else" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions[0].firstPrompt).toBe("report your pid");
    expect(groups[1].sessions[0].firstPrompt).toBe("something else");
  });

  it("gives every group a key that survives a refresh", () => {
    const first = groupSessions([throwaway("a", 5), throwaway("b", 4), throwaway("c", 3)]);
    const again = groupSessions([throwaway("a", 5), throwaway("b", 4), throwaway("c", 3)]);
    expect(first[0].key).toBe(again[0].key);
    // A key is the group's own, not a neighbour's.
    const mixed = groupSessions([
      throwaway("a", 5),
      throwaway("b", 4),
      throwaway("c", 3),
      session({ id: "x", startedAt: 2, firstPrompt: "other" }),
    ]);
    expect(new Set(mixed.map((g) => g.key)).size).toBe(mixed.length);
  });

  it("survives an empty list", () => {
    expect(groupSessions([])).toEqual([]);
  });
});
