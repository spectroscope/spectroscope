// Card 305, follow-up: an edge between NEIGHBOURING ranks can now cross a box.
//
// `cutsThrough` — the sampler that decides whether a forward edge has to fly
// over the field instead of being drawn straight at it — used to run only on
// rank-SKIPPING edges. That gate was not laziness, it was a proof: while every
// box in a rank was the same length along the rank axis, an edge leaving a box's
// exit face was already in the GUTTER, the strip between two rank columns where
// no box can sit, and it arrived at the next column's leading face, which no box
// in that column starts before. Nothing could be in the way, so nothing was
// sampled.
//
// A stated per-node size ends the first half of that proof. A rank is now as
// long as its LONGEST box, so a narrow box finishes early and its longer
// siblings are still standing in the strip in front of it. Measured on the
// four-node topology below, before the guard was widened:
//
//   horizontal, `wide` at 420x240 — `small → tail` is drawn
//     M362,232 C517.7,232 552.3,99 708,99
//   and 18 of its 39 sampled points fall strictly inside `wide` (230,-57 420x240)
//
//   vertical, `wide` at 200x300 — `small → tail` is drawn
//     M312,178 C312,313 192,343 192,478
//   and 3 of 39 fall strictly inside `wide` (6,132 200x300)
//
// Nothing in the shipped app states a size yet, so the line is unreachable
// today. It becomes reachable with the first workflow box that states one —
// and that box is a VERTICAL phase holding agent cards of unequal height, which
// is precisely the shape that trips this.
//
// The property below is deliberately not "this edge is a lane": it is the thing
// a reader would complain about, sampled off the routed path itself, whatever
// routing produced it. Lane paths are orthogonal with rounded corners, so the
// sampler here walks M/L/Q/C rather than assuming one cubic — a fix that swaps
// a curve through a box for a lane through the same box must not read as green.

import { describe, expect, it } from "vitest";
import { layoutStateGraph, type StateGraphLayout, type Topology } from "./layout";

/** root → {wide, small} → tail, ranks supplied so the shape is the point and
 *  not an accident of ranking: two boxes share rank 1 and only one of them is
 *  oversized, so the other one's exit face is short of its own rank's end. */
const RAGGED = (size: { w: number; h: number }): Topology => ({
  entry: "root",
  nodes: ["root", "wide", "small", "tail"].map((id) => ({ id, label: id })),
  edges: [
    { from: "root", to: "wide", kind: "direct" },
    { from: "root", to: "small", kind: "direct" },
    { from: "wide", to: "tail", kind: "direct" },
    { from: "small", to: "tail", kind: "direct" },
  ],
  ranks: new Map([
    ["root", 0],
    ["wide", 1],
    ["small", 1],
    ["tail", 2],
  ]),
  sizes: new Map([["wide", size]]),
});

/** The same four nodes with no size stated anywhere — the shape the engine has
 *  always drawn, kept here so the cheap path can be pinned as still cheap. */
const UNIFORM: Topology = { ...RAGGED({ w: 132, h: 46 }), sizes: undefined };

interface Pt {
  x: number;
  y: number;
}

/** Walks a path this engine emits — one cubic, one line, or an orthogonal lane
 *  of L and Q segments — and returns points along it. Segment ends are included
 *  and lie ON a face rather than inside it, which is what "strictly" is for. */
function samplePath(path: string, per = 24): Pt[] {
  const pts: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  for (const token of path.match(/[MLCQ][^MLCQ]*/g) ?? []) {
    const n = (token.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (token[0] === "M") {
      cur = { x: n[0], y: n[1] };
      pts.push(cur);
    } else if (token[0] === "L") {
      const to = { x: n[0], y: n[1] };
      for (let i = 1; i <= per; i++) {
        const s = i / per;
        pts.push({ x: cur.x + (to.x - cur.x) * s, y: cur.y + (to.y - cur.y) * s });
      }
      cur = to;
    } else if (token[0] === "Q") {
      const c = { x: n[0], y: n[1] };
      const to = { x: n[2], y: n[3] };
      for (let i = 1; i <= per; i++) {
        const s = i / per;
        const u = 1 - s;
        pts.push({
          x: u * u * cur.x + 2 * u * s * c.x + s * s * to.x,
          y: u * u * cur.y + 2 * u * s * c.y + s * s * to.y,
        });
      }
      cur = to;
    } else {
      const c1 = { x: n[0], y: n[1] };
      const c2 = { x: n[2], y: n[3] };
      const to = { x: n[4], y: n[5] };
      for (let i = 1; i <= per; i++) {
        const s = i / per;
        const u = 1 - s;
        pts.push({
          x: u * u * u * cur.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * to.x,
          y: u * u * u * cur.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * to.y,
        });
      }
      cur = to;
    }
  }
  return pts;
}

/** Every ⟨edge, box⟩ pair where the edge's path passes strictly through a box
 *  that is neither of its endpoints, named so a failure says WHICH edge and
 *  WHICH box rather than just a count. */
function crossings(l: StateGraphLayout): string[] {
  const found: string[] = [];
  for (const e of l.edges) {
    const pts = samplePath(e.path);
    for (const n of l.nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const hits = pts.filter((p) => p.x > n.x && p.x < n.x + n.w && p.y > n.y && p.y < n.y + n.h);
      if (hits.length > 0) {
        found.push(`${e.id} crosses ${n.id} at ${hits.length}/${pts.length} points — path ${e.path}`);
      }
    }
  }
  return found;
}

describe("a routed edge stays out of every box that is not its own end", () => {
  it("when a horizontal rank holds a box far wider than its sibling", () => {
    // Bitten apart from the vertical case rather than looped over both: the two
    // orientations read the override on different axes and route on different
    // branches, so a fix that wires up only one of them must fail exactly one
    // of these two.
    expect(crossings(layoutStateGraph(RAGGED({ w: 420, h: 240 }), "horizontal"))).toEqual([]);
  });

  it("when a vertical rank holds a box far taller than its sibling", () => {
    expect(crossings(layoutStateGraph(RAGGED({ w: 200, h: 300 }), "vertical"))).toEqual([]);
  });

  it("still routes a neighbouring hop plainly when the rank is not ragged", () => {
    // The other half of the guard: it exists to keep the common case cheap, and
    // widening it must not turn every short hop into a flyover. With no size
    // stated, no rank is ragged, and every one-rank edge stays a plain connector.
    for (const orientation of ["horizontal", "vertical"] as const) {
      const l = layoutStateGraph(UNIFORM, orientation);
      const hops = l.edges.filter((e) => !e.back);
      expect(hops.length).toBe(4);
      for (const e of hops) expect(e.skip).toBe(false);
    }
  });
});
