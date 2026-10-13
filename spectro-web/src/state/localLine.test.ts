// Card 554: a command answered on the page itself (/help, /playbook list)
// leaves no frame; its answer is one info turn in the chat, added to the
// session's state and to nothing else.

import { describe, expect, it } from "vitest";
import { foldLocalLine, initialState } from "./reducer";

describe("foldLocalLine", () => {
  it("adds one neutral info turn with the text as written, line breaks and all", () => {
    const next = foldLocalLine(initialState, "Commands you can type here\nChat\n/help: List");
    expect(next.turns).toEqual([
      { kind: "info", text: "Commands you can type here\nChat\n/help: List", tone: "neutral" },
    ]);
  });

  it("leaves the trace alone: nothing went over the wire", () => {
    const next = foldLocalLine(initialState, "x");
    expect(next.trace).toBe(initialState.trace);
    expect(next.running).toBe(false);
  });

  it("adds nothing for an empty text", () => {
    expect(foldLocalLine(initialState, "  ")).toBe(initialState);
  });

  // Card 554, task 13: a refusal is a warn line, and /playbook show carries
  // the folder its link opens on the Steps tab.
  it("carries a warn tone and the folder a link opens, when asked", () => {
    expect(foldLocalLine(initialState, "No playbook is named x.", { tone: "warn" }).turns).toEqual([
      { kind: "info", text: "No playbook is named x.", tone: "warn" },
    ]);
    expect(foldLocalLine(initialState, "Playbook spectro", { openPlaybook: "/pb/spectro" }).turns).toEqual([
      { kind: "info", text: "Playbook spectro", tone: "neutral", openPlaybook: "/pb/spectro" },
    ]);
  });
});
