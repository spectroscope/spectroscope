import { describe, expect, it } from "vitest";
import {
  SEAT_ROWS_COMPACT,
  SEAT_ROWS_EXPANDED,
  SEATS_MAX_COMPACT,
  SEATS_MAX_EXPANDED,
  drawnCount,
  seatGrid,
  seatOf,
  workerChip,
} from "./workerGrid";

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

  it("the chip confesses a gap and is quiet when all are drawn", () => {
    expect(workerChip(0, 0)).toBeNull();
    expect(workerChip(8, 8)).toEqual({ text: "8 spawned · all drawn", gap: false });
    expect(workerChip(14, 12)).toEqual({ text: "14 spawned · 12 drawn", gap: true });
  });
});
