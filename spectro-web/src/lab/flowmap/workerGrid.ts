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

import type { RunEvent } from "../../events";
import { t, type Lang } from "../../i18n/i18n";

export const SEAT_ROWS_EXPANDED = 4;
export const SEAT_ROWS_COMPACT = 3;
export const SEATS_MAX_EXPANDED = 12;
export const SEATS_MAX_COMPACT = 6;

// ---------------------------------------------------------------------------
// The seat pool (card 292). Seats used to be lifetime-indexed — worker i sat at
// seat i, so a run that spawned nine children one after another drew nine
// seats, a HISTORY drawn as a present state. The pool folds the events instead:
// a child takes the lowest free seat on first appearance, keeps it while it
// lives (card 287's no-jumping property, now pinned at the seat), frees it when
// it ends, and a later child may reuse it. The seat count at any cursor is the
// peak concurrency of the prefix — what was actually parallel.
//
// The fold is pure and deterministic over the applied prefix; scrubbing
// backwards re-folds from the start, so the same prefix always seats the same.
// Its child-lifecycle rules mirror labScene's advanceScene: a child appears via
// agent_spawn, an agent_message naming it, or any event carrying its agentId;
// only an agent_message result ends it; only the ROOT run ending retires all.
// ---------------------------------------------------------------------------

export interface SeatPool {
  /** Seat index per child id — every child the prefix ever seated, kept after
   *  it ends so its card can stay in the seat until a later child takes it. */
  seat: Record<string, number>;
  /** The child each seat currently shows (its last assignee). The length IS the
   *  seat count: the peak concurrency of the prefix. */
  occupant: string[];
  /** Children alive at the cursor. */
  live: number;
  /** Distinct children over the whole prefix. */
  total: number;
}

const MAIN = "main";

export function foldSeatPool(events: readonly RunEvent[]): SeatPool {
  let seat: Record<string, number> = {};
  let occupant: string[] = [];
  const alive = new Set<string>();
  let rootRunId: string | null = null;
  const reset = () => {
    seat = {};
    occupant = [];
    alive.clear();
  };
  const admit = (id: string) => {
    if (alive.has(id)) return;
    let s: number;
    if (seat[id] !== undefined && occupant[seat[id]] === id) {
      // A child revived while still shown on its old seat keeps it — no jump.
      s = seat[id];
    } else {
      s = occupant.findIndex((o) => !alive.has(o));
      if (s < 0) s = occupant.length;
      seat[id] = s;
      occupant[s] = id;
    }
    alive.add(id);
  };
  for (const e of events) {
    switch (e.type) {
      case "run_start":
        if (e.agentId === MAIN) {
          // Only the ROOT run_start resets — a child's carries its own id.
          reset();
          rootRunId = e.runId;
        } else {
          admit(e.agentId);
        }
        break;
      case "run_end":
        // Mirrors advanceScene: a CHILD's run_end (different runId) must not
        // retire the pool — only the root run ending clears the map.
        if (rootRunId === null || e.runId === rootRunId) {
          reset();
          rootRunId = null;
        }
        break;
      case "agent_spawn":
        admit(e.agentId);
        break;
      case "agent_message":
        if (e.role === "task") admit(e.to);
        else if (e.role === "status") admit(e.from);
        else if (e.role === "result") {
          admit(e.from); // a result for an unseen child appears and ends at once
          alive.delete(e.from);
        }
        break;
      default: {
        const a = "agentId" in e && typeof e.agentId === "string" ? e.agentId : null;
        if (a !== null && a !== MAIN) admit(a);
      }
    }
  }
  return { seat, occupant: [...occupant], live: alive.size, total: Object.keys(seat).length };
}

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

/**
 * The honest chip (card 292): it states the LIVE count at the cursor and the
 * total over the run — under the pool, a bare "spawned" would hide that most
 * of those children already ended. Loud about a gap: when the ceiling kept
 * seats undrawn, the drawn number joins the confession.
 */
export function workerChip(
  pool: SeatPool,
  drawn: number,
  lang: Lang,
): { text: string; gap: boolean } | null {
  if (pool.total <= 0) return null;
  const vars = { live: pool.live, total: pool.total, drawn };
  return drawn < pool.occupant.length
    ? { text: t(lang, "map.chip.workersGap", vars), gap: true }
    : { text: t(lang, "map.chip.workers", vars), gap: false };
}
