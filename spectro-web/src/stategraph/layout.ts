// Laying out a state graph — the part dagre cannot do.
//
// A StateGraph is cyclic and its loops are the point: a corrective RAG run goes
// grade → rewrite → router → retrieve and round again, and that loop is the
// single most interesting thing on the canvas. dagre breaks cycles by REVERSING
// an edge, so it would draw `rewrite → router` as `router → rewrite` and tell
// the reader the opposite of what happened. Here a cycle edge is MARKED and
// drawn as a returning arc, never turned around.
//
// Ported from the measured template (docs/graph-view-reference/graphview.html),
// which is the agreed visual reference. Pure on purpose: no React, no DOM, no
// React Flow types — the renderer maps this onto nodes and edges, and this file
// can be tested without any of that.

/** One node as the artifact's `graph_topology` record names it. */
export interface TopologyNode {
  id: string;
  label: string;
}

/** One edge. `conditional` is drawn differently — it is a branch the compiler
 *  knew about, which may or may not have been taken. */
export interface TopologyEdge {
  from: string;
  to: string;
  kind: "direct" | "conditional";
}

export interface Topology {
  entry: string | null;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface PlacedNode {
  id: string;
  label: string;
  rank: number;
  /** Position within the rank, centred on 0 — kept for the renderer's ruler. */
  slot: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoutedEdge {
  from: string;
  to: string;
  kind: "direct" | "conditional";
  /** True for an edge that closes a cycle. It keeps its direction. */
  back: boolean;
  /** True for a forward edge that skips ranks and had to fly over boxes. */
  skip: boolean;
  /** An SVG path, absolute, in the same space as the node boxes. */
  path: string;
}

export interface StateGraphLayout {
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  /** Highest rank present — the renderer draws one labelled column per rank. */
  maxRank: number;
  /** The bounding box of everything drawn, arcs included. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

export type Orientation = "horizontal" | "vertical";

/** Node box, and the gaps along and across the rank axis. Taken from the
 *  template so the rebuild reads at the same density. */
const NW = 132;
const NH = 46;
const MARGIN = 40;
const GAP = {
  horizontal: { along: 58, cross: 26 },
  vertical: { along: 46, cross: 40 },
} as const;

/** How far outside the node field a returning arc bows, per back edge, so two
 *  loops do not sit on top of each other. */
const BACK_LANE = 26;
const SKIP_LANE = 22;

/**
 * Lays out a topology: ranks along one axis, slots across it, and three edge
 * routings.
 *
 * @param topo the graph_topology record's shape
 * @param orientation which axis the ranks run along
 */
export function layoutStateGraph(topo: Topology, orientation: Orientation): StateGraphLayout {
  const nodes = topo.nodes.map((n) => ({ id: n.id, label: n.label }));
  const known = new Set(nodes.map((n) => n.id));
  if (nodes.length === 0) {
    return { nodes: [], edges: [], maxRank: 0, bounds: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  }
  // An edge naming a node that is not in the topology is dropped rather than
  // invented: artifacts come off disk and can be truncated mid-write.
  const edges = topo.edges.filter((e) => known.has(e.from) && known.has(e.to)).map((e, i) => ({ ...e, i }));

  const out = new Map<string, typeof edges>(nodes.map((n) => [n.id, [] as typeof edges]));
  edges.forEach((e) => out.get(e.from)!.push(e));

  // -- a. cycle edges, by iterative DFS. Grey = on the stack, so an edge into a
  // grey node closes a cycle. They are MARKED, never reversed.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const cycleEdge = new Set<number>();
  const roots: string[] = [];
  if (known.has("__start__")) roots.push("__start__");
  if (topo.entry !== null && topo.entry !== "__start__" && known.has(topo.entry)) {
    roots.push(topo.entry);
  }
  nodes.forEach((n) => roots.push(n.id));

  for (const root of roots) {
    if (colour.get(root) !== WHITE) continue;
    const stack: { id: string; k: number }[] = [{ id: root, k: 0 }];
    colour.set(root, GREY);
    while (stack.length > 0) {
      const fr = stack[stack.length - 1];
      const outs = out.get(fr.id)!;
      if (fr.k < outs.length) {
        const e = outs[fr.k++];
        const c = colour.get(e.to);
        if (c === GREY) cycleEdge.add(e.i);
        else if (c === WHITE) {
          colour.set(e.to, GREY);
          stack.push({ id: e.to, k: 0 });
        }
      } else {
        colour.set(fr.id, BLACK);
        stack.pop();
      }
    }
  }

  // -- b. longest-path rank over the acyclic remainder (Kahn).
  const dagOut = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  edges.forEach((e) => {
    if (cycleEdge.has(e.i)) return;
    if (e.from === e.to) {
      // A self loop is a cycle of length one — the DFS above only sees it as
      // grey→grey when the node is on the stack, which it is, but say it here
      // too so the invariant does not depend on traversal order.
      cycleEdge.add(e.i);
      return;
    }
    dagOut.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  });
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const to of dagOut.get(id)!) {
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }

  // __end__ always sits in the last column, whatever its longest path says —
  // a run that ends is drawn as ending on the right.
  let maxRank = 0;
  rank.forEach((r) => {
    maxRank = Math.max(maxRank, r);
  });
  if (known.has("__end__")) rank.set("__end__", maxRank);
  maxRank = 0;
  rank.forEach((r) => {
    maxRank = Math.max(maxRank, r);
  });

  // -- c. order inside each rank: seed by BFS discovery, then barycentre sweeps
  // to pull connected nodes level with each other and cut crossings.
  const layers: string[][] = [];
  for (let r = 0; r <= maxRank; r++) layers.push([]);
  const discovery = new Map<string, number>();
  let dcount = 0;
  const bfs: string[] = [];
  if (known.has("__start__")) bfs.push("__start__");
  else if (topo.entry !== null && known.has(topo.entry)) bfs.push(topo.entry);
  const seen = new Set(bfs);
  while (bfs.length > 0) {
    const id = bfs.shift()!;
    discovery.set(id, dcount++);
    for (const e of out.get(id)!) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        bfs.push(e.to);
      }
    }
  }
  nodes.forEach((n) => {
    if (!discovery.has(n.id)) discovery.set(n.id, dcount++);
  });
  nodes
    .slice()
    .sort((a, b) => discovery.get(a.id)! - discovery.get(b.id)!)
    .forEach((n) => layers[rank.get(n.id)!].push(n.id));

  const pos = new Map<string, number>();
  layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  const fwd = edges.filter((e) => !cycleEdge.has(e.i));
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const seq = layers.map((_, i) => (down ? i : layers.length - 1 - i));
    for (const r of seq) {
      const layer = layers[r];
      if (layer.length < 2) continue;
      const bary = new Map<string, number>();
      layer.forEach((id) => {
        const rel = down
          ? fwd.filter((e) => e.to === id && rank.get(e.from)! < r).map((e) => pos.get(e.from)!)
          : fwd.filter((e) => e.from === id && rank.get(e.to)! > r).map((e) => pos.get(e.to)!);
        bary.set(id, rel.length > 0 ? rel.reduce((a, b) => a + b, 0) / rel.length : pos.get(id)!);
      });
      layer.sort((a, b) => bary.get(a)! - bary.get(b)! || discovery.get(a)! - discovery.get(b)!);
      layer.forEach((id, i) => pos.set(id, i));
    }
  }

  // -- d. coordinates. One fixed cell per (rank, slot), so boxes cannot collide.
  const g = GAP[orientation];
  const gapAlong = g.along;
  const gapCross = g.cross;
  const horiz = orientation === "horizontal";
  const slotOf = new Map<string, number>();
  let minSlot = Infinity;
  layers.forEach((layer) => {
    layer.forEach((id, i) => {
      const s = i - (layer.length - 1) / 2;
      slotOf.set(id, s);
      minSlot = Math.min(minSlot, s);
    });
  });
  if (!isFinite(minSlot)) minSlot = 0;

  const placed: PlacedNode[] = nodes.map((n) => {
    const r = rank.get(n.id)!;
    const s = slotOf.get(n.id)! - minSlot;
    return {
      id: n.id,
      label: n.label,
      rank: r,
      slot: slotOf.get(n.id)!,
      x: MARGIN + (horiz ? r * (NW + gapAlong) : s * (NW + gapCross)),
      y: MARGIN + (horiz ? s * (NH + gapCross) : r * (NH + gapAlong)),
      w: NW,
      h: NH,
    };
  });
  const byId = new Map(placed.map((n) => [n.id, n]));

  // The node field's bounds. Every arc is aimed to clear them, which is what
  // makes a returning edge read as a loop instead of a line through the middle.
  let fx0 = Infinity;
  let fy0 = Infinity;
  let fx1 = -Infinity;
  let fy1 = -Infinity;
  placed.forEach((n) => {
    fx0 = Math.min(fx0, n.x);
    fy0 = Math.min(fy0, n.y);
    fx1 = Math.max(fx1, n.x + n.w);
    fy1 = Math.max(fy1, n.y + n.h);
  });

  // -- e. edge geometry. Three routings, and the grammar is deliberate:
  //   neighbouring ranks -> a straight or gently curved connector
  //   a cycle return     -> an arc bowed clear on the FAR side (below / right)
  //   a rank-skipping edge that would cut through a box in between
  //                      -> an arc bowed clear on the NEAR side (above / left)
  // The third case is not cosmetic: router→generate skips four ranks and would
  // otherwise be drawn straight through retrieve, rerank and grade.
  const cubicAt = (p: number[], t: number): { x: number; y: number } => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p[0] + b * p[2] + c * p[4] + d * p[6],
      y: a * p[1] + b * p[3] + c * p[5] + d * p[7],
    };
  };
  const cutsThrough = (p: number[], skipA: string, skipB: string): boolean => {
    for (let i = 1; i < 40; i++) {
      const pt = cubicAt(p, i / 40);
      for (const n of placed) {
        if (n.id === skipA || n.id === skipB) continue;
        if (pt.x > n.x + 1 && pt.x < n.x + n.w - 1 && pt.y > n.y + 1 && pt.y < n.y + n.h - 1) {
          return true;
        }
      }
    }
    return false;
  };
  const curve = (p: number[]): string => `M${p[0]},${p[1]} C${p[2]},${p[3]} ${p[4]},${p[5]} ${p[6]},${p[7]}`;

  let bx0 = fx0;
  let by0 = fy0;
  let bx1 = fx1;
  let by1 = fy1;
  let backIdx = 0;
  let skipIdx = 0;

  const routed: RoutedEdge[] = edges.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const back = cycleEdge.has(e.i);
    const base = { from: e.from, to: e.to, kind: e.kind, back };

    if (back) {
      // Out of the far side of the source, around, and into the far side of the
      // target. The lane grows per back edge so two loops never overlap.
      const lane = BACK_LANE * (1 + backIdx++);
      if (horiz) {
        const y = fy1 + lane;
        const sx = a.x + a.w / 2;
        const tx = b.x + b.w / 2;
        const p = [sx, a.y + a.h, sx, y, tx, y, tx, b.y + b.h];
        by1 = Math.max(by1, y);
        return { ...base, skip: false, path: curve(p) };
      }
      const x = fx1 + lane;
      const sy = a.y + a.h / 2;
      const ty = b.y + b.h / 2;
      const p = [a.x + a.w, sy, x, sy, x, ty, b.x + b.w, ty];
      bx1 = Math.max(bx1, x);
      return { ...base, skip: false, path: curve(p) };
    }

    // Forward. Try the plain connector first; only bow it if it would cut a box.
    const plain = horiz
      ? [
          a.x + a.w,
          a.y + a.h / 2,
          a.x + a.w + gapAlong,
          a.y + a.h / 2,
          b.x - gapAlong,
          b.y + b.h / 2,
          b.x,
          b.y + b.h / 2,
        ]
      : [
          a.x + a.w / 2,
          a.y + a.h,
          a.x + a.w / 2,
          a.y + a.h + gapAlong,
          b.x + b.w / 2,
          b.y - gapAlong,
          b.x + b.w / 2,
          b.y,
        ];
    if (!cutsThrough(plain, e.from, e.to)) {
      return { ...base, skip: false, path: curve(plain) };
    }
    const lane = SKIP_LANE * (1 + skipIdx++);
    if (horiz) {
      const y = fy0 - lane;
      const sx = a.x + a.w / 2;
      const tx = b.x + b.w / 2;
      const p = [sx, a.y, sx, y, tx, y, tx, b.y];
      by0 = Math.min(by0, y);
      return { ...base, skip: true, path: curve(p) };
    }
    const x = fx0 - lane;
    const sy = a.y + a.h / 2;
    const ty = b.y + b.h / 2;
    const p = [a.x, sy, x, sy, x, ty, b.x, ty];
    bx0 = Math.min(bx0, x);
    return { ...base, skip: true, path: curve(p) };
  });

  return {
    nodes: placed,
    edges: routed,
    maxRank,
    bounds: { x0: bx0 - MARGIN, y0: by0 - MARGIN, x1: bx1 + MARGIN, y1: by1 + MARGIN },
  };
}
