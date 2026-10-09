import { describe, expect, it } from "vitest";
import { UNDO_DEPTH, canRedo, canUndo, push, redo, startHistory, undo } from "./history";

describe("the command stack", () => {
  it("undoes twenty commands back to the start and redoes them", () => {
    let h = startHistory(0);
    for (let i = 1; i <= 20; i++) h = push(h, i);
    for (let i = 0; i < 20; i++) h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    for (let i = 0; i < 20; i++) h = redo(h);
    expect(h.present).toBe(20);
  });

  it("keeps at most UNDO_DEPTH entries and drops the oldest", () => {
    let h = startHistory(0);
    for (let i = 1; i <= UNDO_DEPTH + 5; i++) h = push(h, i);
    expect(h.past.length).toBe(UNDO_DEPTH);
    while (canUndo(h)) h = undo(h);
    expect(h.present).toBe(5);
  });

  it("clears the future on a new command", () => {
    let h = push(push(startHistory("a"), "b"), "c");
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = push(h, "d");
    expect(canRedo(h)).toBe(false);
    expect(h.past).toEqual(["a", "b"]);
  });

  it("records nothing for a refused command", () => {
    const h = startHistory({ n: 1 });
    expect(push(h, h.present)).toBe(h);
  });

  it("returns the same object when there is nothing to undo or redo", () => {
    const h = startHistory("a");
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
    expect(canRedo(h)).toBe(false);
  });
});
