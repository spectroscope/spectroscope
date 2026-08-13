// Building the trace while the reader is elsewhere — card 175.
//
// The owner's instruction was two sentences in one: every row stays, and the
// cost moves off the tab press onto a wait the reader is already in. The second
// half has a trap the card named itself, and the August build walked into it:
// mounting the trace TOGETHER with the chat does not move the cost, it moves the
// delay onto the chat. So the mount waits — the chat renders, the browser goes
// idle, and only then does the trace build itself. Pressing the tab never waits
// for this: a press mounts the view on the spot, exactly as it did before the
// warm-up existed.
//
// WHAT IS CLAIMED HERE, AND WHAT IS NOT. The structural claim is measured and
// reproduces on two machines: zero trace rows in the DOM while the chat's own
// render pass runs, and the full window there once the browser has been idle.
// A LATENCY claim was made here on 2026-08-13 — 611 ms against 362 ms for the
// first blocked task of opening a session — and it is WITHDRAWN: an independent
// re-run on the same commit, with its own jars, came out flat (413 vs 417 ms),
// and the deferred build shows up as a long task of its own, so the total
// blocked time across the open is higher rather than lower. What this module
// buys is WHERE the work lands, not how much of it there is. See the card.
//
// Deliberately NOT a React transition. A transition lowers the priority of work
// React is already doing in the same commit; this needs the work to happen in a
// LATER task altogether, after the browser has rendered the view the reader
// asked for. `requestIdleCallback` is that promise; a transition is not.

import { useEffect, useRef, useState } from "react";

/**
 * The scheduling calls this module needs, as a seam.
 *
 * Injected rather than reached for on `window`, because the whole behaviour is
 * about which channel gets used and when — and a test that called the real
 * `requestIdleCallback` would only prove the test runner has one.
 * `requestIdleCallback` is optional on purpose: WebKit was without it for years,
 * and a warm-up that silently never happens on one engine is worse than a timer.
 *
 * The `IdleDeadline` the browser passes is deliberately dropped: the task is one
 * React commit that mounts a view, and a commit cannot be stopped halfway to
 * check `timeRemaining()`. Measured, it can hold the thread for a few hundred
 * milliseconds. "Idle" here means WHEN the work starts, never how long it runs.
 */
export interface WarmHost {
  requestIdleCallback?: (task: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (task: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/**
 * The React calls the gate below needs, as a seam — the same trick as `WarmHost`
 * and for a sharper reason.
 *
 * What the gate is about is a SEQUENCE of renders: a record arrives, the browser
 * goes idle, the reader flips back to the record they were comparing against.
 * This project's vitest has no DOM to drive that in, and the one rendering road
 * it does have (`react-dom/server`, used by the stategraph tests) never runs an
 * effect. Injecting the three calls lets a test drive the code that ships
 * instead of restating its rule in prose — which is exactly how the first build
 * of this hook shipped with the rule inverted and 3,710 tests green.
 */
export interface WarmReact {
  useRef: <T>(initial: T) => { current: T };
  useState: <T>(initial: T) => [T, (next: T) => void];
  useEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) => void;
}

/** The real React, as a {@link WarmReact}. */
const REACT: WarmReact = { useRef, useState, useEffect };

/**
 * How long a page may stay busy before the warm-up happens anyway.
 *
 * A live run can hold the main thread for as long as it streams, and an idle
 * callback with no deadline would simply never arrive — leaving the press to pay
 * the full mount. That is no worse than before this card, but it is not the fix
 * either. Two seconds is a floor under the guarantee rather than a schedule: on
 * every resting page the callback comes far sooner, in the gap right after the
 * view the reader asked for has rendered.
 */
export const WARM_DEADLINE_MS = 2000;

/**
 * Run {@code task} in a later task of the event loop, once the browser has a gap.
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

/**
 * One record landing on a surface that could show its trace.
 *
 * Identity is the arrival, not the record: the same session opened twice is two
 * arrivals, because the second open fetches the events again and folds the whole
 * trace again. That is a build, and a build must not land in the render pass of
 * the view the reader is on.
 */
export interface Arrival {
  readonly record: unknown;
  readonly eligible: boolean;
}

/** Before anything has landed. Never eligible, so nothing warms for it. */
export const NOTHING_ON_SCREEN: Arrival = { record: null, eligible: false };

/**
 * The arrival on screen now, given the one the previous render saw.
 *
 * The same arrival while nothing has changed, and a NEW one otherwise —
 * including for a record that was on screen before and is on screen again. The
 * first build of this hook compared the record's NAME against the last record it
 * had warmed, which answers "warm" the instant a reader flips back to the run
 * they were comparing against: the most ordinary gesture there is, and the one
 * that put the whole 9,320-row build back into the chat's own render pass.
 *
 * @param previous what the previous render saw
 * @param record what is on screen now
 * @param eligible whether this surface can show a trace at all
 * @return {@code previous} when nothing moved, a fresh arrival otherwise
 */
export function arrivalOf(previous: Arrival, record: unknown, eligible: boolean): Arrival {
  return Object.is(previous.record, record) && previous.eligible === eligible
    ? previous
    : { record, eligible };
}

/**
 * Whether the trace for what is on screen may be built yet — the gate itself,
 * with React handed in.
 *
 * False on the render where a record arrives, true once the browser has been
 * idle since. The reset is render-synchronous and has to be: an effect would
 * clear the flag one render too late, and that one render is the render this
 * card exists to keep the build out of.
 *
 * @param record what is on screen — the record LOADED, not its name
 * @param eligible whether this surface could show a trace at all
 * @param react the React calls to use
 * @param host the scheduling calls to use
 * @return whether the trace may be built now
 */
export function traceWarmGate(record: unknown, eligible: boolean, react: WarmReact, host: WarmHost): boolean {
  const seen = react.useRef<Arrival>(NOTHING_ON_SCREEN);
  seen.current = arrivalOf(seen.current, record, eligible);
  const here = seen.current;
  const [warmed, setWarmed] = react.useState<Arrival | null>(null);
  react.useEffect(() => {
    if (!here.eligible) return undefined;
    return scheduleWarm(() => setWarmed(here), host);
  }, [here, host, setWarmed]);
  // Identity, so nothing but the warm-up armed for THIS arrival can answer for
  // it. A record the reader left and came back to is a different arrival.
  return warmed === here;
}

/**
 * Whether the trace for the record on screen may be built yet.
 *
 * The reader who switches sessions quickly warms only the record they land on:
 * the effect's cleanup cancels the one before it.
 *
 * @param record the record on screen — the loaded record itself, so that
 *   re-opening the session already shown counts as a record arriving, which is
 *   what it is
 * @param eligible whether this surface could show a trace at all: not inside a
 *   fleet, whose trace is a second mount site folding the fleet's own events
 * @return whether the trace may be built now
 */
export function useTraceWarm(record: unknown, eligible: boolean): boolean {
  return traceWarmGate(record, eligible, REACT, window);
}
