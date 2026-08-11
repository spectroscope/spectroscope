// The reference's edge grammar, ported whole (graphview.html:932-1010,
// 1263-1272, 1283-1301, 1372-1389):
//
//   neighbouring ranks  -> a straight or gently curved connector (a cubic,
//                          control pull max(24, dist*0.45) — never an elbow)
//   a cycle return      -> an ORTHOGONAL lane path with rounded corners,
//                          stepping through the gutters, clear below/right
//   a rank-skipper      -> the same lane grammar, clear above/left
//
// plus the three arrowhead markers swapped by state (quiet -> taken -> live),
// the ×N / ↺ labels at the lane's own anchor, and one full-length rule per
// rank — the ruled field that separates the stages.
//
// Before this suite the canvas drew every edge TWICE: React Flow's straight
// stateful line under the overlay's soft stateless cubic. One renderer now.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutStateGraph } from "./layout";
import { CanvasOverlay } from "./StateGraphView";
import { edgeStatsUpTo, readStateGraphRun } from "./artifact";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");

/** The reference topology: has a loop (rewrite->router), a four-rank skipper
 *  (router->generate) and plain neighbours — all three routings in one graph. */
const run = readStateGraphRun(GRAPH, null);

const edge = (l: ReturnType<typeof layoutStateGraph>, from: string, to: string) => {
  const e = l.edges.find((x) => x.from === from && x.to === to);
  if (e === undefined) throw new Error(`${from}->${to} missing`);
  return e;
};

describe("the three routings", () => {
  const l = layoutStateGraph(run.topology, "horizontal");

  it("draws a returning edge as an orthogonal lane path, never a cubic", () => {
    const back = edge(l, "rewrite", "router");
    expect(back.back).toBe(true);
    expect(back.path).not.toContain("C");
    expect(back.path).toContain("Q");
    expect(back.path.match(/L/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("draws a rank-skipper with the same lane grammar", () => {
    const skip = edge(l, "router", "generate");
    expect(skip.skip).toBe(true);
    expect(skip.path).not.toContain("C");
    expect(skip.path).toContain("Q");
  });

  it("keeps a neighbouring edge a plain connector — line or cubic, no elbows", () => {
    for (const e of l.edges) {
      if (e.back || e.skip) continue;
      expect(e.path, `${e.from}->${e.to}`).not.toContain("Q");
    }
  });

  it("re-enters the loop target from the front, so the arrow points INTO the box", () => {
    // The reference's lane walks around and back in through the target's own
    // entry face — an arrowhead on a reversed edge would say the opposite of
    // what ran.
    const back = edge(l, "rewrite", "router");
    const router = l.nodes.find((n) => n.id === "router")!;
    const end = back.path.match(/L\s*([-\d.]+),([-\d.]+)\s*$/);
    expect(end).not.toBeNull();
    expect(Number(end![1])).toBeCloseTo(router.x, 0);
  });

  it("gives every edge a label anchor, lane edges outside the field", () => {
    const lowest = Math.max(...l.nodes.map((n) => n.y + n.h));
    const highest = Math.min(...l.nodes.map((n) => n.y));
    for (const e of l.edges) {
      expect(Number.isFinite(e.labelX), `${e.from}->${e.to}`).toBe(true);
      expect(Number.isFinite(e.labelY), `${e.from}->${e.to}`).toBe(true);
    }
    expect(edge(l, "rewrite", "router").labelY).toBeGreaterThan(lowest);
    expect(edge(l, "router", "generate").labelY).toBeLessThan(highest);
  });
});

describe("the ruled field", () => {
  it("hands the renderer one full-length rule per rank, on the gutter", () => {
    const l = layoutStateGraph(run.topology, "horizontal");
    expect(l.rankRules).toHaveLength(l.maxRank + 1);
    for (const r of l.rankRules) {
      expect(r.x1).toBe(r.x2);
      expect(r.y2 - r.y1).toBeGreaterThan(4000);
    }
  });

  it("rules run across when vertical", () => {
    const l = layoutStateGraph(run.topology, "vertical");
    for (const r of l.rankRules) {
      expect(r.y1).toBe(r.y2);
    }
  });
});

describe("edge state on the one renderer", () => {
  const l = layoutStateGraph(run.topology, "horizontal");

  const render = (upto: number) =>
    renderToStaticMarkup(<CanvasOverlay laid={l} stats={edgeStatsUpTo(run, upto)} started={upto >= 0} />);

  it("carries the three arrowhead markers in its defs", () => {
    const html = render(0);
    for (const id of ["ar-quiet", "ar-taken", "ar-live"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`marker-end`);
    }
    expect(html).toContain('d="M0,1 L9,5 L0,9 z"');
  });

  it("dims an untaken edge once the run started, quiet marker still on", () => {
    const html = render(run.records.length - 1);
    // web is never entered in the reference run; its edge stays, stepped back.
    expect(html).toMatch(/is-dim[^>]*marker-end="url\(#ar-quiet\)"|marker-end="url\(#ar-quiet\)"[^>]*is-dim/);
  });

  it("tints a walked edge and its arrowhead together", () => {
    const html = render(run.records.length - 1);
    expect(html).toContain("is-walked");
    expect(html).toContain('marker-end="url(#ar-taken)"');
  });

  it("marks the cursor's own edge live", () => {
    const at = run.records.findIndex((r) => r.type === "edge_taken");
    const html = render(at);
    expect(html).toContain("is-live");
    expect(html).toContain('marker-end="url(#ar-live)"');
  });

  it("labels a loop ↺ and a repeat ×N", () => {
    const html = render(run.records.length - 1);
    expect(html).toContain("↺");
    expect(html).toMatch(/×\d/);
    expect(html).toContain("sg-elabel");
  });
});

describe("edgeStatsUpTo", () => {
  it("counts per edge and names the cursor's last edge", () => {
    const firstTaken = run.records.findIndex((r) => r.type === "edge_taken");
    const stats = edgeStatsUpTo(run, firstTaken);
    const r = run.records[firstTaken];
    expect(stats.last).toBe(`${r.from}->${r.to}`);
    expect(stats.counts.get(`${r.from}->${r.to}`)).toBe(1);

    const all = edgeStatsUpTo(run, run.records.length - 1);
    expect(all.last).not.toBeNull();
    expect(Math.max(...all.counts.values())).toBeGreaterThan(1);
  });
});
