// The layout the state graph needs, and the one dagre cannot give it.
//
// A StateGraph is a CYCLIC graph whose loops are the point: a corrective RAG
// run goes grade → rewrite → router → retrieve and round again, and that loop
// is the single most interesting thing on the canvas. dagre breaks cycles by
// REVERSING an edge, which draws `rewrite → router` as `router → rewrite` and
// silently tells the reader the opposite of what happened. So the cycle edges
// are MARKED here and drawn as returning arcs — never turned around.
//
// The algorithm is ported from the measured template
// (docs/graph-view-reference/graphview.html), which is the agreed visual
// reference. Pure: no React, no DOM, no React Flow types.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type Topology } from "./layout";

/** The real CRAG topology, verbatim from the reference artifact's
 *  graph_topology record. Two cycles on purpose: rewrite→router and
 *  verify→generate. */
const CRAG: Topology = {
  entry: "__start__",
  nodes: [
    "__start__",
    "router",
    "retrieve",
    "rerank",
    "grade",
    "rewrite",
    "web",
    "generate",
    "verify",
    "__end__",
  ].map((id) => ({ id, label: id })),
  edges: [
    { from: "__start__", to: "router", kind: "direct" },
    { from: "retrieve", to: "rerank", kind: "direct" },
    { from: "rerank", to: "grade", kind: "direct" },
    { from: "rewrite", to: "router", kind: "direct" },
    { from: "web", to: "generate", kind: "direct" },
    { from: "generate", to: "verify", kind: "direct" },
    { from: "router", to: "retrieve", kind: "conditional" },
    { from: "router", to: "web", kind: "conditional" },
    { from: "router", to: "generate", kind: "conditional" },
    { from: "grade", to: "generate", kind: "conditional" },
    { from: "grade", to: "rewrite", kind: "conditional" },
    { from: "grade", to: "web", kind: "conditional" },
    { from: "verify", to: "generate", kind: "conditional" },
    { from: "verify", to: "__end__", kind: "conditional" },
  ],
};

const byId = (l: ReturnType<typeof layoutStateGraph>, id: string) => l.nodes.find((n) => n.id === id)!;
const edge = (l: ReturnType<typeof layoutStateGraph>, from: string, to: string) =>
  l.edges.find((e) => e.from === from && e.to === to)!;

describe("the cycle is kept, not broken", () => {
  it("marks a returning edge as back and leaves its direction alone", () => {
    // THE property. dagre would emit this edge as router→rewrite. If this test
    // ever passes with the endpoints swapped, the view is lying about the run.
    const l = layoutStateGraph(CRAG, "horizontal");
    const back = edge(l, "rewrite", "router");
    expect(back.back).toBe(true);
    expect(back.from).toBe("rewrite");
    expect(back.to).toBe("router");
  });

  it("finds every cycle in the real topology, and only those", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    const backs = l.edges
      .filter((e) => e.back)
      .map((e) => `${e.from}->${e.to}`)
      .sort();
    // Two loops: the rewrite loop back to the router, and verify's retry of
    // generate. Everything else flows forward.
    expect(backs).toEqual(["rewrite->router", "verify->generate"]);
  });

  it("treats a self loop as a returning edge rather than a rank step", () => {
    const l = layoutStateGraph(
      { entry: "a", nodes: [{ id: "a", label: "a" }], edges: [{ from: "a", to: "a", kind: "direct" }] },
      "horizontal",
    );
    expect(edge(l, "a", "a").back).toBe(true);
    expect(byId(l, "a").rank).toBe(0);
  });
});

describe("ranks", () => {
  it("puts every node on its longest forward path", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    expect(byId(l, "__start__").rank).toBe(0);
    expect(byId(l, "router").rank).toBe(1);
    expect(byId(l, "retrieve").rank).toBe(2);
    expect(byId(l, "rerank").rank).toBe(3);
    expect(byId(l, "grade").rank).toBe(4);
    // rewrite and web both hang off grade
    expect(byId(l, "rewrite").rank).toBe(5);
    expect(byId(l, "web").rank).toBe(5);
    // generate is reachable from router (rank 1) AND from web (rank 5) —
    // longest path wins, or the arrow into it would point backwards.
    expect(byId(l, "generate").rank).toBe(6);
    expect(byId(l, "verify").rank).toBe(7);
  });

  it("keeps __end__ in the last column whatever its longest path says", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    const maxRank = Math.max(...l.nodes.map((n) => n.rank));
    expect(byId(l, "__end__").rank).toBe(maxRank);
  });

  it("never lets a forward edge point backwards", () => {
    // The reason ranks exist at all. Every non-back edge must go left to right.
    const l = layoutStateGraph(CRAG, "horizontal");
    for (const e of l.edges) {
      if (e.back) continue;
      expect(byId(l, e.to).rank, `${e.from}->${e.to}`).toBeGreaterThan(byId(l, e.from).rank);
    }
  });
});

describe("placement", () => {
  it("never overlaps two boxes", () => {
    // One fixed cell per (rank, slot) is what makes this true by construction;
    // the test is here because "by construction" has been wrong before.
    const l = layoutStateGraph(CRAG, "horizontal");
    for (let i = 0; i < l.nodes.length; i++) {
      for (let j = i + 1; j < l.nodes.length; j++) {
        const a = l.nodes[i];
        const b = l.nodes[j];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("runs ranks along x when horizontal and along y when vertical", () => {
    const h = layoutStateGraph(CRAG, "horizontal");
    const v = layoutStateGraph(CRAG, "vertical");
    expect(byId(h, "router").x).toBeLessThan(byId(h, "grade").x);
    expect(byId(h, "router").y).not.toBe(Number.NaN);
    expect(byId(v, "router").y).toBeLessThan(byId(v, "grade").y);
  });

  it("is deterministic — the same topology lays out identically twice", () => {
    // A canvas that reshuffles on every render is unreadable, and a snapshot
    // test elsewhere would flap.
    expect(layoutStateGraph(CRAG, "horizontal")).toEqual(layoutStateGraph(CRAG, "horizontal"));
  });

  it("survives a node with no edges at all", () => {
    const l = layoutStateGraph(
      {
        entry: "a",
        nodes: [
          { id: "a", label: "a" },
          { id: "lonely", label: "lonely" },
        ],
        edges: [],
      },
      "horizontal",
    );
    expect(l.nodes).toHaveLength(2);
    expect(byId(l, "lonely").rank).toBe(0);
  });

  it("survives an edge naming a node that does not exist", () => {
    // Artifacts come off disk and can be truncated mid-write.
    const l = layoutStateGraph(
      { entry: "a", nodes: [{ id: "a", label: "a" }], edges: [{ from: "a", to: "ghost", kind: "direct" }] },
      "horizontal",
    );
    expect(l.nodes).toHaveLength(1);
    expect(l.edges.filter((e) => e.path !== "")).toHaveLength(0);
  });

  it("survives an empty topology", () => {
    const l = layoutStateGraph({ entry: null, nodes: [], edges: [] }, "horizontal");
    expect(l.nodes).toEqual([]);
    expect(l.edges).toEqual([]);
  });
});

describe("edge geometry", () => {
  it("gives every drawable edge a path that starts and ends on a box", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    for (const e of l.edges) {
      expect(e.path, `${e.from}->${e.to}`).toMatch(/^M[-\d.]+,[-\d.]+/);
    }
  });

  it("bows a returning edge clear of the node field", () => {
    // A back edge drawn straight would run through every box between its ends.
    // It belongs outside the field, which is what makes it read as a loop.
    const l = layoutStateGraph(CRAG, "horizontal");
    const back = edge(l, "rewrite", "router");
    const lowest = Math.max(...l.nodes.map((n) => n.y + n.h));
    const ys = [...back.path.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeGreaterThan(lowest);
  });

  it("keeps a rank-skipping edge out of the boxes it flies over", () => {
    // router→generate skips four ranks. Drawn straight it went through
    // retrieve, rerank and grade — the reference calls this out by name.
    const l = layoutStateGraph(CRAG, "horizontal");
    const skip = edge(l, "router", "generate");
    expect(skip.skip).toBe(true);
    const highest = Math.min(...l.nodes.map((n) => n.y));
    const ys = [...skip.path.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeLessThan(highest);
  });

  it("leaves a neighbouring-rank edge as a plain connector", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    const plain = edge(l, "retrieve", "rerank");
    expect(plain.back).toBe(false);
    expect(plain.skip).toBe(false);
  });

  it("carries the edge kind through, so a conditional can be drawn as one", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    expect(edge(l, "router", "retrieve").kind).toBe("conditional");
    expect(edge(l, "retrieve", "rerank").kind).toBe("direct");
  });
});

describe("edge identity (card 293)", () => {
  // Two edges between ONE pair used to collapse under the pair string
  // `${from}->${to}` — it doubled as the React key, so the second edge
  // silently replaced the first in the drawing.
  const twin: Topology = {
    entry: "a",
    nodes: [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ],
    edges: [
      { from: "a", to: "b", kind: "direct" },
      { from: "a", to: "b", kind: "conditional" },
    ],
  };

  it("routes BOTH parallel edges between one pair, each under its own id", () => {
    const l = layoutStateGraph(twin, "horizontal");
    expect(l.edges).toHaveLength(2);
    expect(new Set(l.edges.map((e) => e.id)).size).toBe(2);
  });

  it("keeps the plain pair string as the id of a lone edge (the stats key contract)", () => {
    const l = layoutStateGraph(CRAG, "horizontal");
    expect(edge(l, "retrieve", "rerank").id).toBe("retrieve->rerank");
    // Every id in a pair-unique topology IS the pair string.
    l.edges.forEach((e) => expect(e.id).toBe(`${e.from}->${e.to}`));
  });

  it("carries the spawn kind through routing (the workflow lens edge)", () => {
    const l = layoutStateGraph(
      {
        entry: "a",
        nodes: [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ],
        edges: [{ from: "a", to: "b", kind: "spawn" }],
      },
      "horizontal",
    );
    expect(l.edges[0].kind).toBe("spawn");
  });
});
