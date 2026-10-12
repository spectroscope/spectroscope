// Card 527 criterion 4: when the first words of a recording appear, the focus
// moves to Send, so Enter sends; someone who types during the recording keeps
// the focus where it is.

import { describe, expect, it } from "vitest";
import { FOCUS_START, focusStep, type FocusRule } from "./voiceFocus";

function run(...events: Parameters<typeof focusStep>[1][]): { rule: FocusRule; moves: number } {
  let rule = FOCUS_START;
  let moves = 0;
  for (const event of events) {
    const step = focusStep(rule, event);
    rule = step.rule;
    if (step.moveNow) moves++;
  }
  return { rule, moves };
}

describe("the focus follows the first recognised words", () => {
  it("moves to Send when the first text of a recording appears", () => {
    const step = focusStep(focusStep(FOCUS_START, { kind: "start" }).rule, { kind: "heard", text: "hello" });
    expect(step.moveNow).toBe(true);
  });

  it("moves once per recording, not on every new word", () => {
    expect(
      run(
        { kind: "start" },
        { kind: "heard", text: "hello" },
        { kind: "heard", text: "hello there" },
        { kind: "heard", text: "hello there you" },
      ).moves,
    ).toBe(1);
  });

  it("does not move before anything was heard", () => {
    expect(run({ kind: "start" }, { kind: "heard", text: "" }).moves).toBe(0);
  });

  it("a key typed in the message box during the recording keeps the focus there", () => {
    expect(run({ kind: "start" }, { kind: "typed" }, { kind: "heard", text: "hello" }).moves).toBe(0);
  });

  it("the next recording moves the focus again", () => {
    expect(
      run(
        { kind: "start" },
        { kind: "heard", text: "one" },
        { kind: "start" },
        { kind: "typed" },
        { kind: "start" },
        { kind: "heard", text: "two" },
      ).moves,
    ).toBe(2);
  });

  it("text heard outside a recording moves nothing", () => {
    expect(run({ kind: "heard", text: "hello" }).moves).toBe(0);
  });
});
