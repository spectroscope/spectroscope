// What a session's glyph says, and how a row spells itself out.
//
// The second fold this file used to cover — which rows are so alike that
// showing all of them is noise — is gone with the pile (owner, 2026-08-12).
// The list is flat, so there is nothing left to group.
import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../events";
import { countLabel, sessionSignal, sessionModelLabel, sessionTitleLines } from "./sessionRows";

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
    // Card 264, fix pass: this glyph is a reader the card's AC 3 never named. It
    // needs no change — the fall-through already reads an unfamiliar reason as a
    // cut — but "indifferent by construction" is a claim about behaviour, and an
    // abandoned run showing the clean glyph in the sidebar is the exact failure
    // the card exists to end.
    expect(sessionSignal(session({ stopReason: "unfinished" })).outcome).toBe("cut");
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
