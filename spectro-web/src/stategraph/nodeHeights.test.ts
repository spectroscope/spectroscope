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

  it("ignores a stated height in the vertical orientation rather than half-honouring it", () => {
    // Vertical runs the ranks down the height axis. Reporting a tall box
    // while spacing for a short one is exactly the overlap the override is
    // there to prevent, so vertical refuses the whole override instead.
    const l = layoutStateGraph({ ...FAN, heights: new Map([["b", 140]]) }, "vertical");
    expect(at(l, "b").h).toBe(46);
    expect(l.nodes).toEqual(layoutStateGraph(FAN, "vertical").nodes);
  });
});
