// Card 305, step 6: is this function safe to call N times and offset?
//
// The eventual need is several workflow boxes on one lab canvas — a JSON can
// hold five workflows. That box is a LATER card and nothing here builds it.
// What this file does is answer the question that card would otherwise have to
// answer by guessing, and answer it by measurement: what does `layoutStateGraph`
// actually guarantee to a caller that wants to run it once per box and place
// the results side by side?
//
// Four things are confirmed below and two caveats are found. The caveats are
// the point — a green "yes it is pure" would have hidden both.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type Topology } from "./layout";

/** DECLARED BACK TO FRONT on purpose. The in-rank ordering sorts by discovery,
 *  so a topology already written in discovery order would be sorted into the
 *  order it was already in — and the mutation check below would pass against a
 *  layout that sorts the caller's own array in place. Measured: with the nodes
 *  declared `start, one, two, done` that check stayed green while the function
 *  sorted `topo.nodes` directly. Reversed, it goes red. */
const A: Topology = {
  entry: "start",
  nodes: ["done", "two", "one", "start"].map((id) => ({ id, label: id })),
  edges: [
    { from: "start", to: "one", kind: "direct" },
    { from: "one", to: "two", kind: "direct" },
    { from: "two", to: "done", kind: "direct" },
    { from: "two", to: "one", kind: "conditional" },
  ],
  rankCaptions: new Map([[1, { title: "Survey", detail: "two probes" }]]),
  sizes: new Map([["one", { w: 240, h: 120 }]]),
};

/** A second, different topology that happens to reuse the SAME node ids — the
 *  ordinary case for two workflows out of one file, both with a `start`. */
const B: Topology = {
  entry: "start",
  nodes: ["start", "one", "done"].map((id) => ({ id, label: id })),
  edges: [
    { from: "start", to: "one", kind: "spawn" },
    { from: "one", to: "done", kind: "spawn" },
  ],
};

describe("calling the layout once per box", () => {
  it("returns the same answer however many other layouts run between the two calls", () => {
    // No module-level accumulator, no counter, no memo: the lane indices and
    // the pair-seen map are rebuilt per call. Interleaved on purpose — two
    // calls back to back would not catch state that another topology dirties.
    const first = layoutStateGraph(A, "vertical");
    layoutStateGraph(B, "vertical");
    layoutStateGraph(B, "horizontal");
    layoutStateGraph(A, "horizontal");
    const second = layoutStateGraph(A, "vertical");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not write into the topology it was handed", () => {
    // A caller holding one topology per box must be able to lay it out twice.
    // The in-rank ordering sorts arrays — this is the case that proves it
    // sorts copies and not the caller's own `nodes`.
    //
    // ITS OWN TOPOLOGY, not the shared A, and that is not tidiness. Measured:
    // with the shared object this case stayed green against a layout that
    // sorted `topo.nodes` in place, because the case above had already run and
    // sorted it — the second sort was then a no-op. A mutation check sharing
    // its subject with an earlier case is checking nothing.
    const own: Topology = {
      entry: "start",
      nodes: ["done", "two", "one", "start"].map((id) => ({ id, label: id })),
      edges: [
        { from: "start", to: "one", kind: "direct" },
        { from: "one", to: "two", kind: "direct" },
        { from: "two", to: "done", kind: "direct" },
      ],
      sizes: new Map([["one", { w: 240, h: 120 }]]),
    };
    const snapshot = () => JSON.stringify({ nodes: own.nodes, edges: own.edges, sizes: [...own.sizes!] });
    const before = snapshot();
    layoutStateGraph(own, "horizontal");
    layoutStateGraph(own, "vertical");
    expect(snapshot()).toBe(before);
  });

  it("hands each call its own objects, so offsetting one cannot move another", () => {
    // If the caller offsets by mutating, shared node objects between two calls
    // would move both boxes. They are fresh per call.
    const one = layoutStateGraph(A, "horizontal");
    const two = layoutStateGraph(A, "horizontal");
    expect(one.nodes[0]).not.toBe(two.nodes[0]);
    one.nodes[0].x += 1000;
    expect(two.nodes[0].x).toBe(layoutStateGraph(A, "horizontal").nodes[0].x);
  });

  it("emits only ABSOLUTE path commands, so one group transform moves a whole box", () => {
    // The finding that decides HOW a caller offsets. Every path is absolute
    // and lives in the same space as the boxes, so an SVG group transform per
    // box moves boxes, edges and labels together and stays exact. Adding a dx
    // into the path strings would mean re-parsing geometry this file already
    // got right — and a lowercase command would make that parse wrong.
    for (const o of ["horizontal", "vertical"] as const) {
      for (const e of layoutStateGraph(A, o).edges) {
        expect(e.path, `${o} ${e.id}`).not.toMatch(/[mlcqhvsta]/);
        expect(e.path, `${o} ${e.id}`).toMatch(/^M[-\d.]+,[-\d.]+/);
      }
    }
  });
});

describe("what a caller placing several boxes still has to do itself", () => {
  it("collides node and edge ids across two boxes, so the caller must namespace them", () => {
    // Not a defect — the ids ARE the topology's own, which is what every
    // existing caller wants. It does mean two boxes out of one file hand React
    // Flow duplicate keys, and a duplicate key silently drops an element
    // rather than complaining. Namespace before the ids reach React Flow.
    const one = layoutStateGraph(A, "vertical");
    const two = layoutStateGraph(B, "vertical");
    const shared = one.nodes.filter((n) => two.nodes.some((m) => m.id === n.id));
    expect(shared.map((n) => n.id)).toContain("start");
    expect(one.edges.some((e) => two.edges.some((f) => f.id === e.id))).toBe(true);
  });

  it("draws rank rules far past its own bounds, so the caller must clip them", () => {
    // The ruled field runs 4000px each way ON PURPOSE — that is what makes the
    // slack around a wide, short graph read as ruled space rather than as
    // emptiness. On a shared canvas it means box A's rules run straight across
    // box B. Translating is not enough; the rules need clipping to their box.
    const l = layoutStateGraph(A, "vertical");
    const worst = Math.max(...l.rankRules.map((r) => Math.max(Math.abs(r.x1), Math.abs(r.x2))));
    expect(worst).toBeGreaterThan(l.bounds.x1 - l.bounds.x0);
  });

  it("keeps every box within the bounds it reports, which is what a caller offsets by", () => {
    // The bounds are the box's own extent. A caller stacking boxes steps by
    // these, so anything outside them would land on its neighbour.
    for (const o of ["horizontal", "vertical"] as const) {
      const l = layoutStateGraph(A, o);
      for (const n of l.nodes) {
        expect(n.x).toBeGreaterThanOrEqual(l.bounds.x0);
        expect(n.y).toBeGreaterThanOrEqual(l.bounds.y0);
        expect(n.x + n.w).toBeLessThanOrEqual(l.bounds.x1);
        expect(n.y + n.h).toBeLessThanOrEqual(l.bounds.y1);
      }
    }
  });
});
