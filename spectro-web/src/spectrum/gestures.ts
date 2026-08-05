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
import { fit, fromScreen, isWhole, normalize, panBy, WINDOW_EPS, zoomAt, type Window } from "./viewport";

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
 *  "not ours": the caller must then leave the event alone so the page scrolls.
 *
 *  ONE SPACE. The two deltas are weighed against each other to settle which axis
 *  owns the gesture, and `widthPx` is measured in the same units they arrive in,
 *  so all three must be the pixels the browser reported. A caller that scales
 *  one of them into a drawing's own coordinates makes the verdict a function of
 *  how wide that drawing happens to be rendered, which is a swipe that pans on
 *  one screen and scrolls on another. */
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
    // The residue is absorbed on both limits for the same reason: a window
    // sitting exactly on the floor, or exactly back at the whole, measures a
    // hair off, and a button that stays lit and does nothing is the precise
    // failure these limits exist to prevent.
    in: w > floor + WINDOW_EPS,
    out: w < 1 - WINDOW_EPS,
    // The same predicate the readout uses. "There is a way back" and "there is
    // a slice to report" are one question, so they answer with one function.
    fit: !isWhole(win),
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

/** Which part of the strip's window a pointer is on. */
export type StripGrip = "start" | "end" | "body";

/**
 * What the pointer would grab: an end of the window, or the window itself.
 *
 * The ends ARE grabbable now (owner, 2026-08-05: "die anfasser sind immernoch
 * nicht da"), and the objection that kept them out for a while is answered
 * rather than overruled. It was: at the zoom floor the window box is a fraction
 * of a pixel wide, and the usual fix — a minimum DRAWN width — makes the box lie
 * about the window it stands for.
 *
 * So the drawing keeps telling the truth and the HIT ZONE is what gets the
 * generosity. A grab zone is not a claim about anything; it is how close a
 * finger has to be. And where the window is genuinely too narrow to have two
 * distinguishable ends, there are none: everything is `body`, which pans, which
 * is what a reader wants at that depth anyway.
 *
 * @param win the current window
 * @param px the pointer, in strip pixels from its left edge
 * @param widthPx the strip's drawn width
 * @param grabPx how close counts as an end
 * @return which grip the pointer is on
 */
export function stripGripAt(win: Window, px: number, widthPx: number, grabPx: number): StripGrip {
  if (!Number.isFinite(px) || widthPx <= 0) return "body";
  const startPx = win.a * widthPx;
  const endPx = win.b * widthPx;
  // Two zones need room to be two. Below that the window is one thing, and a
  // reader reaching for it means the whole of it.
  if (endPx - startPx < grabPx * 3) return "body";
  if (Math.abs(px - startPx) <= grabPx) return "start";
  if (Math.abs(px - endPx) <= grabPx) return "end";
  return "body";
}

/**
 * Drag an END of the window: the other end stays where it is.
 *
 * This is the stepless zoom the owner asked for, in its second form — the wheel
 * zooms around a point, this sets a span directly. Dragging one end past the
 * other does not flip the window: it stops at the floor, because a window whose
 * start is after its end is not a thing this app can show.
 *
 * @param win the current window
 * @param grip which end is being dragged; `body` returns the window untouched
 * @param px the pointer, in strip pixels from its left edge
 * @param widthPx the strip's drawn width
 * @param minW the zoom floor as a fraction of the whole
 * @return the resized window
 */
export function stripResize(win: Window, grip: StripGrip, px: number, widthPx: number, minW: number): Window {
  if (grip === "body") return win;
  const at = fromScreen(px, { a: 0, b: 1 }, widthPx);
  if (at === null) return win;
  return grip === "start"
    ? normalize(Math.min(at, win.b - minW), win.b, minW)
    : normalize(win.a, Math.max(at, win.a + minW), minW);
}

/** Drag the BODY of the strip's window: put it over the pointer.
 *
 *  Width never changes here, so this pans and never zooms; the ends above are
 *  what changes a span. */
export function stripWindowFromPointer(win: Window, px: number, widthPx: number, minW: number): Window {
  const centre = fromScreen(px, { a: 0, b: 1 }, widthPx);
  if (centre === null) return win;
  const w = win.b - win.a;
  return normalize(centre - w / 2, centre + w / 2, minW);
}
