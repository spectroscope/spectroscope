// Card 257: who owns the scroll position while a run streams. Pure, because
// this suite has no DOM — and because a rule about the reader's intent is
// exactly the kind of thing that must be readable without one.

import { describe, expect, it } from "vitest";
import {
  followScroll,
  nextPull,
  onScrollbar,
  touchPull,
  type ReaderPull,
  isReaderScrollKey,
  keyPull,
  pinAfterGesture,
  wheelPull,
  pinAfterScroll,
  scrollCause,
  READER_INTENT_WINDOW_MS,
} from "./scrollPin";

describe("who scrolled", () => {
  // The defect's first cause: our own scrollTo fires the same scroll event a
  // wheel does, so the pin re-armed itself on the reader's behalf.

  it("a scroll with no reader gesture behind it belongs to the app", () => {
    expect(scrollCause(null)).toBe("app");
  });

  it("a scroll right after a wheel belongs to the reader", () => {
    expect(scrollCause(5)).toBe("reader");
  });

  it("momentum inside the window still belongs to the reader", () => {
    // A trackpad fling keeps firing scroll events after the fingers are gone.
    // They are the reader's, or a fling that ends at the bottom would not
    // re-arm the pin.
    expect(scrollCause(READER_INTENT_WINDOW_MS - 1)).toBe("reader");
  });

  it("a gesture that has gone quiet hands the box back to the app", () => {
    expect(scrollCause(READER_INTENT_WINDOW_MS)).toBe("app");
  });
});

describe("the reader arms and disarms the pin, and nothing else does", () => {
  it("the app's own scroll can never arm the pin", () => {
    // The whole defect in one line: a programmatic scrollTo lands at the
    // bottom, reports "at the bottom", and used to re-arm the pin it had just
    // overridden.
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "app",
        lastPull: "unknown",
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(false);
  });

  it("the app's own scroll can never disarm it either", () => {
    // Mid-animation the box is far from the bottom. That is our animation, not
    // a reader changing their mind.
    expect(
      pinAfterScroll({
        pinned: true,
        cause: "app",
        lastPull: "unknown",
        movedUp: false,
        distanceFromBottom: 4000,
      }),
    ).toBe(true);
  });

  it("one small notch up from the reader disarms it", () => {
    expect(
      pinAfterScroll({
        pinned: true,
        cause: "reader",
        lastPull: "away",
        movedUp: true,
        distanceFromBottom: 8,
      }),
    ).toBe(false);
  });

  it("the 120px dead zone is gone, not re-tuned", () => {
    // The defect's second cause. A scroll-up that ended anywhere inside the old
    // zone counted as "still pinned", so a slow trackpad drag could never
    // escape: every notch was undone before the next one arrived.
    expect(
      pinAfterScroll({
        pinned: true,
        cause: "reader",
        lastPull: "away",
        movedUp: true,
        distanceFromBottom: 40,
      }),
    ).toBe(false);
    expect(
      pinAfterScroll({
        pinned: true,
        cause: "reader",
        lastPull: "away",
        movedUp: true,
        distanceFromBottom: 119,
      }),
    ).toBe(false);
  });

  it("our own animation still running under a fresh gesture does NOT disarm", () => {
    // Measured on the bench, and the reason this rule reads direction rather
    // than clocks: while a smooth follow glides, the box is far from the bottom
    // and moving TOWARD it. A pointer-down 200ms earlier must not turn that
    // glide into "the reader pulled away".
    expect(
      pinAfterScroll({
        pinned: true,
        cause: "reader",
        lastPull: "toward",
        movedUp: false,
        distanceFromBottom: 300,
      }),
    ).toBe(true);
  });

  it("the reader returning to the bottom arms it again", () => {
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "toward",
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });

  it("a reader still on their way down is left disarmed", () => {
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "toward",
        movedUp: false,
        distanceFromBottom: 500,
      }),
    ).toBe(false);
  });

  it("two pixels of rounding still count as the bottom, three do not", () => {
    // scrollHeight and clientHeight are rounded integers while scrollTop is
    // fractional, and a zoomed page carries about a pixel of residue per
    // rounding. Two pixels covers the arithmetic and nothing a reader could
    // deliberately aim at.
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "toward",
        movedUp: false,
        distanceFromBottom: 2,
      }),
    ).toBe(true);
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "toward",
        movedUp: false,
        distanceFromBottom: 3,
      }),
    ).toBe(false);
  });
});

describe("what a growth event may do", () => {
  it("a disarmed reader is not moved, whatever arrives", () => {
    expect(followScroll({ pinned: false, newTurn: false })).toBe("none");
  });

  it("not even a whole new turn moves a disarmed reader", () => {
    // The one that used to hurt most: an answer beginning is the moment the
    // reader is most likely to be reading something else.
    expect(followScroll({ pinned: false, newTurn: true })).toBe("none");
  });

  it("a pinned reader follows the stream instantly while a turn grows", () => {
    // Instant, not smooth: an animation per token is jitter.
    expect(followScroll({ pinned: true, newTurn: false })).toBe("auto");
  });

  it("a pinned reader glides to a new turn", () => {
    expect(followScroll({ pinned: true, newTurn: true })).toBe("smooth");
  });
});

describe("the pin after a gesture, before the browser has scrolled anything", () => {
  it("a pull away takes the pin off at once", () => {
    expect(pinAfterGesture({ pinned: true, pull: "away", distanceFromBottom: 0 })).toBe(false);
  });

  it("a pull toward the edge, made AT the edge, puts it back on", () => {
    // The dead end this closes: after an away pull the scroll rule refuses to
    // re-arm, and a reader already at the bottom moves nothing by wheeling
    // down — so no scroll event would ever come to re-arm on.
    expect(pinAfterGesture({ pinned: false, pull: "toward", distanceFromBottom: 1 })).toBe(true);
  });

  it("a pull toward the edge from far away changes nothing yet", () => {
    expect(pinAfterGesture({ pinned: false, pull: "toward", distanceFromBottom: 400 })).toBe(false);
  });

  it("a gesture with no direction decides nothing", () => {
    // A scrollbar drag: where it went is the scroll event's business.
    expect(pinAfterGesture({ pinned: true, pull: "unknown", distanceFromBottom: 300 })).toBe(true);
  });
});

describe("the reader's last direction gates the re-arm", () => {
  it("landing at the bottom after pulling AWAY does not re-arm", () => {
    // Measured on the bench: the reader wheels up, and an animation this view
    // had already started carries the box on down to the edge inside the same
    // gesture window. Crediting that to the reader put the pin straight back.
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "away",
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(false);
  });

  it("a fling the reader aimed downward still re-arms at the bottom", () => {
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "toward",
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });

  it("a scrollbar drag to the bottom re-arms too — it has no direction to give", () => {
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: "unknown",
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });
});

describe("a gesture that pulls AWAY from the live edge disarms on the spot", () => {
  // Measured on the bench, and the third thing this card had to learn: a scroll
  // event reports the position at the END of the frame, so an app scrollTo in
  // the same frame erases the reader's notch before anyone can read it. The
  // wheel's own direction is known BEFORE the browser applies it, so the pin
  // comes off there and the race does not exist.

  it("a wheel up pulls away", () => {
    expect(wheelPull(-100)).toBe("away");
  });

  it("a wheel down does not — the reader is heading back to the edge", () => {
    expect(wheelPull(120)).toBe("toward");
  });

  it("a wheel that moved nothing says nothing", () => {
    // A horizontal trackpad swipe, or the flat frame at the end of a fling.
    expect(wheelPull(0)).toBe("unknown");
  });

  it("the upward keys pull away, the downward ones do not", () => {
    expect(keyPull("PageUp")).toBe("away");
    expect(keyPull("ArrowUp")).toBe("away");
    expect(keyPull("Home")).toBe("away");
    expect(keyPull("PageDown")).toBe("toward");
    expect(keyPull("ArrowDown")).toBe("toward");
    expect(keyPull("End")).toBe("toward");
    expect(keyPull(" ")).toBe("toward");
  });

  it("a key that scrolls nothing says nothing", () => {
    expect(keyPull("a")).toBe("unknown");
  });
});

describe("which keys are the reader reaching for the transcript", () => {
  it("the paging and homing keys count", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]) {
      expect(isReaderScrollKey(key, false)).toBe(true);
    }
  });

  it("a letter does not", () => {
    expect(isReaderScrollKey("a", false)).toBe(false);
  });

  it("the same keys inside a text field are editing, not scrolling", () => {
    // Arrowing through the draft, or a space in a prompt, must not disarm the
    // pin — the composer is not the transcript.
    expect(isReaderScrollKey("ArrowUp", true)).toBe(false);
    expect(isReaderScrollKey(" ", true)).toBe(false);
  });
});

describe("a gesture with no direction must not erase the one on record", () => {
  // The review's finding, and it is the owner's own symptom by another route:
  // every gesture used to overwrite the recorded pull, "unknown" included. A
  // reader who wheels up (pin off, pull "away") and then CLICKS in the
  // transcript — to select a word, to open a fold — had the away flag wiped,
  // and the away flag is the only thing standing between them and a follow
  // that reaches the bottom and arms the pin again on their behalf.
  //
  // Measured in the browser before the fix: the wheel left lastPull "away",
  // and a single click left it "unknown" (kanban/evidence/card-257).

  it("a bare press keeps the away the wheel put on record", () => {
    expect(nextPull("away", "unknown")).toBe("away");
  });

  it("a bare press keeps a toward on record too", () => {
    expect(nextPull("toward", "unknown")).toBe("toward");
  });

  it("a gesture that DOES know its direction overwrites the old one", () => {
    // The other half, and the reason the fix cannot simply be "ignore unknown
    // pulls": a reader who wheels back down must be able to clear their own
    // away, or the pin can never be re-armed by hand again.
    expect(nextPull("away", "toward")).toBe("toward");
    expect(nextPull("toward", "away")).toBe("away");
  });

  it("the click that wiped the away no longer lets a landing re-arm the pin", () => {
    // The whole scenario, end to end, against the rule as the component asks it.
    const afterWheelUp = pinAfterGesture({ pinned: true, pull: "away", distanceFromBottom: 0 });
    expect(afterWheelUp).toBe(false);
    let pull: ReaderPull = "away";
    pull = nextPull(pull, "unknown"); // the click
    expect(
      pinAfterScroll({
        pinned: afterWheelUp,
        cause: "reader",
        lastPull: pull,
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(false);
  });
});

describe("a touch drag carries a direction, the same as a wheel", () => {
  // Before the fix, touch passed no pull at all, so the disarm fell back on the
  // scroll-event path — the one this card MEASURED as lossy. The wheel got a
  // gesture-level disarm and touch did not, which left the input that cannot
  // escape the race standing on the mechanism that loses it.
  //
  // The sign is the opposite of a scrollbar thumb's: dragging the CONTENT down
  // moves the box away from the live edge.

  it("a finger moving down drags the content down, away from the live edge", () => {
    expect(touchPull(12)).toBe("away");
  });

  it("a finger moving up drags the content toward the live edge", () => {
    expect(touchPull(-12)).toBe("toward");
  });

  it("a finger that has not moved says nothing", () => {
    expect(touchPull(0)).toBe("unknown");
  });

  it("a touch drag away from the edge takes the pin off on the gesture", () => {
    expect(pinAfterGesture({ pinned: true, pull: touchPull(20), distanceFromBottom: 0 })).toBe(false);
  });
});

describe("taking hold of the scrollbar is its own kind of gesture", () => {
  // Measured, not assumed: a thumb drag delivers pointerdown and pointerup and
  // NOTHING in between — zero pointermove events (kanban/evidence/card-257) — so
  // there is no direction to read while the drag is happening. What the press
  // does say is that the reader has the position control in their hand.
  //
  // Left on the scroll-event path it cost, measured under a stream commanding a
  // smooth follow 20x a second: 35 scroll events and 2228ms of being yanked
  // back to the edge (0 -> 21 -> 0 -> 21 ...) before a 24px drag finally held.

  it("the grab takes the pin off at the press, before anything scrolls", () => {
    expect(pinAfterGesture({ pinned: true, pull: "grab", distanceFromBottom: 0 })).toBe(false);
  });

  it("the grab forgets which way the reader last pulled, so the DROP decides", () => {
    // Not "away": a reader who wheels up and then drags the thumb back to the
    // bottom must be able to re-arm. Not "toward" either, which would arm the
    // pin merely for touching the bar.
    expect(nextPull("away", "grab")).toBe("unknown");
    expect(nextPull("toward", "grab")).toBe("unknown");
  });

  it("dropping the thumb at the live edge re-arms the pin", () => {
    const pull = nextPull("away", "grab");
    expect(
      pinAfterScroll({
        pinned: false,
        cause: "reader",
        lastPull: pull,
        movedUp: false,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });

  it("a press on the scrollbar is told from a press on the content by where it landed", () => {
    // clientWidth excludes the scrollbar; getBoundingClientRect().width does not.
    expect(onScrollbar(532, 0, 524)).toBe(true);
    expect(onScrollbar(40, 0, 524)).toBe(false);
    // A box that is not at the window's left edge is measured from its own.
    expect(onScrollbar(532, 100, 524)).toBe(false);
  });

  it("overlay scrollbars take up no width, so nothing is ever read as a grab", () => {
    // macOS' default. The hit test cannot fire, and the drag falls back to the
    // scroll-event path — stated here so the limit is pinned rather than
    // discovered later.
    expect(onScrollbar(539, 0, 541)).toBe(false);
  });
});
