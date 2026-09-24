// Card 418: how tall an open thinking body may grow. The owner's rule of
// 2026-09-24: half the chat pane's visible height, never under 240 px, which
// was the fixed ceiling before and is now the floor.
//
// A percentage max-height cannot say "half the pane": the body sits inside the
// scrolling transcript, whose content has no definite height. So the pane
// measures itself and publishes the ceiling as a custom property on its own
// element; every thinking body under it inherits the same value. Where no pane
// publishes (a Spectrum lane), chat.css declares the floor on :root.

import { useLayoutEffect, type RefObject } from "react";

/** The ceiling before card 418, kept as the floor (owner: "240 passt"). */
export const THINKING_FLOOR_PX = 240;

/** The custom property the chat pane sets and `.thinking-body` reads. */
export const THINKING_BODY_MAX_VAR = "--thinking-body-max";

/**
 * @param paneHeight the chat pane's visible height in CSS pixels
 * @return the open thinking body's max-height: half the pane, at least the floor
 */
export function thinkingCeilingPx(paneHeight: number): number {
  return Math.max(THINKING_FLOOR_PX, paneHeight / 2);
}

/** What the wiring needs of the pane, so a test can hand it a plain object. */
export interface CeilingPane {
  clientHeight: number;
  style: { setProperty(name: string, value: string): void };
}

/** What the wiring needs of a ResizeObserver. */
export interface CeilingObserver<P> {
  observe(target: P): void;
  disconnect(): void;
}

/** Sets the ceiling for the pane's current height on the pane itself. */
function publish(pane: CeilingPane): void {
  pane.style.setProperty(THINKING_BODY_MAX_VAR, `${thinkingCeilingPx(pane.clientHeight)}px`);
}

/**
 * Publishes the ceiling now, then again whenever the pane resizes. The first
 * call does not wait for the observer: a hidden window delivers no observer
 * callbacks, and the first paint has to be right anyway.
 *
 * @param pane the transcript scroller
 * @param makeObserver builds the observer, or returns null where there is none
 * @return stops observing
 */
export function watchThinkingCeiling<P extends CeilingPane>(
  pane: P,
  makeObserver: (onResize: () => void) => CeilingObserver<P> | null,
): () => void {
  publish(pane);
  const observer = makeObserver(() => publish(pane));
  if (observer === null) return () => {};
  observer.observe(pane);
  return () => observer.disconnect();
}

/**
 * The body of {@link useThinkingCeiling}'s effect: runs
 * {@link watchThinkingCeiling} on the element with the platform's
 * ResizeObserver, or with none where the platform has none.
 *
 * @param el the chat pane's transcript scroller, or null before it mounts
 * @return the cleanup that stops observing, or undefined when there is no element
 */
export function startThinkingCeiling(el: HTMLElement | null): (() => void) | undefined {
  if (el === null) return undefined;
  return watchThinkingCeiling<HTMLElement>(el, (onResize) =>
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize),
  );
}

/**
 * Runs {@link startThinkingCeiling} on the element behind `ref` and hands its
 * cleanup to React, which runs it on unmount. A layout effect, so the value is
 * set before the browser paints.
 *
 * @param ref the ref on the chat pane's transcript scroller
 */
export function useThinkingCeiling(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => startThinkingCeiling(ref.current), [ref]);
}
