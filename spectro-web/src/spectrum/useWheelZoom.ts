// The wheel gesture, on any surface that shows the window.
//
// It lived inside SpectrumBand, so ⌘+wheel zoomed while the pointer was over a
// LANE and did nothing at all over the strip and the rail above it — the one
// place a reader points at when he wants to zoom, because it is the surface
// that draws the window. Owner, 2026-08-05: "das cmd scrollrad geht auf dem
// agents hover aber nicht auf dem zoom interface hover".
//
// One hook, so the two surfaces cannot drift into two gestures. The arithmetic
// stays in gestures.ts, which is pure and pinned; this is the DOM half and
// nothing else.
//
// A manual, non-passive listener is not tidiness. React's `onWheel` cannot
// promise one, and a passive listener cannot `preventDefault`, so ⌘+wheel would
// zoom the band AND the browser at the same time.

import { useEffect, useRef, type RefObject } from "react";
import { applyIntent, wheelToIntent } from "./gestures";
import type { LaneTick } from "./spectrumModel";
import type { Window } from "./viewport";

/** What the surface needs to turn a wheel event into a new window. */
export interface WheelZoom {
  win: Window;
  minW: number;
  ticks: readonly LaneTick[];
  /** Absent means the surface is not zoomable right now; the wheel is left alone. */
  onWindow?: (next: Window) => void;
  /**
   * Where the pointer is, and how wide the drawable area is, in the SAME units
   * the browser reports the deltas in.
   *
   * One space: the two deltas are weighed against each other to settle which
   * axis owns the gesture, so a caller that scales one of them into a drawing's
   * own coordinates makes the verdict a function of how wide that drawing
   * happens to be rendered — a swipe that pans on one screen and scrolls on
   * another. The anchor may be in the drawing's units, because it is a position
   * rather than a comparison; `innerWidthPx` says which width goes with it.
   */
  measure: (
    event: WheelEvent,
    rect: DOMRect,
  ) => { anchorPx: number; widthPx: number; innerWidthPx: number } | null;
}

/**
 * Binds the wheel gesture to an element for as long as it is mounted.
 *
 * @param ref the element the pointer has to be over
 * @param zoom what to do with a wheel event; read through a ref so the listener
 *             binds ONCE — rebinding a non-passive listener on every window
 *             change drops events mid-gesture, which reads as the zoom stuttering
 */
export function useWheelZoom(ref: RefObject<HTMLElement | null>, zoom: WheelZoom): void {
  const latest = useRef(zoom);
  latest.current = zoom;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const now = latest.current;
      if (!now.onWindow) return;
      const rect = el.getBoundingClientRect();
      const at = now.measure(e, rect);
      if (at === null) return;
      // A trackpad pinch arrives as a wheel with a synthetic ctrlKey; meta is
      // the same intent on a mouse. A plain vertical wheel is left alone so the
      // page can still scroll past twenty lanes.
      const intent = wheelToIntent(e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, at.innerWidthPx);
      if (intent === null) return;
      e.preventDefault();
      now.onWindow(
        applyIntent(now.win, intent, {
          anchorPx: at.anchorPx,
          widthPx: at.widthPx,
          minW: now.minW,
          ticks: now.ticks,
        }),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
