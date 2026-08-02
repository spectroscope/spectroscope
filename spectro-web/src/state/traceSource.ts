// The imported line, attached to the trace row that came from it.
//
// Two things make this a function of its own rather than a field the reducer
// fills. First, the trace is not a fold over the stream alone: a live session's
// rows also carry the frames THIS app sent, which have no event behind them at
// all. Second, the rows and the events are different objects, and the only
// honest key between them is the payload's identity, the same idiom
// swapTracePayloads uses, and for the same reason.
//
// ORDERING IS LOAD BEARING. Attach first, against the ORIGINAL stream, then
// translate. swapTracePayloads spreads the row and replaces only its payload,
// so a field on the row survives the swap; a field on the payload would not.
// Run it the other way round and every frame silently loses its line.

import type { RunEvent } from "../events";
import type { ImportSource } from "../import/detect";

/** What the import bar states about a loaded file. */
export interface SourceStats {
  lines: number;
  frames: number;
  /** Lines that produced no frame at all. A real and sizeable part of a
   *  transcript (queue operations, attachments, hook records), and a
   *  session-level fact: it is said once, in the bar, not repeated on every
   *  frame that happens to have a line behind it. */
  zeroLines: number;
}

export function sourceStats(source: ImportSource): SourceStats {
  const used = new Set<number>();
  for (let i = 0; i < source.origin.length; i++) {
    const at = source.origin[i];
    if (at >= 0) used.add(at);
  }
  return {
    lines: source.lines.length,
    frames: source.origin.length,
    zeroLines: source.lines.length - used.size,
  };
}

/** A row that knows which line of the imported file produced it. */
export interface WithSource {
  /** Index into the import's `lines`; absent when the importer built the frame
   *  itself, and absent for every row of a session that was produced here. */
  sourceLine?: number;
}

/**
 * The rows, each carrying the line index of the event it renders.
 *
 * @param rows   the view's trace rows, in whatever order they stand
 * @param events the recorded stream those rows were built from
 * @param origin `origin[i]` for `events[i]`: a line index, or negative for a
 *               frame with no single line behind it
 * @return the rows; a row with nothing to attach is the SAME object, which is
 *         what keeps the memos downstream from re-rendering the whole trace
 */
export function attachSources<Row extends { payload: unknown }>(
  rows: readonly Row[],
  events: readonly RunEvent[],
  origin: ArrayLike<number>,
): (Row & WithSource)[] {
  const line = new Map<unknown, number>();
  // Bounded by BOTH lengths: a short origin array must not be read past its
  // end, where the read is undefined and would land on screen as a line number
  // of NaN.
  const n = Math.min(events.length, origin.length);
  for (let i = 0; i < n; i++) {
    const at = origin[i];
    if (at < 0) continue;
    if (!line.has(events[i])) line.set(events[i], at); // a repeated reference: first wins
  }
  return rows.map((row) => {
    const at = line.get(row.payload);
    return at === undefined ? row : { ...row, sourceLine: at };
  });
}

/**
 * Which row wears each line's notes.
 *
 * A record fans out: an assistant line produces a turn_start, whatever blocks
 * it carried, a usage, and a provider_info in front of them whenever the model
 * changed. All of those rows carry the same line index, and a chip on every one
 * of them would read as decoration rather than as a fact about the turn.
 *
 * The turn_start wins where there is one, because that row IS the turn the note
 * is about; otherwise the line's first frame takes it, which is where a user
 * record's reading belongs (a run_start, a tool_result, an agent_message).
 *
 * @param rows the trace rows, in the order the view holds them
 * @return line index -> the seq of the row that shows that line's notes; empty
 *         for a session with no imported source
 */
export function noteAnchors(
  rows: readonly { seq: number; type: string; sourceLine?: number }[],
): ReadonlyMap<number, number> {
  const anchor = new Map<number, number>();
  const isTurn = new Set<number>();
  for (const row of rows) {
    if (row.sourceLine === undefined) continue;
    if (row.type === "turn_start" && !isTurn.has(row.sourceLine)) {
      anchor.set(row.sourceLine, row.seq);
      isTurn.add(row.sourceLine);
    } else if (!anchor.has(row.sourceLine)) {
      anchor.set(row.sourceLine, row.seq);
    }
  }
  return anchor;
}
