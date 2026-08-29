// Card 305, the second gap: the ALONG-axis pitch was a constant.
//
// The cross axis has been packed from real sizes since card 302, but the rank
// axis stepped by `NW + gapAlong` / `NH + gapAlong` no matter what stood in the
// rank. So NEITHER orientation reacted to a node growing along that axis. A
// tall box in horizontal was safe only by luck — it grows across the packed
// axis — and a wide one had nowhere to grow at all.
//
// The rule that replaces the constant: a rank is as long as its LONGEST box,
// plus the gap. Two things have to be true of it at once, and they are bitten
// apart below. A graph whose boxes are all the engine's own cell must land on
// the exact coordinates the constant produced. And an oversized box must push
// the ranks AFTER it without disturbing the ranks before it — a pitch that
// re-centred the whole run would move the state graph on every artifact that
// happens to contain one big node.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type Topology } from "./layout";

/** Four ranks in a line, so a box in the middle has ranks on both sides of it
 *  to leave alone or to push. */
const CHAIN: Topology = {
  entry: "r0",
  nodes: ["r0", "r1", "r2", "r3"].map((id) => ({ id, label: id })),
  edges: [
    { from: "r0", to: "r1", kind: "direct" },
    { from: "r1", to: "r2", kind: "direct" },
    { from: "r2", to: "r3", kind: "direct" },
  ],
};

const at = (l: ReturnType<typeof layoutStateGraph>, id: string) => l.nodes.find((n) => n.id === id)!;

/** The engine's own numbers, spelled out so a failure reads as arithmetic
 *  rather than as four unexplained integers. */
const NW = 132;
const NH = 46;
const MARGIN = 40;
const GAP_ALONG_H = 58;
const GAP_ALONG_V = 46;

describe("the rank pitch follows the rank's longest box", () => {
  it("keeps the constant pitch for a graph whose boxes are all the engine's cell", () => {
    // The equality the whole change rests on: max(NW) + gapAlong IS
    // NW + gapAlong when every box is a cell. Written as the arithmetic, not
    // as a comparison against another call, so it cannot pass by both sides
    // drifting together.
    const l = layoutStateGraph(CHAIN, "horizontal");
    expect(at(l, "r0").x).toBe(MARGIN);
    expect(at(l, "r1").x).toBe(MARGIN + (NW + GAP_ALONG_H));
    expect(at(l, "r2").x).toBe(MARGIN + 2 * (NW + GAP_ALONG_H));
    expect(at(l, "r3").x).toBe(MARGIN + 3 * (NW + GAP_ALONG_H));
  });

  it("makes room after a rank holding a box wider than the cell", () => {
    const l = layoutStateGraph({ ...CHAIN, sizes: new Map([["r2", { w: 300 }]]) }, "horizontal");
    // Measured against the STATED 300, not against the reported w: a layout
    // that carried the width into the box but not into the pitch would still
    // report 300 while drawing r3 straight through it.
    expect(at(l, "r3").x).toBe(at(l, "r2").x + 300 + GAP_ALONG_H);
  });

  it("leaves the ranks BEFORE the oversized one exactly where they were", () => {
    // The other half, and the half that protects the state graph: a pitch that
    // pushed in both directions, or re-centred the run, would move a picture
    // nobody asked to move. r2's own start must not shift either.
    const plain = layoutStateGraph(CHAIN, "horizontal");
    const wide = layoutStateGraph({ ...CHAIN, sizes: new Map([["r2", { w: 300 }]]) }, "horizontal");
    for (const id of ["r0", "r1", "r2"]) expect(at(wide, id).x).toBe(at(plain, id).x);
  });

  it("takes the widest box in a rank, not the first or the last one", () => {
    // A rank is a column of several. The one that decides the pitch is the
    // longest, wherever it sits in the ordering — reading the first would be
    // green on half the orderings and wrong on the other half.
    const fan: Topology = {
      entry: "root",
      nodes: ["root", "a", "b", "c", "tail"].map((id) => ({ id, label: id })),
      edges: [
        { from: "root", to: "a", kind: "direct" },
        { from: "root", to: "b", kind: "direct" },
        { from: "root", to: "c", kind: "direct" },
        { from: "b", to: "tail", kind: "direct" },
      ],
    };
    const l = layoutStateGraph({ ...fan, sizes: new Map([["b", { w: 300 }]]) }, "horizontal");
    expect(at(l, "tail").x).toBe(at(l, "b").x + 300 + GAP_ALONG_H);
    // …and the neighbours in that rank keep the cell width they never stated.
    expect(at(l, "a").w).toBe(NW);
  });

  it("gives a rank nothing landed in the width of one cell", () => {
    // Rank overrides can leave a gap: the caller names ranks 0 and 2 and
    // nothing sits at 1. The old constant stepped over it by one cell, and it
    // still must, or a supplied-rank picture would close up under this change.
    const gapped: Topology = {
      entry: "root",
      nodes: ["root", "far"].map((id) => ({ id, label: id })),
      edges: [{ from: "root", to: "far", kind: "direct" }],
      ranks: new Map([
        ["root", 0],
        ["far", 2],
      ]),
    };
    const l = layoutStateGraph(gapped, "horizontal");
    expect(at(l, "far").x).toBe(MARGIN + 2 * (NW + GAP_ALONG_H));
  });

  it("never lets a box reach into the next rank's column", () => {
    // The invariant the pitch exists for, stated over the whole field rather
    // than over one pair: no box may start before the previous rank's longest
    // box has ended.
    const l = layoutStateGraph(
      {
        ...CHAIN,
        sizes: new Map([
          ["r1", { w: 400 }],
          ["r2", { w: 300 }],
        ]),
      },
      "horizontal",
    );
    for (const a of l.nodes) {
      for (const b of l.nodes) {
        if (b.rank !== a.rank + 1) continue;
        expect(b.x, `${a.id} reaches into ${b.id}`).toBeGreaterThanOrEqual(a.x + a.w);
      }
    }
  });
});

// The vertical twin, written out rather than looped over both orientations.
// Two orientations that share one parameterised body pass together on a change
// that only ever wired up one of them, which is the failure this whole card is
// about: the along axis was a constant on BOTH paths and nobody noticed,
// because every size-sensitive case in the suite ran horizontal.
describe("the rank pitch follows the rank's longest box, vertically", () => {
  it("keeps the constant pitch for a graph whose boxes are all the engine's cell", () => {
    const l = layoutStateGraph(CHAIN, "vertical");
    expect(at(l, "r0").y).toBe(MARGIN);
    expect(at(l, "r1").y).toBe(MARGIN + (NH + GAP_ALONG_V));
    expect(at(l, "r2").y).toBe(MARGIN + 2 * (NH + GAP_ALONG_V));
    expect(at(l, "r3").y).toBe(MARGIN + 3 * (NH + GAP_ALONG_V));
  });

  it("makes room after a rank holding a box taller than the cell", () => {
    // Vertical's along dimension is HEIGHT, which is the dimension card 302
    // refused here. Measured against the stated 200, so a layout that reported
    // the height without spacing for it clears only its own fiction.
    const l = layoutStateGraph({ ...CHAIN, sizes: new Map([["r2", { h: 200 }]]) }, "vertical");
    expect(at(l, "r2").h).toBe(200);
    expect(at(l, "r3").y).toBe(at(l, "r2").y + 200 + GAP_ALONG_V);
  });

  it("leaves the ranks ABOVE the oversized one exactly where they were", () => {
    const plain = layoutStateGraph(CHAIN, "vertical");
    const tall = layoutStateGraph({ ...CHAIN, sizes: new Map([["r2", { h: 200 }]]) }, "vertical");
    for (const id of ["r0", "r1", "r2"]) expect(at(tall, id).y).toBe(at(plain, id).y);
  });

  it("never lets a box reach into the next rank's row", () => {
    const l = layoutStateGraph(
      {
        ...CHAIN,
        sizes: new Map([
          ["r1", { h: 300 }],
          ["r2", { h: 200 }],
        ]),
      },
      "vertical",
    );
    for (const a of l.nodes) {
      for (const b of l.nodes) {
        if (b.rank !== a.rank + 1) continue;
        expect(b.y, `${a.id} reaches into ${b.id}`).toBeGreaterThanOrEqual(a.y + a.h);
      }
    }
  });

  it("keeps the width override working on the packed axis while it does so", () => {
    // Both dimensions at once on one path, because the vertical box this card
    // is for states both: the width packs the row, the height sets the pitch,
    // and a change that read one map key into both axes would show up here.
    const l = layoutStateGraph({ ...CHAIN, sizes: new Map([["r2", { w: 240, h: 200 }]]) }, "vertical");
    expect(at(l, "r2").w).toBe(240);
    expect(at(l, "r2").h).toBe(200);
    expect(at(l, "r3").y).toBe(at(l, "r2").y + 200 + GAP_ALONG_V);
  });
});
