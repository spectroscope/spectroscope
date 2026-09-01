import { describe, it, expect } from "vitest";
import {
  clampSplitPct,
  readStoredSplit,
  splitPctFromPointer,
  DEFAULT_SPLIT,
  MIN_SPLIT,
  MAX_SPLIT,
} from "./wsSplit";

describe("clampSplitPct", () => {
  it("keeps a value inside the range untouched", () => {
    expect(clampSplitPct(50)).toBe(50);
  });
  it("clamps below the minimum", () => {
    expect(clampSplitPct(2)).toBe(MIN_SPLIT);
  });
  it("clamps above the maximum", () => {
    expect(clampSplitPct(99)).toBe(MAX_SPLIT);
  });
});

describe("readStoredSplit", () => {
  it("falls back to the default when nothing is stored", () => {
    expect(readStoredSplit(null)).toBe(DEFAULT_SPLIT);
  });
  it("falls back to the default for junk", () => {
    expect(readStoredSplit("nope")).toBe(DEFAULT_SPLIT);
  });
  it("falls back to the default when out of range", () => {
    expect(readStoredSplit("5")).toBe(DEFAULT_SPLIT);
    expect(readStoredSplit("95")).toBe(DEFAULT_SPLIT);
  });
  it("keeps a valid stored value", () => {
    expect(readStoredSplit("55")).toBe(55);
  });
});

// ---- Card 362, criterion 5: the two divider defects found while measuring ----
//
// Neither was reported and both are real. They are arithmetic, so they are
// pinned as arithmetic: this suite has no layout engine, and the card's own
// pixel budget rested on an explicitly UNMEASURED `.ws-head` height of 22px.
// Nothing below depends on that number — the cases hand over a container height
// and a tree top and check the relation between them, which is the property
// that was wrong.

describe("the divider lands where the pointer is (card 362)", () => {
  // The geometry: `.ws` is a column flex container holding `.ws-head`, the
  // tree, the divider and the preview, with a gap between each pair. The tree's
  // rendered height is `flex-basis: split%`, and a percentage basis resolves
  // against the CONTAINER's inner height — head and gaps included. The old
  // measurement divided by the distance from the TREE's top to the container's
  // bottom, which is that inner height minus the head and one gap, so every
  // drag asked for a bigger share than the pointer had moved to.
  const INNER = 600; // .ws's own inner height
  const HEAD_AND_GAP = 30; // whatever stands above the tree — never assumed, passed in
  const TREE_TOP = 100; // where .ws-tree starts on screen
  const WS_TOP = TREE_TOP - HEAD_AND_GAP;

  it("asks for the share that puts the tree's bottom edge under the pointer", () => {
    // Pointer 240px below the container's top: the tree should end there, so
    // its height is 240 - 30 = 210 of the 600 the basis resolves against.
    expect(splitPctFromPointer(WS_TOP + 240, TREE_TOP, INNER)).toBeCloseTo((210 / 600) * 100, 6);
  });

  it("the old arithmetic asked for a larger share than the pointer had moved to", () => {
    // The defect, stated as the arithmetic it was: dividing by the distance
    // from the tree's top to the container's bottom (600 - 30 = 570).
    const wrong = ((240 - HEAD_AND_GAP) / (INNER - HEAD_AND_GAP)) * 100;
    const right = splitPctFromPointer(WS_TOP + 240, TREE_TOP, INNER);
    expect(right).not.toBeNull();
    expect(wrong).toBeGreaterThan(right as number);
  });

  it("clamps into the usable band rather than collapsing a pane", () => {
    expect(splitPctFromPointer(TREE_TOP - 500, TREE_TOP, INNER)).toBe(MIN_SPLIT);
    expect(splitPctFromPointer(TREE_TOP + 5000, TREE_TOP, INNER)).toBe(MAX_SPLIT);
  });

  it("a container with no measurable height changes nothing", () => {
    // A hidden pane renders no frame and every rect is zero (the canon's
    // hidden-window trap). A drag must not divide by it.
    expect(splitPctFromPointer(300, 100, 0)).toBeNull();
    expect(splitPctFromPointer(300, 100, Number.NaN)).toBeNull();
  });
});
