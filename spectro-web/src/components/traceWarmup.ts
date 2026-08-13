// Building the trace while the reader is elsewhere — card 175.
//
// The owner's instruction was two sentences in one: every row stays, and the
// cost moves off the tab press onto a wait the reader is already in. The second
// half has a trap the card named itself, and the August build walked into it:
// mounting the trace TOGETHER with the chat does not move the cost, it moves the
// delay onto the chat. Measured on the 9,319-row session
// `20260805-155913-624f5baf`, first blocked task of opening it, four runs each:
//
//     trace mounted beside the chat   563 · 601 · 621 · 637 ms
//     trace absent while chat shows   361 · 367 · 412 · 481 ms
//
// Roughly 220 ms, paid on the critical path of the view the reader is actually
// on, every time a session opens. So the mount waits: the chat paints, the
// browser goes idle, and only then does the trace build itself in the
// background. Pressing the tab never waits for this — a press mounts the view
// on the spot, exactly as it did before the warm-up existed.
//
// Deliberately NOT a React transition. A transition lowers the priority of work
// React is already doing in the same commit; this needs the work to happen in a
// LATER task altogether, after the browser has painted and has nothing else to
// do. `requestIdleCallback` is that promise; a transition is not.

import { useEffect, useState } from "react";

/**
 * The scheduling calls this module needs, as a seam.
 *
 * Injected rather than reached for on `window`, because the whole behaviour is
 * about which channel gets used and when — and a test that called the real
 * `requestIdleCallback` would only prove the test runner has one.
 * `requestIdleCallback` is optional on purpose: WebKit was without it for years,
 * and a warm-up that silently never happens on one engine is worse than a timer.
 */
export interface WarmHost {
  requestIdleCallback?: (task: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (task: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/**
 * How long a page may stay busy before the warm-up happens anyway.
 *
 * A live run can hold the main thread for as long as it streams, and an idle
 * callback with no deadline would simply never arrive — leaving the press to pay
 * the full mount. That is no worse than before this card, but it is not the fix
 * either. Two seconds is a floor under the guarantee rather than a schedule: on
 * every resting page the callback comes far sooner, in the gap right after the
 * chat has painted.
 */
export const WARM_DEADLINE_MS = 2000;

/**
 * Run {@code task} once the browser has nothing better to do.
 *
 * Never synchronously — that is the one property the caller is buying.
 *
 * @param task what to do when the page is idle
 * @param host the scheduling calls to use
 * @return a cancel function; after it runs, {@code task} never will
 */
export function scheduleWarm(task: () => void, host: WarmHost): () => void {
  let live = true;
  // The guard belongs here rather than in the cancel path: `cancelIdleCallback`
  // is best-effort in every engine, and a callback already handed to the event
  // loop cannot be taken back. A reader clicking through four sessions in a
  // second must build one trace, not four.
  const run = (): void => {
    if (live) task();
  };
  const idle = host.requestIdleCallback;
  if (idle !== undefined) {
    const id = idle.call(host, run, { timeout: WARM_DEADLINE_MS });
    return () => {
      live = false;
      host.cancelIdleCallback?.call(host, id);
    };
  }
  const id = host.setTimeout(run, WARM_DEADLINE_MS);
  return () => {
    live = false;
    host.clearTimeout(id);
  };
}

/** What has been warmed, or {@code null} while nothing has. */
type Warmed = { readonly record: string | null } | null;

/**
 * Whether the trace for {@code record} may be built yet.
 *
 * False on the render where the record arrives, true once the browser has been
 * idle since. Keyed on the record rather than armed once for the app's life,
 * because the cost is paid per record: every session opened folds a new stream
 * and builds new rows, so a gate that only covered the first session would leave
 * the second one paying on the chat's critical path again.
 *
 * The reader who switches sessions quickly warms only the record they land on:
 * the effect's cleanup cancels the one before it.
 *
 * @param record the session on screen, or null when there is none
 */
export function useTraceWarm(record: string | null): boolean {
  const [warmed, setWarmed] = useState<Warmed>(null);
  useEffect(() => scheduleWarm(() => setWarmed({ record }), window), [record]);
  return warmed !== null && warmed.record === record;
}
