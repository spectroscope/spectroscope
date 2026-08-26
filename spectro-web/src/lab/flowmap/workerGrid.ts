// The worker grid (card 287). The map used to slice the fleet at three; the
// harness runs four parallel children and more over a run, so the seats grow
// into a grid: rows first, columns as needed, the seat of worker i fixed by i
// alone (col = floor(i / rows), row = i % rows) so a card never moves once it
// is on the map — the property the single-column seating already insisted on.
//
// WHY FOUR ROWS EXPANDED. A row costs the worker envelope plus the rail gap
// of height (the pitch the expanded seating derives, subCardH + EXP_GAP); a
// column costs the painted card plus the same gap of width. Four rows is the
// best fit trade over the counts that occur (measured on a downstream
// consumer of this engine across 5–12 workers; re-measured here in the card's
// browser pass). Compact keeps three rows — its band above the OS stations is
// exactly three compact cards deep.
//
// THE CEILINGS ARE STARTING VALUES, replaced by the card's own browser
// measurement if they move: past the ceiling the map stops drawing and the
// chip confesses the gap instead — see workerChip.

export const SEAT_ROWS_EXPANDED = 4;
export const SEAT_ROWS_COMPACT = 3;
export const SEATS_MAX_EXPANDED = 12;
export const SEATS_MAX_COMPACT = 6;

export function seatOf(i: number, rows: number): { row: number; col: number } {
  return { row: i % rows, col: Math.floor(i / rows) };
}

export function seatGrid(count: number, rows: number): { rows: number; cols: number } {
  if (count <= 0) return { rows: 0, cols: 0 };
  return { rows: Math.min(rows, count), cols: Math.ceil(count / rows) };
}

export function drawnCount(spawned: number, expanded: boolean): number {
  return Math.min(spawned, expanded ? SEATS_MAX_EXPANDED : SEATS_MAX_COMPACT);
}

/** The honest chip: quiet while everything is drawn, loud about a gap. */
export function workerChip(spawned: number, drawn: number): { text: string; gap: boolean } | null {
  if (spawned <= 0) return null;
  return drawn < spawned
    ? { text: `${spawned} spawned · ${drawn} drawn`, gap: true }
    : { text: `${spawned} spawned · all drawn`, gap: false };
}
