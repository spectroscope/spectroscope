// Card 504, last fix round 2026-10-12: the state behind useRecordedMode. A
// fetch answers for the session it was asked for; a choice made in the gear
// stands over a fetch that answers later; a live session (null) shows none.

import { describe, expect, it } from "vitest";
import { recordedChosen, recordedFound, shownRecorded } from "./recordedMode";

describe("the recorded mode of a stored session", () => {
  it("shows what the fetch found for this session", () => {
    expect(shownRecorded(recordedFound(null, "s1", "auto"), "s1")).toBe("auto");
  });

  it("shows nothing while loading, for a live session, or for an answer about another session", () => {
    expect(shownRecorded(null, "s1")).toBeNull();
    expect(shownRecorded(recordedFound(null, "s1", "auto"), null)).toBeNull();
    expect(shownRecorded(recordedFound(null, "s1", "auto"), "s2")).toBeNull();
  });

  it("shows a choice at once, and a fetch that answers later does not undo it", () => {
    const chosen = recordedChosen("s1", "readonly");
    expect(shownRecorded(chosen, "s1")).toBe("readonly");
    expect(shownRecorded(recordedFound(chosen, "s1", "auto"), "s1")).toBe("readonly");
  });

  it("takes a fetch for another session over a choice made on the one before", () => {
    const chosen = recordedChosen("s1", "readonly");
    expect(shownRecorded(recordedFound(chosen, "s2", "auto"), "s2")).toBe("auto");
  });
});
