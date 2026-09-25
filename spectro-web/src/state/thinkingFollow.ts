// Whether an open thinking body keeps its newest line in view while the model
// streams (card 78 #5). The rule lives here, apart from ThinkingDisclosure, so
// a test can drive it without a DOM: the component hands its body in as a
// ScrollBox and calls one method per thing that happened to it.
//
// Card 400: the body used to recompute its pin from the distance to the bottom
// on every scroll event, its own jumps included. A jump's scroll event reaches
// the page a frame later, and on a slow render the next batch of lines has
// grown the box by then. Measured on a bench in the installed Chrome
// (kanban/evidence/400/loop): on the base build 7c24ebcf the event read 37 to
// 55.5 px from the bottom with no input at all, the pin went off, and the body
// stopped following for good.
// The body now uses the transcript's rule from scrollPin.ts, which asks WHO
// scrolled: a scroll with no reader gesture behind it leaves the pin as it is.

import {
  followScroll,
  nextPull,
  pinAfterGesture,
  pinAfterScroll,
  scrollCause,
  type ReaderPull,
} from "./scrollPin";

/** The three numbers the follow reads from the body, and the one it writes. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * How close to the body's bottom edge counts as the bottom when the reader
 * brings the body back to it. A wheel, key or touch toward the edge within
 * this distance re-arms the follow, and so does a scroll of the reader's that
 * ends within it while their last pull was not away.
 *
 * <p>It never takes the pin off. A wheel, key or touch away that the body can
 * take, or a grab of its scrollbar, does that at any distance. A drag heard
 * only as a press still counts as following while it stays within this
 * distance.</p>
 *
 * <p>Where the transcript allows two pixels of rounding (AT_BOTTOM_PX), the
 * body keeps its 32 px (card 400, owner call 2 at its default).</p>
 *
 * <p>The same distance counts as back where the reader left the follow, see
 * {@link thinkingFollow}.</p>
 */
export const THINKING_FOLLOW_PX = 32;

/** One thinking body's follow state and the events that move it. */
export interface ThinkingFollow {
  /** Whether the body follows its newest line right now. */
  pinned(): boolean;
  /**
   * A reader's gesture on the body: a wheel, a touch, a press, a scrolling key.
   *
   * @param box  the body
   * @param pull which way the gesture pulls
   */
  gesture(box: ScrollBox, pull: ReaderPull): void;
  /** One native scroll event on the body, read when the browser delivers it. */
  scrolled(box: ScrollBox): void;
  /** The streamed text grew: jump to the newest line while pinned. */
  grew(box: ScrollBox): void;
  /** The body opened while the block streams: start at the live edge, pinned. */
  opened(box: ScrollBox): void;
}

/** @return how far the box stands above its bottom edge */
export function distanceFromBottom(box: ScrollBox): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/**
 * Whether a gesture over the body is the body's at all.
 *
 * <p>The body is a bounded well: at its top, and while its text still fits,
 * a pull away from its newest line cannot move it, and the browser hands the
 * wheel on to the transcript (styles/scrollChaining.drift.test.ts). That
 * reader is scrolling the page past a short thinking block, and taking the pin
 * off for them would leave the block unfollowed once it overflows.</p>
 *
 * @param pull      which way the gesture pulls
 * @param scrollTop where the body stands
 * @return false when the gesture cannot move the body
 */
export function reachesTheBody(pull: ReaderPull, scrollTop: number): boolean {
  return !(pull === "away" && scrollTop <= 0);
}

/**
 * Whether a change of the streamed text is one the follow answers.
 *
 * <p>Card 400, wave H3d: the change that ends the block counts. The last
 * lines often arrive in the same commit that ends the stream, and a rule of
 * "open and streaming" left them below the fold: in 16 of 24 ended blocks on
 * the H3b build the newest character ended below the body's bottom edge
 * (kanban/evidence/loop-2026-09-24/wave-H3b/browser/400/400-end.json).
 * A block that never streamed, a settled record opened for reading, is still
 * left where it is.</p>
 *
 * @param input open: whether the body is shown; active: whether the block
 *              streams after this change; wasActive: whether it streamed
 *              before this change
 * @return true when the component hands the change to {@link ThinkingFollow.grew}
 */
export function followsTheText(input: { open: boolean; active: boolean; wasActive: boolean }): boolean {
  return input.open && (input.active || input.wasActive);
}

/**
 * A fresh follow, pinned.
 *
 * <p>Card 400, wave H3d: the way back for a reader who cannot outrun the
 * stream. When the reader takes the follow off, the follow remembers where
 * the body stood. A scroll of the reader's whose last pull was toward the end
 * (a wheel, a scrolling key, a touch) and that brings the body back to within
 * THINKING_FOLLOW_PX of that place re-arms the follow, however far the end
 * has moved since. At GLM's p90 of 141.9 lines a second the end moves about
 * 2,640 px a second where a line does not wrap (18.6 px a line); on the H3b
 * build 60 wheel notches of 120 px ended 13,131 px above the bottom
 * (wave-H3b/browser/logs/c400-probe.log).</p>
 *
 * <p>A grab of the scrollbar resets the last pull (nextPull), so a thumb drag
 * does not take this way: a thumb held under the pointer would pull the box
 * back from the jump on the next pointer move. It re-arms at the bottom edge,
 * as before. A drag heard only as a press keeps the last pull, and takes this
 * way when that pull was toward the end.</p>
 *
 * @param now the clock, in milliseconds, that dates the reader's gestures
 * @return the follow for one thinking body
 */
export function thinkingFollow(now: () => number): ThinkingFollow {
  let pinned = true;
  /** When the reader last reached for the body, null when never. */
  let readerIntentAt: number | null = null;
  /** Where the body stood at the previous scroll event or jump of the follow. */
  let lastScrollTop = 0;
  /** Which way the reader's last gesture pulled. */
  let lastPull: ReaderPull = "unknown";
  /** Where the body stood when the reader took the follow off. */
  let leftAt = Number.POSITIVE_INFINITY;

  return {
    pinned: () => pinned,

    gesture(box, pull) {
      if (!reachesTheBody(pull, box.scrollTop)) return;
      readerIntentAt = now();
      lastPull = nextPull(lastPull, pull);
      const was = pinned;
      pinned = pinAfterGesture({
        pinned,
        pull,
        distanceFromBottom: distanceFromBottom(box),
        atBottomPx: THINKING_FOLLOW_PX,
      });
      // Decided before the browser has moved anything: the body still stands
      // where the reader left it.
      if (was && !pinned) leftAt = box.scrollTop;
    },

    scrolled(box) {
      const cause = scrollCause(readerIntentAt === null ? null : now() - readerIntentAt);
      // A fling, or a drag of the scrollbar thumb, keeps firing scroll events
      // long after the gesture that started it, and each is still the reader's.
      if (cause === "reader") readerIntentAt = now();
      const movedUp = box.scrollTop < lastScrollTop;
      const before = lastScrollTop;
      lastScrollTop = box.scrollTop;
      const was = pinned;
      pinned = pinAfterScroll({
        pinned,
        cause,
        lastPull,
        movedUp,
        distanceFromBottom: distanceFromBottom(box),
        atBottomPx: THINKING_FOLLOW_PX,
      });
      // Taken off by the way the box moved (a drag heard only as a press): the
      // reader left from where the box stood before this move.
      if (was && !pinned) leftAt = before;
      if (!was && cause === "reader" && lastPull === "toward" && box.scrollTop >= leftAt - THINKING_FOLLOW_PX)
        pinned = true;
    },

    grew(box) {
      if (followScroll({ pinned }) !== "auto") return;
      box.scrollTop = box.scrollHeight;
      // The jump's scroll event comes a frame later; until then this is where
      // the body stands.
      lastScrollTop = box.scrollTop;
    },

    opened(box) {
      // A deliberate start at the live edge, as the transcript's setPin does
      // it: the reader's stamp and last pull go with the old position.
      pinned = true;
      readerIntentAt = null;
      lastPull = "unknown";
      box.scrollTop = box.scrollHeight;
    },
  };
}
