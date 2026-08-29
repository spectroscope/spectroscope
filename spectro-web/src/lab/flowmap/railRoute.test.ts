// The rails route around the cards, and the numbers below are the map they
// route around: every box is a real seating measured off a running eight-worker
// replay in Chrome at 1440x900, read out of the canvas's own transform rather
// than typed from a design. A layout change that invalidates these is supposed
// to fail here loudly — the point of the fixture is that the routing was
// verified against a map that really existed.

import { test, expect, describe } from "vitest";
import { trunkFor, pathCost, splitAxis, gap, stationLane, RAIL_STUB, type RailBox } from "./railRoute";
import { railLane } from "./PacketEdge";

/** An eight-worker map. Zones are excluded exactly as the canvas excludes
 *  them: they are the drawn frames, not cards. */
const SESSION: RailBox[] = [
  { id: "user", x: 40, y: 380, w: 400, h: 127 },
  { id: "agent", x: 500, y: 150, w: 680, h: 359 },
  { id: "os-disk", x: 58, y: 1070, w: 152, h: 103 },
  { id: "os-shell", x: 236, y: 1070, w: 200, h: 63 },
  { id: "os-mcp", x: 462, y: 1070, w: 380, h: 63 },
  { id: "os-net", x: 868, y: 1070, w: 104, h: 91 },
  { id: "llm", x: 2442, y: 240, w: 440, h: 514 },
  { id: "netz", x: 2440, y: 982, w: 150, h: 102 },
  { id: "mcpserver", x: 2640, y: 982, w: 150, h: 102 },
  // the worker grid: two columns 60px apart, four rows 216px apart
  { id: "w1", x: 1430, y: 110, w: 408, h: 324 },
  { id: "w2", x: 1430, y: 650, w: 408, h: 324 },
  { id: "w3", x: 1430, y: 1190, w: 408, h: 324 },
  { id: "w4", x: 1430, y: 1730, w: 408, h: 324 },
  { id: "w5", x: 1898, y: 110, w: 408, h: 324 },
  { id: "w6", x: 1898, y: 650, w: 408, h: 324 },
  { id: "w7", x: 1898, y: 1190, w: 408, h: 324 },
  { id: "w8", x: 1898, y: 1730, w: 408, h: 324 },
];

const box = (id: string) => SESSION.find((b) => b.id === id)!;
const right = (id: string) => ({
  x: box(id).x + box(id).w,
  y: box(id).y + box(id).h / 2,
  side: "r" as const,
});
const left = (id: string) => ({ x: box(id).x, y: box(id).y + box(id).h / 2, side: "l" as const });
const bottom = (id: string) => ({
  x: box(id).x + box(id).w / 2,
  y: box(id).y + box(id).h,
  side: "b" as const,
});
const top = (id: string) => ({ x: box(id).x + box(id).w / 2, y: box(id).y, side: "t" as const });

describe("which centre the helper actually reads", () => {
  // The regression this exists for: a `centerY` handed to a rail whose
  // target is ABOVE its bottom handle is silently ignored, the helper falls
  // back to its own centre, and the rail runs wherever that lands — measured
  // 84px inside the network card on the donor map.
  test("a rail out of a bottom handle turns on y when the target is below", () => {
    expect(splitAxis(bottom("agent"), top("os-disk"))).toBe("y");
  });

  test("...and on x when the target is above — the case that was wrong", () => {
    // worker row four sits 660px BELOW the OS band it is reaching up into
    expect(splitAxis(bottom("w4"), top("os-disk"))).toBe("x");
  });

  test("a side-to-side rail turns on x when the target is ahead of the handle", () => {
    expect(splitAxis(right("w1"), left("llm"))).toBe("x");
    expect(splitAxis(left("w5"), right("agent"))).toBe("x");
  });

  test("the stub leaves the handle in the handle's own direction", () => {
    expect(gap(right("agent"))).toEqual({ x: 1180 + RAIL_STUB, y: 329.5 });
    expect(gap(top("os-disk"))).toEqual({ x: 134, y: 1070 - RAIL_STUB });
  });
});

describe("the turn lands in a gutter, not in a card", () => {
  test("a left-column worker reaches the LLM through the gutter between the columns", () => {
    const t = trunkFor(right("w1"), left("llm"), SESSION);
    expect(t.axis).toBe("x");
    // the 60px gutter between the two worker columns, clear of both
    expect(t.at).toBeGreaterThan(1838);
    expect(t.at).toBeLessThan(1898);
  });

  test("...where the helper's own default would have been inside the right column", () => {
    // the midpoint the helper picks with no centre given
    const s = gap(right("w1"));
    const e = gap(left("llm"));
    const mid = (s.x + e.x) / 2;
    expect(mid).toBeGreaterThan(1898);
    expect(mid).toBeLessThan(2306);
    expect(pathCost(right("w1"), left("llm"), mid, "x", SESSION)).toBeGreaterThan(300);
    expect(
      pathCost(right("w1"), left("llm"), trunkFor(right("w1"), left("llm"), SESSION).at, "x", SESSION),
    ).toBe(0);
  });

  test("a right-column worker goes home to the agent without a trunk inside the left column", () => {
    const t = trunkFor(left("w6"), right("agent"), SESSION);
    expect(t.axis).toBe("x");
    const inLeftColumn = t.at > 1430 && t.at < 1838;
    expect(inLeftColumn).toBe(false);
  });

  test("the agent reaches the shell station along a lane under itself", () => {
    const t = trunkFor(bottom("agent"), top("os-shell"), SESSION);
    expect(t.axis).toBe("y");
    // below the agent card (509) and above the OS band (1070)
    expect(t.at).toBeGreaterThan(509);
    expect(t.at).toBeLessThan(1070);
    expect(pathCost(bottom("agent"), top("os-shell"), t.at, "y", SESSION)).toBe(0);
  });

  test("a worker below the OS band does not climb back through its own card", () => {
    // The row-four worker's station rail doubles back: its bottom handle is
    // at y 2054 and the station's top handle at y 1070, so the return leg
    // runs UP past the card it just left. Its own box has to be an obstacle
    // or the climb is drawn straight through it.
    const from = bottom("w4");
    const to = top("os-shell");
    const t = trunkFor(from, to, SESSION);
    expect(t.axis).toBe("x");
    const inOwnColumn = t.at > 1430 && t.at < 1838;
    expect(inOwnColumn).toBe(false);
    expect(pathCost(from, to, t.at, "x", SESSION)).toBe(0);
  });
});

describe("what the scorer measures", () => {
  test("a turn inside a card costs the card, a turn in the gutter costs nothing", () => {
    expect(pathCost(right("w1"), left("llm"), 2100, "x", SESSION)).toBeGreaterThan(300);
    expect(pathCost(right("w1"), left("llm"), 1868, "x", SESSION)).toBe(0);
  });

  test("the cheapest turn wins even when it is not the middle of a free lane", () => {
    // A tall user card (333px) standing directly above the shell station, on
    // a four-worker map: no lane between the first worker row and the OS band
    // is clear all the way across. The free lanes are the 48px slot just
    // above the stations (which costs a whole worker card on the way down)
    // and nothing else; the answer is the position just above the second
    // worker row, which only clips the user card.
    const tallUser: RailBox[] = SESSION.map((b) => (b.id === "user" ? { ...b, h: 333 } : b)).filter(
      (b) => b.id !== "w5" && b.id !== "w6" && b.id !== "w7" && b.id !== "w8",
    );
    const from = bottom("w1");
    const to = top("os-shell");
    const t = trunkFor(from, to, tallUser, 0);
    const here = pathCost(from, to, t.at, "y", tallUser);
    // strictly better than the free-lane answer this replaced
    expect(here).toBeLessThan(pathCost(from, to, 1020, "y", tallUser));
    expect(t.at).toBeGreaterThan(500);
    expect(t.at).toBeLessThan(650);
  });
});

describe("the lane nudge", () => {
  test("separates two rails that would otherwise share a trunk", () => {
    const a = trunkFor(right("w1"), left("llm"), SESSION, -13);
    const b = trunkFor(right("w2"), left("llm"), SESSION, 13);
    expect(a.at).not.toBe(b.at);
  });

  test("is dropped rather than spent pushing a rail into a card", () => {
    // A nudge big enough to leave the 60px gutter must not be taken.
    const clean = trunkFor(right("w1"), left("llm"), SESSION, 0);
    const shoved = trunkFor(right("w1"), left("llm"), SESSION, 400);
    expect(pathCost(right("w1"), left("llm"), shoved.at, "x", SESSION)).toBe(
      pathCost(right("w1"), left("llm"), clean.at, "x", SESSION),
    );
  });
});

describe("degenerate ends", () => {
  test("two side handles closer than their own stubs turn on the other axis", () => {
    // The real one: the MCP client's right handle is 26px from the network
    // stack's left handle, so once both stubs are spent the target is
    // BEHIND the source and the helper switches to a y split. Nothing to
    // choose there — both ends sit on the same line — so it lands on the
    // shared y rather than inventing a jog.
    const from = { x: 100, y: 50, side: "r" as const };
    const to = { x: 110, y: 50, side: "l" as const };
    const t = trunkFor(from, to, SESSION);
    expect(t.axis).toBe("y");
    expect(t.at).toBe(50);
  });

  test("an empty map routes at the midpoint and costs nothing", () => {
    const t = trunkFor(right("w1"), left("llm"), []);
    expect(pathCost(right("w1"), left("llm"), t.at, "x", [])).toBe(0);
  });
});

// Card 295 gave every worker a permanent rail to every station, so main's rail
// and one rail per seated worker now arrive at the SAME station handle. Rails to
// different targets never share a handle and cannot collide; this converging set
// is the only one that can, and it is the one the lane has to separate.
describe("the lanes of the rails that converge on ONE station", () => {
  const converging = (station: string) => [
    { from: bottom("agent"), id: `e-agent-${station.replace("-", "")}`, seat: null as number | null },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
      from: bottom(`w${i}`),
      id: `e-sub-worker-${i}-${station}`,
      seat: i - 1,
    })),
  ];
  /** The deepest pile of rails sharing one trunk — 1 means every rail has its own. */
  const worstStack = (station: string, laneOf: (r: { id: string; seat: number | null }) => number) => {
    const seen = new Map<string, number>();
    for (const r of converging(station)) {
      const t = trunkFor(r.from, top(station), SESSION, laneOf(r));
      const key = `${t.axis}@${Math.round(t.at * 10) / 10}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return Math.max(...seen.values());
  };

  for (const station of ["os-disk", "os-shell", "os-mcp"]) {
    test(`${station}: nine converging rails, nine trunks — none stacked`, () => {
      expect(worstStack(station, (r) => stationLane(r.seat))).toBe(1);
    });
  }

  test("the seat beats the id hash, which cannot see the rails arriving beside it", () => {
    // Measured on this fixture: with no lane at all the nine rails share five
    // trunks at every station, and the id hash leaves os-shell exactly as bad.
    // The hash cannot do better by design — the lane it picks for one rail is
    // computed without the other eight in view.
    expect(worstStack("os-shell", () => 0)).toBe(2);
    expect(worstStack("os-shell", (r) => railLane(r.id))).toBe(2);
  });

  test("main holds the middle; the seats step outward around it", () => {
    expect(stationLane(null)).toBe(0);
    expect([0, 1, 2, 3].map((seat) => stationLane(seat))).toEqual([-5, 5, -10, 10]);
    // A rail with no seat to speak of takes the middle rather than an edge.
    expect(stationLane(-1)).toBe(0);
  });

  test("twelve seats plus main are thirteen distinct lanes, and none leaves the gutter", () => {
    const lanes = [stationLane(null), ...Array.from({ length: 12 }, (_, s) => stationLane(s))];
    expect(new Set(lanes).size).toBe(13);
    for (const l of lanes) expect(Math.abs(l)).toBeLessThanOrEqual(30);
  });
});
