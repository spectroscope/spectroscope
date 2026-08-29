// Card 305: the engine learns to carry a node bigger than its own cell.
//
// Card 302 taught it HEIGHT, in the horizontal orientation only. That was
// enough for a phase box that lists its agents beside a state graph. It is not
// enough for the lab map's workflow box, whose nodes are agent CARDS: a card is
// wider than the engine's 132-pixel cell, and the box reads as one block only
// when it runs VERTICALLY — which is the one path card 302 deliberately refused.
//
// So the override becomes a SIZE, both dimensions, both orientations. The three
// properties are bitten apart on purpose:
//   this file      — a stated size reaches the placed box
//   rankPitch      — the rank axis makes room for it
//   layoutIdentity — a caller that states nothing is where it always was
//
// The last of those is the one that lets the other two be changed at all.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type Topology } from "./layout";

/** One rank of three, so a stated size has neighbours to push. */
const FAN: Topology = {
  entry: "root",
  nodes: ["root", "a", "b", "c"].map((id) => ({ id, label: id })),
  edges: [
    { from: "root", to: "a", kind: "direct" },
    { from: "root", to: "b", kind: "direct" },
    { from: "root", to: "c", kind: "direct" },
  ],
};

const at = (l: ReturnType<typeof layoutStateGraph>, id: string) => l.nodes.find((n) => n.id === id)!;

describe("a stated node size", () => {
  it("carries a stated width to the placed box, horizontally", () => {
    // `w: NW` used to be unconditional in both orientations, so a card wider
    // than the cell had no way to say so and was drawn at the cell's width
    // with its own content hanging out of it.
    const l = layoutStateGraph({ ...FAN, sizes: new Map([["b", { w: 240 }]]) }, "horizontal");
    expect(at(l, "b").w).toBe(240);
    expect(at(l, "a").w).toBe(132);
  });

  it("carries a stated width to the placed box, vertically", () => {
    // Bitten apart from the horizontal case rather than looped over both: the
    // two orientations read the override on different axes, and a change that
    // wired up only one of them must fail exactly one of these two.
    const l = layoutStateGraph({ ...FAN, sizes: new Map([["b", { w: 240 }]]) }, "vertical");
    expect(at(l, "b").w).toBe(240);
    expect(at(l, "a").w).toBe(132);
  });

  it("carries a stated height to the placed box, horizontally", () => {
    const l = layoutStateGraph({ ...FAN, sizes: new Map([["b", { h: 140 }]]) }, "horizontal");
    expect(at(l, "b").h).toBe(140);
    expect(at(l, "a").h).toBe(46);
  });

  it("falls back to the engine's own cell for a dimension the caller left out", () => {
    // A producer that knows its width and not its height states one key. The
    // other must be the cell, not undefined and not NaN — a NaN width poisons
    // every bound and every edge path that reads off this box.
    const l = layoutStateGraph({ ...FAN, sizes: new Map([["b", { w: 240 }]]) }, "horizontal");
    expect(at(l, "b").h).toBe(46);
    const bounds = layoutStateGraph({ ...FAN, sizes: new Map([["b", { h: 140 }]]) }, "horizontal");
    expect(at(bounds, "b").w).toBe(132);
    for (const n of bounds.nodes) expect(Number.isFinite(n.x + n.y + n.w + n.h)).toBe(true);
  });

  it("keeps the older height-only spelling working", () => {
    // `heights` is card 302's field and the lab's workflow lens still writes
    // it. Generalising the override must not quietly drop the caller that
    // exists today in favour of the one that does not exist yet.
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 140]]) }, "horizontal");
    expect(at(l, "b").h).toBe(140);
  });

  it("lets the general spelling win where both name the same node", () => {
    // Both fields naming one node is a producer bug, but a silent 50/50 is
    // worse than a stated rule. `sizes` is the newer and more specific of the
    // two, so it wins, and this says so out loud.
    const l = layoutStateGraph(
      { ...FAN, heights: new Map([["b", 140]]), sizes: new Map([["b", { h: 200 }]]) },
      "horizontal",
    );
    expect(at(l, "b").h).toBe(200);
  });

  it("packs the column around a stated width in the vertical orientation", () => {
    // Vertical packs the CROSS axis by width, so a wide box must move its
    // neighbours sideways — the same thing card 302 did for height across the
    // horizontal cross axis. Measured against the STATED 240: a layout that
    // reported the width but spaced for the cell would clear its own fiction.
    const l = layoutStateGraph({ ...FAN, sizes: new Map([["b", { w: 240 }]]) }, "vertical");
    const b = at(l, "b");
    const c = at(l, "c");
    expect(c.x).toBeGreaterThanOrEqual(b.x + 240);
  });
});

/** Three ranks of mixed sizes: one box far bigger than the cell, one middling,
 *  one SMALLER than the cell, and three that state nothing. The small one is
 *  there on purpose — an override that only ever grows a box is a different
 *  piece of arithmetic from one that also shrinks it. */
const MIXED: Topology = {
  entry: "root",
  nodes: ["root", "a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id })),
  edges: [
    { from: "root", to: "a", kind: "direct" },
    { from: "root", to: "b", kind: "direct" },
    { from: "root", to: "c", kind: "direct" },
    { from: "a", to: "d", kind: "direct" },
    { from: "b", to: "e", kind: "direct" },
    { from: "c", to: "f", kind: "direct" },
  ],
  ranks: new Map([
    ["root", 0],
    ["a", 1],
    ["b", 1],
    ["c", 1],
    ["d", 2],
    ["e", 2],
    ["f", 2],
  ]),
  sizes: new Map([
    ["a", { w: 260, h: 180 }],
    ["e", { w: 200, h: 120 }],
    ["root", { w: 90, h: 30 }],
  ]),
};

/** No two boxes may share a pixel. Takes the layout rather than making it, so
 *  the two orientations below stay two separate cases. */
const expectNoOverlap = (l: ReturnType<typeof layoutStateGraph>) => {
  for (let i = 0; i < l.nodes.length; i++) {
    for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i];
      const b = l.nodes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
};

describe("boxes of stated sizes still never overlap", () => {
  // The invariant `layout.test.ts` holds over the uniform engine, carried onto
  // the case the uniform engine could not produce. Two cases, not one loop:
  // breaking one orientation's arithmetic must turn exactly one of them red,
  // and that has been checked by doing it rather than by believing it.
  it("horizontally", () => {
    expectNoOverlap(layoutStateGraph(MIXED, "horizontal"));
  });

  it("vertically", () => {
    expectNoOverlap(layoutStateGraph(MIXED, "vertical"));
  });

  it("keeps every box inside the reported bounds, horizontally", () => {
    // The bounds are what the viewport fits to. A box outside them is a box
    // the reader has to find by scrolling into blank space.
    const l = layoutStateGraph(MIXED, "horizontal");
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(l.bounds.x0);
      expect(n.y).toBeGreaterThanOrEqual(l.bounds.y0);
      expect(n.x + n.w).toBeLessThanOrEqual(l.bounds.x1);
      expect(n.y + n.h).toBeLessThanOrEqual(l.bounds.y1);
    }
  });

  it("keeps every box inside the reported bounds, vertically", () => {
    const l = layoutStateGraph(MIXED, "vertical");
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(l.bounds.x0);
      expect(n.y).toBeGreaterThanOrEqual(l.bounds.y0);
      expect(n.x + n.w).toBeLessThanOrEqual(l.bounds.x1);
      expect(n.y + n.h).toBeLessThanOrEqual(l.bounds.y1);
    }
  });
});
