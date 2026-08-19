import { describe, expect, it } from "vitest";
import { CLEAN_FINISHES } from "./stopReason";
import { initialState, reduce } from "./reducer";
import { sessionSignal } from "../components/sessionRows";

// Card 282: the transcript and the session list read "did this run finish?"
// from one definition.
//
// They were about to disagree, and the disagreement was this card's own doing.
// The transcript learned that goal_met is a finish; sessionRows.outcomeOf still
// carried the literal it was written with, back when end_turn was the only
// finish there was — card 267 added goal_met and nothing pointed at that line.
// A run that MET its goal would have drawn no transcript line and a "cut" dot
// in the same session.
describe("one definition of a finished run", () => {
  const rowOutcome = (stopReason: string) => sessionSignal({ id: "s", stopReason } as never).outcome;

  const drewALine = (stopReason: string) =>
    reduce(initialState, { type: "run_end", runId: "r", stopReason, ts: 1 }).turns.length > 0;

  it.each([...CLEAN_FINISHES])("%s is clean in both readings", (reason) => {
    expect(rowOutcome(reason), `${reason} draws the cut dot`).toBe("clean");
    expect(drewALine(reason), `${reason} drew a "the run has ended" line`).toBe(false);
  });

  it.each(["max_turns", "no_progress", "unfinished_after_continuations", "goal_unmet", "a_new_one"])(
    "%s is a cut in both readings",
    (reason) => {
      expect(rowOutcome(reason), `${reason} draws the clean dot`).not.toBe("clean");
      expect(drewALine(reason), `${reason} drew no line`).toBe(true);
    },
  );

  it("still tells a failure apart from a cut", () => {
    // The row has a third state and it is not covered by the set above.
    expect(rowOutcome("error")).toBe("failed");
  });
});
