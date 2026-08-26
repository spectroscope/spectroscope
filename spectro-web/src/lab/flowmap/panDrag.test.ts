import { describe, expect, it } from "vitest";
import { panMove, panStart } from "./panDrag";

describe("panDrag (card 287: a drag on a card pans the view)", () => {
  it("only the right button starts a drag", () => {
    expect(panStart(0, 5, 5)).toBeNull();
    expect(panStart(1, 5, 5)).toBeNull();
    expect(panStart(2, 5, 5)).toEqual({ x: 5, y: 5 });
  });

  it("moves report the delta and advance the anchor", () => {
    const r = panMove({ x: 5, y: 5 }, 2, 9, 7);
    expect(r).toEqual({ dx: 4, dy: 2, next: { x: 9, y: 7 } });
  });

  it("a move without the right button ends the drag with NO delta — the release-over-chrome case", () => {
    expect(panMove({ x: 5, y: 5 }, 0, 90, 70)).toEqual({ dx: 0, dy: 0, next: null });
  });

  it("no drag, no delta", () => {
    expect(panMove(null, 2, 9, 7)).toEqual({ dx: 0, dy: 0, next: null });
  });
});
