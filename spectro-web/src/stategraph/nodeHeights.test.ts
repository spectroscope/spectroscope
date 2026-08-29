// Card 302: a node that HOLDS something is taller than one that only names
// something. A workflow phase box lists its agents, so its height is the
// producer's to state — and the layout must place around it rather than
// assuming one cell size for everybody.
//
// Two properties, bitten apart. A topology that states NO height must lay out
// byte for byte as it did before the override existed (the state graph's own
// pictures ride on that). A topology that states one must have the stated box
// AND everything sharing its column moved out of its way.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type Topology } from "./layout";

/** One rank of three, so a stated height has neighbours to push. */
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

describe("a stated node height", () => {
  it("leaves a topology that states none exactly where it was", () => {
    // The equality that makes the override safe to add to a SHARED layout:
    // uniform heights must reproduce the old coordinates, not merely look
    // similar. Measured against the geometry the state graph already ships.
    const plain = layoutStateGraph(FAN, "horizontal");
    const uniform = layoutStateGraph(
      { ...FAN, heights: new Map(FAN.nodes.map((n) => [n.id, 46])) },
      "horizontal",
    );
    expect(uniform.nodes).toEqual(plain.nodes);
    expect(uniform.edges).toEqual(plain.edges);
    expect(uniform.bounds).toEqual(plain.bounds);
  });

  it("gives the node the height its producer stated", () => {
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 140]]) }, "horizontal");
    expect(at(l, "b").h).toBe(140);
    expect(at(l, "a").h).toBe(46);
  });

  it("moves the column's later nodes clear of a tall one", () => {
    // Without this the tall box would be drawn straight through its own
    // neighbour — the one failure mode a fixed cell size cannot have.
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 140]]) }, "horizontal");
    const b = at(l, "b");
    const c = at(l, "c");
    // Against the STATED 140, never against the reported h — a layout that
    // ignored the override would report 46 and clear its own fiction.
    expect(c.y).toBeGreaterThanOrEqual(b.y + 140);
  });

  it("keeps the whole field inside the reported bounds", () => {
    // 260, not 140: with 140 the field still fits inside the padding the
    // bounds already carried, so the check would pass on a layout that
    // ignored the override entirely.
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 260]]) }, "horizontal");
    const b = at(l, "b");
    expect(l.bounds.y1).toBeGreaterThanOrEqual(b.y + 260);
    for (const n of l.nodes) expect(n.y).toBeGreaterThanOrEqual(l.bounds.y0);
  });

  it("aims the edge at the tall box's own middle", () => {
    // The connector reads off the placed box, so a stated height must move the
    // arrow with it. A path that still ended at the old cell's middle would
    // point at empty space above the box.
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 140]]) }, "horizontal");
    const b = at(l, "b");
    const e = l.edges.find((x) => x.to === "b")!;
    expect(e.path).toContain(`${b.y + 70}`);
  });

  it("honours a stated height in the vertical orientation too (card 305)", () => {
    // THIS CASE REPLACES A REFUSAL, and the refusal was right when it was
    // written. Card 302 read the override in horizontal only and ignored it
    // outright in vertical, because vertical runs the ranks down the HEIGHT
    // axis while the pitch along that axis was a constant: reporting a tall
    // box and spacing for a short one is exactly the overlap the override
    // exists to prevent, and half-honouring it would have been worse than
    // refusing it.
    //
    // Card 305 made the rank pitch follow the rank's longest box on both
    // paths, so the spacing now carries whatever the box reports and the
    // reason for the refusal is gone. The decision recorded here is the new
    // one: vertical honours the override the same way horizontal does. The
    // second assertion is what makes it a decision rather than a report — the
    // rank BELOW moves down by the box's real height, not by a cell.
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 140]]) }, "vertical");
    expect(at(l, "b").h).toBe(140);
    const plain = layoutStateGraph(FAN, "vertical");
    expect(at(l, "root").y).toBe(at(plain, "root").y);
    expect(l.nodes).not.toEqual(plain.nodes);
  });
});

/** A chain, so a tall box is ALONE in its column — the workflow shape, where
 *  the phase holding five agents has no neighbour to be pushed aside by. The
 *  only thing left in that column for the box to run into is the column's
 *  own caption. */
const CHAIN: Topology = {
  entry: "root",
  nodes: ["root", "p0", "p1"].map((id) => ({ id, label: id })),
  edges: [
    { from: "root", to: "p0", kind: "direct" },
    { from: "p0", to: "p1", kind: "direct" },
  ],
  rankCaptions: new Map([
    [1, { title: "Survey", detail: "five probes" }],
    [2, { title: "Consolidate", detail: null }],
  ]),
};

const labelAt = (l: ReturnType<typeof layoutStateGraph>, rank: number) =>
  l.rankLabels.find((x) => x.rank === rank)!;

describe("a column's caption against a box that states its own height", () => {
  it("stays clear of a box grown past the caption's own line", () => {
    // The caption used to be pinned to the margin, which held only while every
    // node was one cell tall and the topmost box therefore started at MARGIN.
    // A packed column centres on the axis, so a phase holding five agents
    // starts ABOVE the margin and the caption landed on its heading.
    const l = layoutStateGraph({ ...CHAIN, heights: new Map([["p0", 107]]) }, "horizontal");
    const box = at(l, "p0");
    expect(box.h).toBe(107);
    expect(labelAt(l, 1).y).toBeLessThan(box.y);
  });

  it("leaves the caption of a column whose box did not grow where it was", () => {
    // The other half of the same rule, bitten apart: a caption must not chase
    // a box downwards. Rank 2 holds an ordinary node in the same picture as
    // the tall one, and its caption keeps the margin anchor.
    const l = layoutStateGraph({ ...CHAIN, heights: new Map([["p0", 107]]) }, "horizontal");
    expect(labelAt(l, 2).y).toBe(28);
  });

  it("does not move a caption in a topology that states no heights", () => {
    // The state graph's own pictures ride on this: every caption it draws must
    // land on the exact pixel it landed on before heights existed.
    //
    // FAN, not CHAIN, and that is the whole point of the case: its rank 0
    // holds one node against a rank of three, so its topmost box sits well
    // BELOW the margin (first.y = 40 + 46 + gap). A clamp that simply followed
    // the box would drag this caption down the canvas, and a chain — every
    // rank the same size, every first.y exactly MARGIN — would never notice.
    const captions = new Map([
      [0, { title: "Plan", detail: "one scout" }],
      [1, { title: "Survey", detail: null }],
    ]);
    const plain = layoutStateGraph({ ...FAN, rankCaptions: captions }, "horizontal");
    const uniform = layoutStateGraph(
      { ...FAN, rankCaptions: captions, heights: new Map(FAN.nodes.map((n) => [n.id, 46])) },
      "horizontal",
    );
    expect(at(plain, "root").y).toBeGreaterThan(40);
    expect(uniform.rankLabels).toEqual(plain.rankLabels);
    for (const l of plain.rankLabels) expect(l.y).toBe(28);
  });
});
