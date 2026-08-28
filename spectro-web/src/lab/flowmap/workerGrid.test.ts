import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import {
  SEAT_ROWS_COMPACT,
  SEAT_ROWS_EXPANDED,
  SEATS_MAX_COMPACT,
  SEATS_MAX_EXPANDED,
  drawnCount,
  foldSeatPool,
  rowsFor,
  seatGrid,
  seatOf,
  workerChip,
} from "./workerGrid";

const T = 1700000000000;
const start: RunEvent = {
  type: "run_start",
  runId: "r1",
  agentId: "main",
  prompt: "go",
  ts: T,
} as RunEvent;
const spawn = (id: string): RunEvent =>
  ({ type: "agent_spawn", agentId: id, parentId: "main", task: `t-${id}`, ts: T }) as RunEvent;
const result = (id: string, state = "completed"): RunEvent =>
  ({ type: "agent_message", from: id, to: "main", role: "result", state, text: "", ts: T }) as RunEvent;
const task = (id: string): RunEvent =>
  ({ type: "agent_message", from: "main", to: id, role: "task", text: `t-${id}`, ts: T }) as RunEvent;
const status = (id: string): RunEvent =>
  ({ type: "agent_message", from: id, to: "main", role: "status", text: "…", ts: T }) as RunEvent;

describe("workerGrid", () => {
  it("seats by column-of-rows, fixed by index alone — a card never moves", () => {
    expect(seatOf(0, 4)).toEqual({ row: 0, col: 0 });
    expect(seatOf(3, 4)).toEqual({ row: 3, col: 0 });
    expect(seatOf(4, 4)).toEqual({ row: 0, col: 1 });
    expect(seatOf(11, 4)).toEqual({ row: 3, col: 2 });
  });

  it("eight workers are a 4x2 grid expanded — the owner's acceptance floor", () => {
    expect(seatGrid(8, SEAT_ROWS_EXPANDED)).toEqual({ rows: 4, cols: 2 });
  });

  it("compact runs three rows deep", () => {
    expect(seatGrid(6, SEAT_ROWS_COMPACT)).toEqual({ rows: 3, cols: 2 });
    expect(seatGrid(2, SEAT_ROWS_COMPACT)).toEqual({ rows: 2, cols: 1 });
  });

  it("draws at most the mode's ceiling", () => {
    expect(drawnCount(14, true)).toBe(SEATS_MAX_EXPANDED);
    expect(drawnCount(14, false)).toBe(SEATS_MAX_COMPACT);
    expect(drawnCount(2, true)).toBe(2);
  });

  // Card 292, C1: the seat pool. Seats say what was CONCURRENT, not how many
  // children the run ever had — 9 children with a peak of 5 get 5 seats.
  describe("foldSeatPool", () => {
    it("a child takes the lowest free seat on first appearance", () => {
      const p = foldSeatPool([start, spawn("a"), spawn("b"), spawn("c")]);
      expect(p.seat).toEqual({ a: 0, b: 1, c: 2 });
      expect(p.occupant).toEqual(["a", "b", "c"]);
    });

    it("frees the seat on end, and a later child reuses the lowest freed seat", () => {
      const p = foldSeatPool([
        start,
        spawn("a"),
        spawn("b"),
        spawn("c"),
        result("b"),
        result("a", "failed"),
        spawn("d"),
        spawn("e"),
      ]);
      // a and b ended; d takes a's seat (lowest freed), e takes b's.
      expect(p.seat).toEqual({ a: 0, b: 1, c: 2, d: 0, e: 1 });
      expect(p.occupant).toEqual(["d", "e", "c"]);
    });

    it("seat count is the peak concurrency of the prefix, not the lifetime count", () => {
      // 9 children, but never more than 3 alive at once → 3 seats.
      const events: RunEvent[] = [start];
      for (let i = 0; i < 9; i++) {
        events.push(spawn(`w${i}`));
        if (i >= 2) events.push(result(`w${i - 2}`));
      }
      const p = foldSeatPool(events);
      expect(p.occupant).toHaveLength(3);
      expect(p.total).toBe(9);
      expect(p.live).toBe(2); // w7 and w8 still run at the cursor
    });

    it("a seated child KEEPS its seat while it lives — extending the prefix never moves it", () => {
      const prefix: RunEvent[] = [start, spawn("a"), spawn("b")];
      const before = foldSeatPool(prefix);
      const after = foldSeatPool([...prefix, result("a"), spawn("c"), spawn("d")]);
      // b lives across the whole run: its seat is the same in every prefix.
      expect(after.seat["b"]).toBe(before.seat["b"]);
    });

    it("is deterministic over the prefix — the same events fold to the same seating, twice", () => {
      const events: RunEvent[] = [start, spawn("a"), spawn("b"), result("a"), spawn("c"), result("c")];
      expect(foldSeatPool(events)).toEqual(foldSeatPool(events));
    });

    it("counts live at the cursor and total over the run", () => {
      const p = foldSeatPool([start, spawn("a"), spawn("b"), spawn("c"), result("a")]);
      expect(p.live).toBe(2);
      expect(p.total).toBe(3);
    });

    it("the root run ending retires the pool; a child's run_end does not", () => {
      const childEnd: RunEvent = { type: "run_end", runId: "rc", stopReason: "end_turn", ts: T } as RunEvent;
      const kept = foldSeatPool([start, spawn("a"), childEnd]);
      expect(kept.occupant).toEqual(["a"]);
      const rootEnd: RunEvent = { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T } as RunEvent;
      const gone = foldSeatPool([start, spawn("a"), rootEnd]);
      expect(gone.occupant).toEqual([]);
      expect(gone.total).toBe(0);
    });

    it("a child's OWN run_end frees its seat — the merged sidecar carries one (card 291)", () => {
      // The re-keyed sidecar ends with run_end `cc-<child id>`. Before the
      // repair only a result message ended a child, so a merged child whose
      // Task result never came back sat live forever. The pool learns the
      // child's runId from its run_start and ends it on that run's end; the
      // unmapped-runId case above stays exactly as it is.
      const childStart: RunEvent = {
        type: "run_start",
        runId: "cc-a",
        agentId: "a",
        parentId: "main",
        prompt: "subtask",
        ts: T,
      } as RunEvent;
      const childEnd: RunEvent = { type: "run_end", runId: "cc-a", stopReason: "end_turn", ts: T } as RunEvent;
      const p = foldSeatPool([start, spawn("a"), childStart, childEnd]);
      expect(p.live).toBe(0);
      expect(p.total).toBe(1);
      // The seat itself is kept for reuse, exactly like a result-message end.
      expect(p.occupant).toEqual(["a"]);
    });

    it("a child that only ever speaks through its own events still gets a seat", () => {
      // No agent_spawn: the child appears the way labScene folds it — via any
      // event that carries its agentId.
      const p = foldSeatPool([
        start,
        { type: "thinking_delta", agentId: "w1", text: "…", ts: T } as RunEvent,
      ]);
      expect(p.seat).toEqual({ w1: 0 });
      expect(p.live).toBe(1);
    });

    it("a child announced only by a task message is seated — the pool filter would hide it otherwise", () => {
      // sceneToFlow's pool path draws only children with a seat; advanceScene
      // creates a card for a task message, so the pool must admit it too.
      const p = foldSeatPool([start, task("x")]);
      expect(p.seat).toEqual({ x: 0 });
      expect(p.live).toBe(1);
    });

    it("a child announced only by a status message is seated — same filter, other direction", () => {
      const p = foldSeatPool([start, status("y")]);
      expect(p.seat).toEqual({ y: 0 });
      expect(p.live).toBe(1);
    });

    it("a revived child still shown on its old seat KEEPS it — revival never jumps", () => {
      // a=seat0 and b=seat1 both ended, both still shown; a status event
      // revives b. Seat 0 is free (a ended too), so without the keep-branch
      // b would jump there — the exact no-jumping property the pool claims.
      const p = foldSeatPool([start, spawn("a"), spawn("b"), result("a"), result("b"), status("b")]);
      expect(p.seat["b"]).toBe(1);
      expect(p.occupant).toEqual(["a", "b"]);
      expect(p.live).toBe(1);
    });

    it("a second root run_start restarts the pool — no seats carried across runs", () => {
      // advanceScene returns initialScene() on every root run_start; the fold
      // mirrors that, so a restarted run must not inherit the previous seating.
      const start2: RunEvent = {
        type: "run_start",
        runId: "r2",
        agentId: "main",
        prompt: "again",
        ts: T,
      } as RunEvent;
      const p = foldSeatPool([start, spawn("a"), start2, spawn("b")]);
      expect(p.occupant).toEqual(["b"]);
      expect(p.total).toBe(1);
      expect(p.live).toBe(1);
    });
  });

  // Card 292, C2: expanded rows derive from the seat count and the pane's
  // aspect, so the grid fills the space it has instead of stacking four deep
  // into a world twice as tall as the pane.
  describe("rowsFor", () => {
    it("a 16:9 pane spreads the grid wide instead of four deep", () => {
      // Measured against the world model: at aspect 16/9 four seats fit best
      // as 2x2 (fit 0.525 on a 1600x900 pane) — four deep gave 0.356.
      expect(rowsFor(4, 16 / 9)).toBe(2);
      expect(rowsFor(8, 16 / 9)).toBe(3);
      expect(rowsFor(1, 16 / 9)).toBe(1);
    });

    it("a tall pane stacks deeper than a wide one", () => {
      expect(rowsFor(8, 0.6)).toBeGreaterThan(rowsFor(8, 16 / 9));
    });

    it("with no measurement it falls back to today's constant — the hidden-pane trap", () => {
      // A hidden pane delivers no frames and no ResizeObserver: no aspect ever
      // arrives, and nothing may break headless or in tests.
      expect(rowsFor(8, null)).toBe(SEAT_ROWS_EXPANDED);
      expect(rowsFor(8, undefined)).toBe(SEAT_ROWS_EXPANDED);
      expect(rowsFor(8, 0)).toBe(SEAT_ROWS_EXPANDED);
      expect(rowsFor(8, Number.NaN)).toBe(SEAT_ROWS_EXPANDED);
      expect(rowsFor(0, 16 / 9)).toBe(SEAT_ROWS_EXPANDED);
    });
  });

  // Card 292: the chip states the LIVE count at the cursor and the run total —
  // under the pool, "spawned" alone would hide that most of them already ended.
  // Pinned on the exact values in both locales, never on prose fragments.
  it("the chip states live at the cursor and the total over the run, EN and DE", () => {
    const events: RunEvent[] = [start];
    for (let i = 0; i < 9; i++) {
      events.push(spawn(`w${i}`));
      if (i >= 2) events.push(result(`w${i - 2}`));
    }
    const p = foldSeatPool(events); // live 2, total 9, seats 3
    expect(workerChip(p, p.occupant.length, "en")).toEqual({
      text: "2 active · 9 over the run",
      gap: false,
    });
    expect(workerChip(p, p.occupant.length, "de")).toEqual({
      text: "2 aktiv · 9 im Lauf",
      gap: false,
    });
  });

  it("the chip confesses a gap with the drawn number, and is silent with no children", () => {
    const p = foldSeatPool([start, ...Array.from({ length: 14 }, (_, i) => spawn(`w${i}`))]);
    expect(workerChip(p, 12, "en")).toEqual({
      text: "14 active · 14 over the run · 12 drawn",
      gap: true,
    });
    expect(workerChip(p, 12, "de")).toEqual({
      text: "14 aktiv · 14 im Lauf · 12 gezeichnet",
      gap: true,
    });
    expect(workerChip(foldSeatPool([start]), 0, "en")).toBeNull();
  });
});
