// Wheel and keyboard, mapped to viewport intents. Pure: no DOM, no React.
//
// The component that uses this reads three numbers off an event and hands them
// over. That is deliberate rather than tidy. There is no DOM in this project's
// test setup, so any arithmetic that lives in a .tsx is arithmetic nothing can
// pin, and this is exactly the arithmetic that gets a gesture subtly wrong.
//
// Two collisions are settled here, in code rather than in a comment:
//   - the band already owns the bare arrow keys for its per-event scrub, so the
//     viewport may only have them with shift held.
//   - the page already owns the vertical wheel for scrolling a list of lanes, so
//     a plain vertical wheel is not ours to take.

import { pageNext, pagePrev } from "./laneSlice";
import type { LaneTick } from "./spectrumModel";
import { fit, fromScreen, normalize, panBy, zoomAt, type Window } from "./viewport";

export type Intent =
  | { kind: "zoom"; factor: number }
  /** Positive moves the window later. Measured in VISIBLE WINDOWS, not pixels
   *  and not span fractions: it is the only frame in which a pan composes with
   *  a zoom, so the same gesture covers less time the deeper you are. */
  | { kind: "pan"; byWindows: number }
  | { kind: "fit" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "page"; dir: 1 | -1 };

/** How far a wheel notch bends the zoom. Exponential so that a slow trackpad
 *  and a coarse mouse wheel both feel proportional rather than one of them
 *  jumping a decade per notch. */
const WHEEL_ZOOM = 0.0035;
const WHEEL_ZOOM_MIN = 0.1;
const WHEEL_ZOOM_MAX = 10;
/** A shift+arrow press: a quarter window, so four presses turn the page. */
const KEY_PAN = 0.25;
const KEY_ZOOM_IN = 0.5;
const KEY_ZOOM_OUT = 2;

/** A wheel event, classified.
 *
 *  A trackpad pinch arrives as a wheel event with a synthetic `ctrlKey`, so
 *  pinch and ctrl+wheel are one gesture and need no second handler. Null means
 *  "not ours": the caller must then leave the event alone so the page scrolls. */
export function wheelToIntent(
  deltaX: number,
  deltaY: number,
  ctrlKey: boolean,
  widthPx: number,
): Intent | null {
  if (ctrlKey) {
    const dy = Number.isFinite(deltaY) ? deltaY : 0;
    const factor = Math.min(WHEEL_ZOOM_MAX, Math.max(WHEEL_ZOOM_MIN, Math.exp(dy * WHEEL_ZOOM)));
    return { kind: "zoom", factor };
  }
  const dx = Number.isFinite(deltaX) ? deltaX : 0;
  const dy = Number.isFinite(deltaY) ? deltaY : 0;
  // Horizontal is ours, vertical is the document's. Taking the vertical wheel
  // over a band would trap a reader who simply wanted to scroll past twenty
  // lanes, and a trapped scroll reads as the app being broken.
  if (Math.abs(dx) <= Math.abs(dy)) return null;
  if (!(widthPx > 0)) return null;
  return { kind: "pan", byWindows: dx / widthPx };
}

/** The three things a pointing device can ask of the zoom without a keyboard.
 *
 *  Named rather than expressed as a factor, because a caller that could pass its
 *  own factor is a caller that can invent a fourth zoom step. */
export type ZoomButton = "in" | "out" | "fit";

/** A button press, classified.
 *
 *  This is the BASE vocabulary and the keyboard below delegates to it, rather
 *  than the two carrying a copy of the same numbers. The buttons exist because
 *  ctrl + wheel is undiscoverable, so they have to be the same gesture in a
 *  visible form; a button that zoomed by a different step than the key it
 *  mirrors would be a second feature wearing the first one's clothes. */
export function buttonToIntent(button: ZoomButton): Intent {
  switch (button) {
    case "in":
      return { kind: "zoom", factor: KEY_ZOOM_IN };
    case "out":
      return { kind: "zoom", factor: KEY_ZOOM_OUT };
    case "fit":
      return { kind: "fit" };
  }
}

/** A key press, classified. Null means the key belongs to somebody else. */
export function keyToIntent(key: string, shiftKey: boolean): Intent | null {
  switch (key) {
    case "ArrowRight":
      return shiftKey ? { kind: "pan", byWindows: KEY_PAN } : null;
    case "ArrowLeft":
      return shiftKey ? { kind: "pan", byWindows: -KEY_PAN } : null;
    // An unshifted "=" is the same physical key and the same intent; asking for
    // shift to zoom in is a keyboard tax nobody agreed to pay.
    case "+":
    case "=":
      return buttonToIntent("in");
    case "-":
      return buttonToIntent("out");
    case "0":
      return buttonToIntent("fit");
    case "Home":
      return { kind: "home" };
    case "End":
      return { kind: "end" };
    case "]":
      return { kind: "page", dir: 1 };
    case "[":
      return { kind: "page", dir: -1 };
    default:
      return null;
  }
}

/** Which of the three controls can still do something from this window. */
export interface ZoomEnabled {
  in: boolean;
  out: boolean;
  fit: boolean;
}

/** Absorbs the rounding residue a window carries after a few zooms.
 *
 *  `normalize` reconstructs `b` as `a + w`, so a window sitting exactly on the
 *  floor measures a hair wide. Without this the floor button would stay enabled
 *  and do nothing, which is the precise failure these limits exist to prevent. */
const ZOOM_EPS = 1e-9;

/** What the zoom controls may offer from here.
 *
 *  A control is enabled EXACTLY when pressing it would move the window, and that
 *  equivalence is pinned as a property rather than described here. Disabling is
 *  the honest form of a limit: a button that stays lit and silently does nothing
 *  teaches a reader that the app ignores them, and they stop pressing it. The
 *  reason belongs on the disabled control as a title, not in a console. */
export function zoomEnabled(win: Window, minW: number): ZoomEnabled {
  const w = win.b - win.a;
  const floor = Math.min(1, Math.max(0, Number.isFinite(minW) ? minW : 0));
  return {
    in: w > floor + ZOOM_EPS,
    out: w < 1 - ZOOM_EPS,
    fit: win.a > ZOOM_EPS || win.b < 1 - ZOOM_EPS,
  };
}

/** Everything an intent needs to become a window. */
export interface IntentContext {
  /** Where the pointer sits inside the viewport, in pixels from its left edge.
   *  Pointing is deictic: the reader is indicating the thing they care about,
   *  and it has to stay under the cursor or the gesture feels like it is
   *  resisting them. Keyboard callers pass the hovered mark, or the centre. */
  anchorPx: number;
  widthPx: number;
  minW: number;
  ticks: readonly LaneTick[];
}

export function applyIntent(win: Window, intent: Intent, ctx: IntentContext): Window {
  const w = win.b - win.a;
  switch (intent.kind) {
    case "zoom": {
      const anchor = fromScreen(ctx.anchorPx, win, ctx.widthPx);
      // No measurement yet means no honest anchor, and guessing one would move
      // the reader's view on their first gesture. Hold still instead.
      if (anchor === null) return win;
      return zoomAt(win, anchor, intent.factor, ctx.minW);
    }
    case "pan":
      return panBy(win, intent.byWindows * w, ctx.minW);
    case "fit":
      return fit();
    case "home":
      return normalize(0, w, ctx.minW);
    case "end":
      return normalize(1 - w, 1, ctx.minW);
    case "page":
      return intent.dir === 1 ? pageNext(ctx.ticks, win) : pagePrev(ctx.ticks, win);
  }
}

/** Keep a mark on screen, moving the window as little as possible.
 *
 *  The band's bare arrow keys walk EVERY tick, which is right: thinning the ink
 *  never costs a reader an event. But a walk that steps outside a zoomed window
 *  would anchor the scrub line and its tooltip off the band, naming an event at
 *  a place where nothing is drawn. So the axis follows the reader.
 *
 *  Least movement rather than re-centring: a scrubber running along should read
 *  as the axis trailing the cursor, not as a jump on every step. Width never
 *  changes, so the walk cannot quietly undo a zoom. */
export function followMark(win: Window, x: number, minW: number): Window {
  if (!Number.isFinite(x)) return win;
  if (x >= win.a && x <= win.b) return win;
  const w = win.b - win.a;
  return x < win.a ? normalize(x, x + w, minW) : normalize(x - w, x, minW);
}

/** Drag on the overview strip: put the current window over the pointer.
 *
 *  Width never changes, so the strip pans and never zooms. Edge handles would be
 *  the obvious addition and are deliberately absent: at the zoom floor the
 *  window box is a fraction of a pixel wide, and the usual fix is a minimum
 *  drawn width, which then lies about the window it represents. */
export function stripWindowFromPointer(win: Window, px: number, widthPx: number, minW: number): Window {
  const centre = fromScreen(px, { a: 0, b: 1 }, widthPx);
  if (centre === null) return win;
  const w = win.b - win.a;
  return normalize(centre - w / 2, centre + w / 2, minW);
}
