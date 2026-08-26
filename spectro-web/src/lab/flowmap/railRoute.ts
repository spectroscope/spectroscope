// Where a right-angled rail turns (card 287).
//
// The rails draw with the canvas package's own smooth-step helper instead of
// the bezier; this module decides the ONE number that helper leaves to the
// caller — where the turn happens.
//
// WHY IT IS NOT THE MIDPOINT. A smooth-step rail is a run out of the source
// handle, a trunk across, and a run into the target handle. The helper's
// default puts the trunk halfway between the two handles, and on this map
// halfway is inside a card. Read off a running eight-worker replay (Chrome,
// 1440x900 — two worker columns with 60px of gutter, four rows): a
// left-column worker's rail to the LLM turned 230px INSIDE the right-hand
// column; another's trunk ran straight down through three right-column cards;
// every right-column worker's rail home to the agent turned inside the LEFT
// column, the same fault mirrored.
//
// So the trunk is chosen against the geometry: one position just clear of
// each card edge, plus the middle of each free lane, is scored by how much
// of the whole path would lie inside a card, and the cheapest wins. Ties go
// to the position NEAREST THE SOURCE, which is what makes the picture read
// as wiring rather than as diagonals in disguise: a short stub out of the
// card, then a long straight run in the gutter.
//
// WHAT IT CANNOT FIX, stated rather than hidden. One trunk means one change
// of axis, so a rail from the right-hand worker column to the agent has to
// cross the left-hand column at either its own handle's y or the agent's,
// and both of those are inside a card for a worker in row one. That is a
// property of the SEATING, not of the routing, and the seating is
// sceneToFlow's worker grid. The scorer picks the cheapest crossing rather
// than pretending there is none.
//
// Pure, DOM-free and canvas-free on purpose — unit-testable in the plain-Node
// gate; it declares the two structural types it needs instead of importing
// them.

/** A card the rails must not run through. Zones (the drawn frames) are
 *  background and are never passed in. */
export type RailBox = { id: string; x: number; y: number; w: number; h: number };

/** Which side of its node a rail end leaves or arrives on. The engine names
 *  its handles `<side><s|t>` — `rs`, `lt`, `bs`, `tt` — so the side is the
 *  first character of the handle id. */
export type Side = "l" | "r" | "t" | "b";

export type RailEnd = { x: number; y: number; side: Side };

/** The trunk: which axis it runs on, and where. `x` means a VERTICAL trunk
 *  standing at that x (the run between two side handles); `y` means a
 *  HORIZONTAL trunk lying at that y (the run between a bottom and a top). */
export type Trunk = { axis: "x" | "y"; at: number };

/** How far a trunk keeps off a card it is passing. The same 22 as the stub,
 *  which is what a 60px gutter between two worker columns can afford: 22 of
 *  clearance on each side leaves a 16px lane down its middle, and one lane
 *  there is exactly what eight workers need. Raise it and that gutter closes,
 *  and every worker's rail to the LLM goes looking for a lane somewhere
 *  worse. */
export const RAIL_CLEAR = 22;

/** How far a rail must travel before it is allowed to turn — the helper's
 *  own `offset`, repeated here because a candidate closer than this to
 *  either handle is not reachable. */
export const RAIL_STUB = 22;

/** Which way a handle points. */
const DIR: Record<Side, { x: number; y: number }> = {
  l: { x: -1, y: 0 },
  r: { x: 1, y: 0 },
  t: { x: 0, y: -1 },
  b: { x: 0, y: 1 },
};

export type Pt = { x: number; y: number };

/**
 * WHICH of the helper's two centres actually moves the trunk.
 *
 * This is not a choice — it is a reading of the installed `@xyflow/system`'s
 * `getPoints` (`getSmoothStepPath` -> `getPoints`), and getting it wrong is
 * silent: the helper simply ignores the centre that does not apply and
 * routes on its own default. That is exactly what happened on the first
 * pass of this port's donor — rails from worker rows three and four down to
 * the OS stations were handed a `centerY` the helper never reads, and one of
 * them ran 84px through the network card.
 *
 * The rule, for the opposite-handle pairs this engine draws (`rs`->`lt`,
 * `ls`->`rt`, `bs`->`tt`): the helper takes an accessor from the SOURCE
 * side (x for a left/right handle, y for a top/bottom one) and compares the
 * source handle's own direction with the direction the target actually
 * lies in. When they agree the split is on that accessor's axis; when they
 * disagree — the target is BEHIND the handle, which is every station rail
 * from a worker seated below the OS band — the split flips to the other
 * axis. So a rail out of a bottom handle turns on a `centerY` when the
 * target is below it and on a `centerX` when the target is above it.
 */
export function splitAxis(from: RailEnd, to: RailEnd): "x" | "y" {
  const sd = DIR[from.side];
  const td = DIR[to.side];
  const acc: "x" | "y" = from.side === "l" || from.side === "r" ? "x" : "y";
  // Not an opposite-handle pair: the helper picks its points from the two
  // ends alone and reads neither centre. Reported as the source's own axis;
  // the caller's candidate is then inert rather than wrong.
  if (sd[acc] * td[acc] !== -1) return acc;
  const sg = gap(from);
  const tg = gap(to);
  const curr = Math.sign(tg[acc] - sg[acc]);
  const natural = sd[acc] === curr;
  if (acc === "x") return natural ? "x" : "y";
  return natural ? "y" : "x";
}

/** The point a rail reaches after its straight run out of the handle. */
export function gap(end: RailEnd): Pt {
  const d = DIR[end.side];
  return { x: end.x + d.x * RAIL_STUB, y: end.y + d.y * RAIL_STUB };
}

type Span = { lo: number; hi: number };

function overlap(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
}

function merge(spans: Span[]): Span[] {
  const s = [...spans].sort((p, q) => p.lo - q.lo);
  const out: Span[] = [];
  for (const cur of s) {
    const last = out[out.length - 1];
    if (last && cur.lo <= last.hi) last.hi = Math.max(last.hi, cur.hi);
    else out.push({ ...cur });
  }
  return out;
}

/** The stretches of [lo, hi] no blocked span covers. */
function freeGaps(lo: number, hi: number, blocked: Span[]): Span[] {
  const gaps: Span[] = [];
  let at = lo;
  for (const b of merge(blocked)) {
    if (b.hi <= at) continue;
    if (b.lo > hi) break;
    if (b.lo > at) gaps.push({ lo: at, hi: Math.min(b.lo, hi) });
    at = Math.max(at, b.hi);
    if (at >= hi) break;
  }
  if (at < hi) gaps.push({ lo: at, hi });
  return gaps.filter((g) => g.hi - g.lo > 1);
}

/** How much of one axis-aligned segment lies inside the given cards. */
function crossed(seg: { x1: number; y1: number; x2: number; y2: number }, boxes: RailBox[]): number {
  const xs: Span = { lo: Math.min(seg.x1, seg.x2), hi: Math.max(seg.x1, seg.x2) };
  const ys: Span = { lo: Math.min(seg.y1, seg.y2), hi: Math.max(seg.y1, seg.y2) };
  let total = 0;
  for (const b of boxes) {
    const bx: Span = { lo: b.x, hi: b.x + b.w };
    const by: Span = { lo: b.y, hi: b.y + b.h };
    if (seg.y1 === seg.y2) {
      // horizontal: it is inside only if its y is within the card's band
      if (seg.y1 <= by.lo || seg.y1 >= by.hi) continue;
      total += overlap(xs, bx);
    } else {
      if (seg.x1 <= bx.lo || seg.x1 >= bx.hi) continue;
      total += overlap(ys, by);
    }
  }
  return total;
}

/** The corner points the helper will draw for one candidate turn, in order,
 *  from the source handle to the target handle.
 *
 *  Mirrors `getPoints`'s two shapes: a VERTICAL split (`axis: "x"`) stands
 *  the trunk at `at` and runs to it along the two gapped handle heights; a
 *  HORIZONTAL split (`axis: "y"`) lays the trunk at `at` and runs to it
 *  along the two gapped handle columns. */
export function railPoints(from: RailEnd, to: RailEnd, at: number, axis: "x" | "y"): Pt[] {
  const sg = gap(from);
  const tg = gap(to);
  const mid: Pt[] =
    axis === "x"
      ? [
          { x: at, y: sg.y },
          { x: at, y: tg.y },
        ]
      : [
          { x: sg.x, y: at },
          { x: tg.x, y: at },
        ];
  return [{ x: from.x, y: from.y }, sg, ...mid, tg, { x: to.x, y: to.y }];
}

/** The whole path's length inside cards, for one candidate turn. */
export function pathCost(from: RailEnd, to: RailEnd, at: number, axis: "x" | "y", boxes: RailBox[]): number {
  const pts = railPoints(from, to, at, axis);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    // Only the axis-aligned legs are real; the helper never draws a diagonal,
    // and a pair that differs on both axes cannot arise from railPoints.
    if (a.x !== b.x && a.y !== b.y) continue;
    total += crossed({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }, boxes);
  }
  return total;
}

/**
 * Where this rail should turn.
 *
 * `boxes` is every card the rail may not run through, INCLUDING the two it
 * is attached to (a station rail that doubles back past its own card would
 * otherwise climb straight through it).
 *
 * `lane` nudges the turn off its best position so two rails sharing a lane
 * do not paint over each other. It is spent only when it costs nothing: a
 * nudge that would push the rail into a card is dropped, because separating
 * two rails is worth less than keeping either of them out of a card.
 *
 * WHY THE CANDIDATES ARE CARD EDGES rather than the middles of the free
 * lanes. The cost of a turn is piecewise as a function of where it is put,
 * and every breakpoint is a card edge — so scoring one position just clear
 * of each edge, plus the middle of each free lane, finds the true minimum
 * without sweeping. Free lanes alone are not enough: with a tall card
 * standing directly above a station there may be NO lane clear all the way
 * across, and a free-lane-only search falls back to a slot that costs a
 * whole worker card on the way down. Scoring the edges finds the turn that
 * only clips a corner — worse than nothing, better than a lit rail through
 * a worker.
 */
export function trunkFor(from: RailEnd, to: RailEnd, boxes: RailBox[], lane = 0): Trunk {
  const axis = splitAxis(from, to);
  const sg = gap(from);
  const tg = gap(to);
  const a = axis === "x" ? sg.x : sg.y;
  const b = axis === "x" ? tg.x : tg.y;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const mid = (a + b) / 2;
  if (hi - lo <= 2) return { axis, at: mid };

  // What the trunk itself would run through: the cards whose OTHER axis band
  // the trunk spans.
  const span: Span = {
    lo: Math.min(axis === "x" ? sg.y : sg.x, axis === "x" ? tg.y : tg.x),
    hi: Math.max(axis === "x" ? sg.y : sg.x, axis === "x" ? tg.y : tg.x),
  };
  const blocked: Span[] = [];
  const edges: number[] = [];
  for (const box of boxes) {
    const along: Span = axis === "x" ? { lo: box.x, hi: box.x + box.w } : { lo: box.y, hi: box.y + box.h };
    edges.push(along.lo - RAIL_CLEAR, along.hi + RAIL_CLEAR);
    const across: Span = axis === "x" ? { lo: box.y, hi: box.y + box.h } : { lo: box.x, hi: box.x + box.w };
    if (overlap(span, across) <= 0) continue;
    blocked.push({ lo: along.lo - RAIL_CLEAR, hi: along.hi + RAIL_CLEAR });
  }

  const candidates = [lo, hi, mid];
  for (const g of freeGaps(lo, hi, blocked)) candidates.push((g.lo + g.hi) / 2);
  for (const e of edges) if (e > lo && e < hi) candidates.push(e);

  let best: { at: number; cost: number; near: number } | null = null;
  for (const at of candidates) {
    const cost = pathCost(from, to, at, axis, boxes);
    const near = Math.abs(at - a);
    if (!best || cost < best.cost - 0.5 || (cost <= best.cost + 0.5 && near < best.near)) {
      best = { at, cost, near };
    }
  }
  if (!best) return { axis, at: mid };
  if (lane !== 0) {
    const nudged = Math.min(hi, Math.max(lo, best.at + lane));
    if (pathCost(from, to, nudged, axis, boxes) <= best.cost + 0.5) return { axis, at: nudged };
  }
  return { axis, at: best.at };
}
