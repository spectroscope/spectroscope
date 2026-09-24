// Card 386: what a keystroke in a number field of the settings page may save.
//
// Every number field saved `Number(e.target.value)` on each change, and
// `Number("")` is 0. Clearing a field to retype it therefore saved a zero, and
// for the shell time limit a zero meant every command of the next session
// timed out at once. The rule below is the one the fields now share.

import { describe, expect, it } from "vitest";
import { floorOf, numberFieldPatch } from "./serverSettings";

describe("numberFieldPatch", () => {
  it("sends nothing for an empty field", () => {
    expect(numberFieldPatch("commandTimeoutSeconds", "", 1)).toBeNull();
    expect(numberFieldPatch("commandTimeoutSeconds", "   ", 1)).toBeNull();
  });

  it("sends nothing for an empty field whose zero is legal", () => {
    // The empty string is not a zero the operator typed, even where zero is
    // allowed. Without this case a check that only compared against the floor
    // would pass every other test here.
    expect(numberFieldPatch("questionsPerRun", "", 0)).toBeNull();
  });

  it("sends nothing below the floor", () => {
    expect(numberFieldPatch("commandTimeoutSeconds", "0", 1)).toBeNull();
    expect(numberFieldPatch("dockMaxWidth", "259", 260)).toBeNull();
    expect(numberFieldPatch("questionsPerRun", "-1", 0)).toBeNull();
  });

  it("sends nothing that is not a whole number", () => {
    expect(numberFieldPatch("maxTurns", "1.5", 1)).toBeNull();
    expect(numberFieldPatch("maxTurns", "abc", 1)).toBeNull();
  });

  it("sends the number at or above the floor, under its own key", () => {
    expect(numberFieldPatch("commandTimeoutSeconds", "1", 1)).toEqual({ commandTimeoutSeconds: 1 });
    expect(numberFieldPatch("commandTimeoutSeconds", "900", 1)).toEqual({ commandTimeoutSeconds: 900 });
    expect(numberFieldPatch("dockMaxWidth", "260", 260)).toEqual({ dockMaxWidth: 260 });
  });

  it("sends a zero the operator typed where zero is legal", () => {
    // The card's third scenario.
    expect(numberFieldPatch("questionsPerRun", "0", 0)).toEqual({ questionsPerRun: 0 });
  });

  it("leaves the range to the server when the view carries no floor", () => {
    // An older server answers no floors. The empty field still sends nothing.
    expect(numberFieldPatch("maxTurns", "", undefined)).toBeNull();
    expect(numberFieldPatch("maxTurns", "0", undefined)).toEqual({ maxTurns: 0 });
  });
});

describe("floorOf", () => {
  it("reads the floor the server sent for the key", () => {
    const view = { floors: { dockMaxWidth: 260, questionsPerRun: 0 } } as never;
    expect(floorOf(view, "dockMaxWidth")).toBe(260);
    expect(floorOf(view, "questionsPerRun")).toBe(0);
  });

  it("answers undefined for a key or a view without one", () => {
    expect(floorOf({ floors: { dockMaxWidth: 260 } } as never, "maxTurns")).toBeUndefined();
    expect(floorOf({} as never, "maxTurns")).toBeUndefined();
  });
});
