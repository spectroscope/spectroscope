// Where the pane sits inside the window.
//
// The visible browser is a WebContentsView laid OVER the window's content, so
// its rectangle is in the window's content coordinates — which are the same CSS
// pixels the page's own getBoundingClientRect() reports. The web UI measures its
// placeholder and reports that rectangle; this file turns it into bounds the
// shell can trust, and it is pure so the arithmetic is testable without a
// window.
//
// The clamping is not decoration. A stale rectangle (the window shrank between
// the report and the paint), a collapsed sidebar mid-animation or a report from
// a page that has not laid out yet all produce rectangles that would put the
// pane half outside the window, where the operator cannot see the thing the
// whole card is about.

/** A rectangle in window-content CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A rectangle the PAGE measured, in the units the SHELL positions in.
 *
 * `getBoundingClientRect()` returns CSS pixels. `WebContentsView.setBounds` and
 * `BrowserWindow.getContentBounds` are in DIP. At a zoom factor of 1 those are
 * the same number, which is why the seam shipped and why nobody saw it: the
 * whole arithmetic in this file was correct for the only case anyone tested.
 *
 * MEASURED on the owner's machine, 2026-08-30. He reported a loaded page
 * rendering BESIDE its panel rather than inside it, and his app's own Chromium
 * profile carries `per_host_zoom_levels = { "127.0.0.1": 0.5 }`. Chromium's
 * factor is `1.2 ** level`, so the app was running at 1.0954 — every reported
 * coordinate landed about 9.5 % short of where the hole actually was. The error
 * grows with x, so the further right the panel sat, the further left its page
 * was painted. That is the signature in his screenshots.
 *
 * A zoom is one keystroke away (`role: "zoomIn"`, menuModel.ts:264) and
 * Chromium persists it per origin, so a single accidental Cmd+ leaves the pane
 * misplaced for every later run of the app.
 *
 * @param rect the rectangle the page reported, in CSS pixels
 * @param zoomFactor the host window's zoom factor
 * @return the same rectangle in DIP, or unchanged when the factor is not a
 *         usable number — a pane positioned at NaN is invisible with no error
 *         anywhere, which is worse than ignoring a bad reading
 */
export function toDeviceRect(rect: Rect, zoomFactor: number): Rect {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return rect;
  return {
    x: Math.round(rect.x * zoomFactor),
    y: Math.round(rect.y * zoomFactor),
    width: Math.round(rect.width * zoomFactor),
    height: Math.round(rect.height * zoomFactor),
  };
}

/** The smallest pane worth painting — below this a page cannot lay out at all. */
export const MIN_PANE = { width: 320, height: 240 };

/**
 * The bounds to give the pane.
 *
 * @param reported the rectangle the web UI measured, or null when it never reported
 * @param window   the window's own content size
 * @return bounds inside the window, never smaller than MIN_PANE
 */
export function paneBounds(reported: Rect | null, window: { width: number; height: number }): Rect {
  // Nothing reported yet: the right two-thirds under a header-height strip, which
  // is where the browser segment puts it once the page does report.
  const fallback: Rect = {
    x: Math.round(window.width / 3),
    y: 48,
    width: Math.max(MIN_PANE.width, Math.round((window.width * 2) / 3)),
    height: Math.max(MIN_PANE.height, window.height - 48),
  };
  const source = reported ?? fallback;
  const width = Math.max(MIN_PANE.width, Math.min(Math.round(source.width), window.width));
  const height = Math.max(MIN_PANE.height, Math.min(Math.round(source.height), window.height));
  const x = Math.max(0, Math.min(Math.round(source.x), window.width - width));
  const y = Math.max(0, Math.min(Math.round(source.y), window.height - height));
  return { x, y, width, height };
}

/** Whether a reported rectangle is worth acting on at all. */
export function isUsable(rect: Rect | null): rect is Rect {
  return (
    rect !== null &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    rect.width >= MIN_PANE.width &&
    rect.height >= MIN_PANE.height
  );
}
