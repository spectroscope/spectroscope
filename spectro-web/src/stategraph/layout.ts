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
 *  knew about, which may or may not have been taken. `spawn` is the workflow
 *  lens's edge (card 293): reconstructed from the run's events, not declared
 *  before it, and drawn dashed for exactly that reason. */
export interface TopologyEdge {
  from: string;
  to: string;
  kind: "direct" | "conditional" | "spawn";
}

export interface Topology {
  entry: string | null;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Optional rank override (card 293): a caller that KNOWS the ranks — the
   *  workflow lens ranks by time overlap — hands them in, and the longest-path
   *  ranking steps aside. A node the map does not name sits at rank 0.
   *  Everything downstream (in-rank ordering, coordinates, routing, skip
   *  lanes, the `__end__` last-column rule) works off the ranks unchanged. */
  ranks?: ReadonlyMap<string, number>;
  /** Optional rank captions (card 302): a caller whose columns MEAN something
   *  says so, and the layout carries the words to `rankLabels` instead of the
   *  renderer having to reach back for them. The state graph hands none in and
   *  keeps printing "rank N" — the number IS the whole truth about a column
   *  that came out of a longest-path ranking. The workflow lens hands in the
   *  script's declared phases, which existed before the run did. */
  rankCaptions?: ReadonlyMap<number, RankCaption>;
}

/** What a rank is CALLED, when the caller knows. `detail` is the phase's own
 *  second line — kept apart from the title so a renderer can drop it rather
 *  than having to split a string somebody joined. */
export interface RankCaption {
  title: string;
  detail: string | null;
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
  /** Unique per EDGE, not per pair: the pair string for the first edge between
   *  a pair, `pair#2`, `pair#3`, … for parallel ones. The pair string used to
   *  double as the React key, so a second edge between one pair silently
   *  replaced the first in the drawing (card 293). Renderers key on THIS. */
  id: string;
  from: string;
  to: string;
  kind: "direct" | "conditional" | "spawn";
  /** True for an edge that closes a cycle. It keeps its direction. */
  back: boolean;
  /** True for a forward edge that skips ranks and had to fly over boxes. */
  skip: boolean;
  /** An SVG path, absolute, in the same space as the node boxes. */
  path: string;
  /** Where this edge's ×N / ↺ label sits — a lane edge labels on its lane,
   *  a plain connector on its midpoint, the template's own anchors. */
  labelX: number;
  labelY: number;
}

/** One full-length rule per rank, on the gutter before the rank's column —
 *  the template's ruled field: it runs far past the content so the slack
 *  around a wide, short graph reads as ruled space, not as emptiness. */
export interface RankRule {
  rank: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where one rank's label sits — the template's own anchors: beside the
 *  rank's node nearest the axis, in the margin the boxes never enter. */
export interface RankLabel {
  rank: number;
  x: number;
  y: number;
  /** The caller's own words for this column, when it handed any in. */
  caption?: RankCaption;
}

export interface StateGraphLayout {
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  /** Highest rank present — one labelled column per rank, via rankLabels. */
  maxRank: number;
  /** One label per occupied rank, positioned for the chosen orientation. */
  rankLabels: RankLabel[];
  /** One full-length rule per occupied rank, on its gutter. */
  rankRules: RankRule[];
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

/** The lane grammar, the template's own numbers: how far outside the node
 *  field a returning (46) or skipping (42) lane clears, how much further each
 *  additional lane steps (36) so two loops never share one, how far an edge
 *  steps sideways into the gutter (30, capped below the gap), and the corner
 *  radius that makes a lane read as a loop instead of a wiring diagram. */
const BACK_CLEAR = 46;
const SKIP_CLEAR = 42;
const LANE_STEP = 36;
const GUTTER = 30;
const CORNER = 18;

/** An orthogonal polyline with rounded corners — the template's orthoPath. */
function orthoPath(pts: number[][], r: number): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (l1 < 0.5 || l2 < 0.5) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = p1[0] - ((p1[0] - p0[0]) / l1) * rr;
    const ay = p1[1] - ((p1[1] - p0[1]) / l1) * rr;
    const bx = p1[0] + ((p2[0] - p1[0]) / l2) * rr;
    const by = p1[1] + ((p2[1] - p1[1]) / l2) * rr;
    d += ` L${ax},${ay} Q${p1[0]},${p1[1]} ${bx},${by}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last[0]},${last[1]}`;
}

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
    return {
      nodes: [],
      edges: [],
      maxRank: 0,
      rankLabels: [],
      rankRules: [],
      bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
    };
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
  if (topo.ranks !== undefined) {
    // The caller's ranks are authoritative — see Topology.ranks.
    const given = topo.ranks;
    nodes.forEach((n) => rank.set(n.id, Math.max(0, given.get(n.id) ?? 0)));
  } else {
    const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const to of dagOut.get(id)!) {
        rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
        indeg.set(to, indeg.get(to)! - 1);
        if (indeg.get(to) === 0) queue.push(to);
      }
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

  // One label per occupied rank, riding the rank's node nearest the axis —
  // the template's anchors: (first.x, MARGIN-12) along, (MARGIN-22, first.y-8)
  // across. Computed here rather than in the renderer so the export SVG and
  // the live overlay cannot disagree about where a column is.
  const rankLabels: RankLabel[] = [];
  for (let r = 0; r <= maxRank; r++) {
    const inRank = placed.filter((n) => n.rank === r);
    if (inRank.length === 0) continue;
    const first = inRank.reduce((a, b) => ((horiz ? b.y < a.y : b.x < a.x) ? b : a));
    const caption = topo.rankCaptions?.get(r);
    rankLabels.push({
      ...(horiz ? { rank: r, x: first.x, y: MARGIN - 12 } : { rank: r, x: MARGIN - 22, y: first.y - 8 }),
      ...(caption !== undefined ? { caption } : {}),
    });
  }

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
  const gutter = Math.min(GUTTER, gapAlong - 10);

  const pairSeen = new Map<string, number>();
  const routed: RoutedEdge[] = edges.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const back = cycleEdge.has(e.i);
    const pair = `${e.from}->${e.to}`;
    const nth = (pairSeen.get(pair) ?? 0) + 1;
    pairSeen.set(pair, nth);
    const base = { id: nth === 1 ? pair : `${pair}#${nth}`, from: e.from, to: e.to, kind: e.kind, back };

    // A lane never crosses the field: it steps sideways into a GUTTER (the
    // free strip between two rank columns, where no box can ever sit), runs
    // along a LANE outside the field, and steps back in through the target's
    // gutter. Every segment lies in provably empty space, and the generous
    // corner radius is what makes it read as a loop instead of a wiring
    // diagram. A back edge re-enters through the target's ENTRY face, so its
    // arrowhead points INTO the box — never a reversed arrow.
    const lane = (side: -1 | 1, baseClear: number, idx: number) => {
      const clear = baseClear + idx * LANE_STEP;
      if (horiz) {
        const laneAt = side < 0 ? fy0 - clear : fy1 + clear;
        const sy = a.y + a.h / 2;
        const ty = b.y + b.h / 2;
        const sx = side < 0 ? a.x + a.w : a.x;
        const g1 = side < 0 ? sx + gutter : sx - gutter;
        const g2 = b.x - gutter;
        const pts = [
          [sx, sy],
          [g1, sy],
          [g1, laneAt],
          [g2, laneAt],
          [g2, ty],
          [b.x, ty],
        ];
        if (side < 0) by0 = Math.min(by0, laneAt - 22);
        else by1 = Math.max(by1, laneAt + 22);
        return {
          path: orthoPath(pts, CORNER),
          labelX: (g1 + g2) / 2,
          labelY: laneAt + (side < 0 ? -9 : 17),
        };
      }
      const laneAt = side < 0 ? fx0 - clear : fx1 + clear;
      const sx = a.x + a.w / 2;
      const tx = b.x + b.w / 2;
      const sy = side < 0 ? a.y + a.h : a.y;
      const g1 = side < 0 ? sy + gutter : sy - gutter;
      const g2 = b.y - gutter;
      const pts = [
        [sx, sy],
        [sx, g1],
        [laneAt, g1],
        [laneAt, g2],
        [tx, g2],
        [tx, b.y],
      ];
      if (side < 0) bx0 = Math.min(bx0, laneAt - 34);
      else bx1 = Math.max(bx1, laneAt + 30);
      return {
        path: orthoPath(pts, CORNER),
        labelX: laneAt + (side < 0 ? -11 : 13),
        labelY: (g1 + g2) / 2,
      };
    };

    if (back) {
      return { ...base, skip: false, ...lane(1, BACK_CLEAR, backIdx++) };
    }

    // Forward: the template's plain connector — straight when the two faces
    // align, otherwise a cubic whose pull is max(24, 45% of the distance), so
    // a short hop bends tightly instead of ballooning.
    if (horiz) {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const c = Math.max(24, (x2 - x1) * 0.45);
      const p = [x1, y1, x1 + c, y1, x2 - c, y2, x2, y2];
      if (b.rank - a.rank > 1 && cutsThrough(p, e.from, e.to)) {
        return { ...base, skip: true, ...lane(-1, SKIP_CLEAR, skipIdx++) };
      }
      const path = Math.abs(y1 - y2) < 0.5 ? `M${x1},${y1} L${x2},${y2}` : curve(p);
      return { ...base, skip: false, path, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 7 };
    }
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const c = Math.max(24, (y2 - y1) * 0.45);
    const p = [x1, y1, x1, y1 + c, x2, y2 - c, x2, y2];
    if (b.rank - a.rank > 1 && cutsThrough(p, e.from, e.to)) {
      return { ...base, skip: true, ...lane(-1, SKIP_CLEAR, skipIdx++) };
    }
    const path = Math.abs(x1 - x2) < 0.5 ? `M${x1},${y1} L${x2},${y2}` : curve(p);
    return { ...base, skip: false, path, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 7 };
  });

  // The ruled field: one thin line per rank, on the gutter before its column,
  // running far past the content in both directions.
  const FAR = 4000;
  const rankRules: RankRule[] = rankLabels.map((l) => {
    if (horiz) {
      const x = l.x - gapAlong / 2;
      return { rank: l.rank, x1: x, y1: -FAR, x2: x, y2: FAR };
    }
    const first = placed.filter((n) => n.rank === l.rank).reduce((p, q) => (q.x < p.x ? q : p));
    const y = first.y - gapAlong / 2;
    return { rank: l.rank, x1: -FAR, y1: y, x2: FAR, y2: y };
  });

  return {
    nodes: placed,
    edges: routed,
    maxRank,
    rankLabels,
    rankRules,
    bounds: { x0: bx0 - MARGIN, y0: by0 - MARGIN, x1: bx1 + MARGIN, y1: by1 + MARGIN },
  };
}
