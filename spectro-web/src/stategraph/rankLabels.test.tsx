// The rank labels: layout.ts:62 has promised "the renderer draws one labelled
// column per rank" since the file was written, and until this suite nobody
// delivered. The label positions are the template's own numbers
// (graphview.html:1295-1299): horizontal at (first.x, MARGIN-12), vertical at
// (MARGIN-22, first.y-8), where `first` is the rank's node nearest the axis.
//
// The overlay lives inside a ViewportPortal, which a server render leaves
// empty (measured: the probe markup carried cards but no sg-arcs), so the
// overlay is its own exported component and is rendered here directly.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutStateGraph, type Topology } from "./layout";
import { CanvasOverlay } from "./StateGraphView";
import { readStateGraphRun } from "./artifact";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");

/** A three-rank chain whose coordinates are hand-computable: NW 132, NH 46,
 *  MARGIN 40, gap along 58 (horizontal) / 46 (vertical). */
const CHAIN: Topology = {
  entry: "a",
  nodes: [
    { id: "a", label: "a" },
    { id: "b", label: "b" },
    { id: "c", label: "c" },
  ],
  edges: [
    { from: "a", to: "b", kind: "direct" },
    { from: "b", to: "c", kind: "direct" },
  ],
};

describe("layout hands the renderer one label per rank", () => {
  it("places horizontal labels at the template's (first.x, MARGIN-12)", () => {
    const laid = layoutStateGraph(CHAIN, "horizontal");
    expect(laid.rankLabels).toEqual([
      { rank: 0, x: 40, y: 28, maxWidth: 180 },
      { rank: 1, x: 230, y: 28, maxWidth: 180 },
      { rank: 2, x: 420, y: 28, maxWidth: 180 },
    ]);
  });

  it("places vertical labels at the template's (MARGIN-22, first.y-8)", () => {
    const laid = layoutStateGraph(CHAIN, "vertical");
    expect(laid.rankLabels).toEqual([
      { rank: 0, x: 18, y: 32, maxWidth: 144 },
      { rank: 1, x: 18, y: 124, maxWidth: 144 },
      { rank: 2, x: 18, y: 216, maxWidth: 144 },
    ]);
  });

  it("anchors a label to the rank's node nearest the axis", () => {
    // Two nodes share rank 1; the label rides the one with the smaller y.
    const fork: Topology = {
      entry: "a",
      nodes: [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
        { id: "c", label: "c" },
      ],
      edges: [
        { from: "a", to: "b", kind: "direct" },
        { from: "a", to: "c", kind: "direct" },
      ],
    };
    const laid = layoutStateGraph(fork, "horizontal");
    const rank1 = laid.nodes.filter((n) => n.rank === 1);
    const nearest = Math.min(...rank1.map((n) => n.y));
    expect(laid.rankLabels.find((l) => l.rank === 1)?.x).toBe(rank1[0].x);
    expect(rank1.some((n) => n.y === nearest)).toBe(true);
  });
});

describe("the overlay draws every rank label, in both orientations", () => {
  const run = readStateGraphRun(GRAPH, null);

  for (const orientation of ["horizontal", "vertical"] as const) {
    it(`renders rank 0..maxRank ${orientation}ly`, () => {
      const laid = layoutStateGraph(run.topology, orientation);
      const html = renderToStaticMarkup(<CanvasOverlay laid={laid} />);
      expect(laid.maxRank).toBeGreaterThan(0);
      for (let r = 0; r <= laid.maxRank; r++) {
        expect(html).toContain(`rank ${r}`);
      }
      expect(html).toContain("sg-ranklabel");
      // The arcs stayed: the overlay grew a layer, it did not swap one.
      expect(html).toContain("sg-arc");
    });
  }
});
