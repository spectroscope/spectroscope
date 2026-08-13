// What the trace pane says out loud about its own live window (card 116).
//
// The window itself is settled: `windowTrace` (state/reducer.ts) cuts a LIVE
// stream and only that one, counts what it cut into `traceDropped`, and leaves
// the newest row's `seq` untouched — so the row left on top carries exactly
// `dropped + 1`. A finite fold (an import, an archive, a replay) is whole
// before it starts and drops nothing.
//
// What is easy to get wrong is the sentence built on top of those numbers, and
// the pane got it wrong: it counted the list it DRAWS. That list is not the
// record. `withResponseRows` splits every llm_exchange into two rows, and card
// 184 leg 3 put an llm_exchange into every live session; `voiceRows` invents
// rows the socket never sent; and TraceView prepends a synthetic system_context
// row at seq 0. Measured on a 9000-frame stream carrying four exchanges, the
// pane announced "last 5004 of 9004" for a run that streamed 9000 — a total
// that never happened, over a window that holds 5000 rows.
//
// So the arithmetic reads the RECORD and nothing else, and it carries the first
// row's seq with it, because the reader has two signals on screen and will
// check one against the other. Card 211 was this same shape: two components
// with different beliefs about one list.

import type { TraceEntry } from "../state/reducer";

/** The three numbers the pane states, plus the one the reader can verify by
 *  looking down at the first row. */
export interface TraceDisclosure {
  /** Record rows the window still holds. */
  shown: number;
  /** Rows the run produced in total: `shown + dropped`. */
  total: number;
  /** Rows the live window threw away, cumulative over the whole run. */
  dropped: number;
  /** The `seq` the record now begins at — always `dropped + 1`, and pinned
   *  against the real reducer output rather than asserted here. */
  firstSeq: number;
}

/**
 * The disclosure for a record of `record.length` rows that lost `dropped`.
 *
 * `null` means say nothing, and that is the important half: a run that never
 * reached the window has nothing to disclose, and a permanent "last 5000 of
 * 5000" would teach the reader to skip the line on the one run where it
 * matters. Silence here is the honest answer, not a missing feature.
 *
 * @param record the trace rows as the reducer holds them — NOT the pane's
 *        display list, which carries rows the run never streamed
 * @param dropped `UiState.traceDropped` of the record being shown
 */
export function traceDisclosure(record: readonly TraceEntry[], dropped: number): TraceDisclosure | null {
  if (dropped <= 0 || record.length === 0) return null;
  return {
    shown: record.length,
    total: record.length + dropped,
    dropped,
    firstSeq: record[0].seq,
  };
}
