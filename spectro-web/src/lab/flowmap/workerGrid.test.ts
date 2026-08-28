import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import {
  SEAT_ROWS_COMPACT,
  SEAT_ROWS_EXPANDED,
  SEATS_MAX_COMPACT,
  SEATS_MAX_EXPANDED,
  drawnCount,
  foldSeatPool,
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
