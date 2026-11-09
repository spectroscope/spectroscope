// Card 604: the files tab's own cursor (C2). It is the tab's state and never
// the session's stepper: dragging or playing it leaves the chat, the trace and
// the lab where they are. It either follows the end of the run, so a live
// session keeps growing under it, or stands on one event the person chose.

import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import type { FileCall } from "./fold";

/** Where the cursor stands: at the end of the run, or on an event index (inclusive). */
export type Cursor = { follow: true } | { follow: false; at: number };

export const FOLLOW: Cursor = { follow: true };

/**
 * The cursor a route opens the tab with: on the route's event, or following the
 * end when there is none. The event is matched by identity, so an event of
 * another session (or an equal copy) never places it.
 */
export function initialCursor(events: readonly RunEvent[], startAt: RunEvent | null): Cursor {
  if (startAt === null) return FOLLOW;
  const at = events.indexOf(startAt);
  return at < 0 ? FOLLOW : { follow: false, at };
}

/**
 * The last event index the cursor shows; everything after it is dimmed. A
 * placed cursor keeps its index while events arrive, a following one moves
 * with the end.
 */
export function cursorLimit(cursor: Cursor, events: readonly RunEvent[]): number {
  return cursor.follow ? events.length - 1 : cursor.at;
}

/**
 * The cursor on the next (`dir` 1) or previous (`dir` -1) call of `calls` as
 * seen from `cursor`. From a call it moves to its neighbour, from between two
 * calls to the nearest one in that direction. At either end it stays, and the
 * same cursor object comes back.
 *
 * @param calls the calls to step through, in event order (the agent chips' choice)
 */
export function stepCall(
  calls: readonly FileCall[],
  cursor: Cursor,
  events: readonly RunEvent[],
  dir: -1 | 1,
): Cursor {
  const from = cursorLimit(cursor, events);
  // The first call after `from`, by bisection over the call indexes.
  let lo = 0;
  let hi = calls.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (calls[mid].callIndex <= from) lo = mid + 1;
    else hi = mid;
  }
  const target =
    dir === 1 ? calls[lo] : lo > 0 && calls[lo - 1].callIndex === from ? calls[lo - 2] : calls[lo - 1];
  return target === undefined ? cursor : { follow: false, at: target.callIndex };
}

/**
 * When a call ran, as the tab prints it: seconds from the start of the run, or
 * the call's number when the recording has no clock for it (C12).
 *
 * @param seconds the call's `t`
 * @param ordinal the call's 1-based number in the ledger
 */
export function whenLabel(lang: Lang, seconds: number | null, ordinal: number): string {
  if (seconds === null) return t(lang, "filesTab.callNumber", { n: ordinal });
  const s = seconds.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return t(lang, "filesTab.seconds", { s });
}
