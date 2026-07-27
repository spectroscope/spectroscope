// What "search" means in a table.
//
// The trace is not prose, it is rows, so the HIT IS THE ROW: a match marks the
// whole row and stepping walks from row to row. Highlighting a few characters
// inside an ellipsized mono cell would point at something the reader mostly
// cannot see anyway.
//
// The rule, in one sentence: a row matches when the WORDS IT PRINTS contain the
// query — proto, host, model, agent, type, summary, minus any column that is
// switched off. Two deliberate exclusions:
//
//   · the number columns (#, time, Δt) — they are addresses, not content, and
//     searching them would make "1" match nearly every row. The scrubber and
//     the chain chips are how you address a frame.
//   · the payload behind the row — that is the FILTER box's job (it looks into
//     the frame and narrows the table). Search reads the table you are looking
//     at; the two compose, filter first and search the rest.
//
// Filters win over search, because a marked row you cannot see is a lie: only
// rows currently on screen become hits. The ones a filter is hiding are counted
// separately so the readout can say so out loud instead of reporting a quiet 0.

import type { TraceColumns } from "../state/traceColumns";

/** The text cells of one trace row, as the row prints them. */
export interface TraceRowCells {
  proto: string;
  host: string;
  /** Absent outside runs — an empty model cell is nothing to search. */
  model?: string;
  /** Absent for frames that belong to no agent (decisions, run ends). */
  agentId?: string;
  type: string;
  summary: string;
}

/**
 * The searchable text of one row, left to right in column order — so a query
 * that spans two neighbouring cells ("api.anthropic.com tool_call") still
 * reads the way the row does.
 *
 * @param cells the row's text cells
 * @param cols  which optional columns are showing; a hidden one is not searched
 * @return the row's words, single-spaced
 */
export function traceRowText(cells: TraceRowCells, cols: TraceColumns): string {
  const parts: string[] = [cells.proto];
  if (cols.host) parts.push(cells.host);
  if (cols.model && cells.model !== undefined && cells.model !== "") parts.push(cells.model);
  if (cells.agentId !== undefined && cells.agentId !== "") parts.push(cells.agentId);
  parts.push(cells.type, cells.summary);
  return parts.join(" ");
}

/** One row as search sees it: its text and whether the filters let it through. */
export interface TraceHitRow {
  seq: number;
  text: string;
  shown: boolean;
}

export interface TraceHits {
  /** The hits to step through, in row order — visible rows only. */
  seqs: number[];
  /** Matches a filter is currently hiding. Reported, never silently dropped. */
  hidden: number;
}

/**
 * Walk every row once and split the matches into the ones on screen and the
 * ones a filter is hiding. Matching follows findRanges: literal (never a
 * pattern), case-insensitive, and a whitespace-only query matches nothing.
 *
 * One pass, so a query change costs O(rows) and a re-render costs nothing.
 *
 * @param rows  every row of the stream, in display order
 * @param query the needle, trimmed before use
 * @return the visible hits plus how many the filters swallowed
 */
export function traceHits(rows: readonly TraceHitRow[], query: string): TraceHits {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { seqs: [], hidden: 0 };
  const seqs: number[] = [];
  let hidden = 0;
  for (const row of rows) {
    if (!row.text.toLowerCase().includes(needle)) continue;
    if (row.shown) seqs.push(row.seq);
    else hidden += 1;
  }
  return { seqs, hidden };
}
