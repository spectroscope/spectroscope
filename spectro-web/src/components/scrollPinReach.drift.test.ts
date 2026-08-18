// Card 257, criterion 5: the consumer pinned on its REAL call shape.
//
// The arm/disarm rule is pure and pinned in state/scrollPin.test.ts. What that
// cannot see is whether Chat ASKS it — and this card is precisely a case where
// a component kept its own copy of a rule (distance < 120, recomputed from
// every scroll event) while a module next door held the better one. Card 247
// paid for the lesson that a loose substring check lets a dead consumer pass
// green, so every assertion here names the call as it is written, arguments
// included.
//
// Comments are blanked first: the prose above these lines quotes the very
// shapes the assertions look for, and a blanker that missed them would let a
// COMMENT satisfy an assertion about CODE.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const chat = stripComments(read("./Chat.tsx", import.meta.url));

/** Chat's scroll handler — the one function the old rule lived in. */
function scrollHandler(src: string): string {
  const from = src.indexOf("const handleScroll = ()");
  expect(from).toBeGreaterThan(-1);
  return src.slice(from, src.indexOf("};", from));
}

/** The effect that follows the live edge when the transcript grows. Bounded by
 *  its own dependency line — with no dependency array at all (the shape this
 *  card removes) the next hook's array is the first one found, and the length
 *  guard says so instead of quietly widening the region. */
function followEffect(src: string): string {
  const from = src.indexOf("const newTurn = state.turns.length");
  expect(from).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }, [", from);
  expect(end).toBeGreaterThan(from);
  expect(end - from).toBeLessThan(800);
  return src.slice(from, src.indexOf(");", end) + 2);
}

describe("the old always-pin shape is gone", () => {
  it("no scroll event recomputes the pin from distance alone", () => {
    // The defect, written out: `pinnedRef.current = scrollHeight - scrollTop -
    // clientHeight < SCROLL_PIN_THRESHOLD_PX`, from EVERY event, our own
    // scrolls included.
    expect(chat).not.toContain("SCROLL_PIN_THRESHOLD_PX");
  });

  it("the follow effect no longer runs after every render", () => {
    // An effect with no dependency array re-asserted the bottom after every
    // render — while a run streams that is many per second, so the reader had
    // about one frame to get out of the zone.
    expect(followEffect(chat)).toContain("}, [state, childFolds]);");
  });

  it("the fold's own dependency is named, so card 271 keeps its promise", () => {
    // foldScrollDelta returns zero for a pinned reader BECAUSE this effect puts
    // them back at the edge on the same render. Drop childFolds from the deps
    // and that promise quietly becomes false.
    expect(followEffect(chat)).toContain("childFolds");
  });
});

describe("Chat asks scrollPin who scrolled, and what to do about it", () => {
  it("the handler credits the scroll before it touches the pin", () => {
    expect(scrollHandler(chat)).toContain("const intent = readerIntentAt.current;");
    expect(scrollHandler(chat)).toContain("scrollCause(intent === null ? null : performance.now() - intent)");
  });

  it("the handler measures where the box WENT, not when we last touched it", () => {
    // The bench killed the clock version of this rule: a stream commands
    // scrolls many times a second, so a wheel notch landing between two of them
    // was credited to the app and the reader was carried back down.
    expect(scrollHandler(chat)).toContain("const movedUp = el.scrollTop < lastScrollTop.current;");
    expect(scrollHandler(chat)).toContain("lastScrollTop.current = el.scrollTop;");
  });

  it("the handler takes the new pin from the rule, on the real distance", () => {
    expect(scrollHandler(chat)).toContain("pinnedRef.current = pinAfterScroll({");
    expect(scrollHandler(chat)).toContain("pinned: pinnedRef.current,");
    expect(scrollHandler(chat)).toContain("cause,");
    expect(scrollHandler(chat)).toContain("lastPull: lastPull.current,");
    expect(scrollHandler(chat)).toContain("movedUp,");
    expect(scrollHandler(chat)).toContain(
      "distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,",
    );
  });

  it("a reader-caused event pushes the window on, so a fling stays the reader's", () => {
    expect(scrollHandler(chat)).toContain(
      'if (cause === "reader") readerIntentAt.current = performance.now();',
    );
  });

  it("the growth effect asks what to do instead of deciding inline", () => {
    expect(followEffect(chat)).toContain("followScroll({ pinned: pinnedRef.current, newTurn })");
    expect(followEffect(chat)).toContain('if (el === null || how === "none") return;');
  });

  it("the growth effect moves to the live edge the way the rule said", () => {
    expect(followEffect(chat)).toContain("el.scrollTo({ top: el.scrollHeight, behavior: how });");
  });
});

describe("what counts as the reader reaching for the transcript", () => {
  it("wheel, touch and drag on the scroll box all say so", () => {
    expect(chat).toContain("onWheel={onWheel}");
    expect(chat).toContain("onTouchMove={onTouchOrDrag}");
    expect(chat).toContain("onPointerDown={onTouchOrDrag}");
  });

  it("the wheel's own direction reaches the rule, not just the fact of a wheel", () => {
    // The pin comes off on the GESTURE. A scroll event reports the frame's END
    // position, and a stream commands scrollTo many times a second — land in
    // the same frame and the reader's notch is gone before anyone reads it.
    expect(chat).toContain("noteReaderIntent(wheelPull(e.deltaY))");
    const note = chat.slice(
      chat.indexOf("const noteReaderIntent = useCallback"),
      chat.indexOf("const onWheel = useCallback"),
    );
    expect(note).toContain("pinnedRef.current = pinAfterGesture({");
    expect(note).toContain("pull,");
    expect(note).toContain("distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,");
    expect(note).toContain("lastPull.current = pull;");
  });

  it("the scrolling keys say so too, and the module decides which they are", () => {
    expect(chat).toContain("isReaderScrollKey(e.key, inEditable)) noteReaderIntent(keyPull(e.key));");
    // And only when the press was aimed at the transcript: an upward key now
    // takes the pin off by itself, so walking the session list with the arrows
    // must not stop the stream from following.
    expect(chat).toContain(
      "target === null || target === document.body || (scrollRef.current?.contains(target) ?? false)",
    );
  });

  it("a key inside a text field is editing — the composer is not the transcript", () => {
    expect(chat).toContain("/^(input|textarea|select)$/i.test(target.tagName)");
  });
});

describe("the deliberate controls own the pin outright", () => {
  it("jump-to-end arms it and jump-to-start disarms it", () => {
    expect(chat).toContain("setPin(true);");
    expect(chat).toContain("setPin(false);");
  });

  it("setting the pin deliberately drops the reader's stamp with it", () => {
    // Otherwise the smooth animation the control just started is measured
    // against a gesture from 300ms ago and undoes the control's own decision.
    const setter = chat.slice(chat.indexOf("const setPin = "), chat.indexOf("const handleScroll"));
    expect(setter).toContain("pinnedRef.current = armed;");
    expect(setter).toContain("readerIntentAt.current = null;");
    expect(setter).toContain('lastPull.current = "unknown";');
  });

  it("sending a message follows the answer, whatever the reader was reading", () => {
    const submit = chat.slice(chat.indexOf("const submit = ()"), chat.indexOf("const lastUserText"));
    expect(submit).toContain("setPin(true);");
  });

  it("stepping through search hits still releases the pin", () => {
    // Card 78 #5, kept: a reader walking hits is reading, not following.
    const hitJump = chat.slice(chat.indexOf('querySelector(".chat-hit--current")'));
    expect(hitJump.slice(0, 400)).toContain("setPin(false);");
  });

  it("swapping the view starts that reading's pin over", () => {
    // pinnedRef is seeded once at mount, and App swaps props instead of
    // remounting. Without this, a reader who scrolled up in the live view opens
    // an archive already disarmed — and comes back to a live run that never
    // follows again.
    expect(chat).toContain("setPin(liveView);");
  });
});

describe("the live edge survives things that are not renders", () => {
  it("a box that shrinks under a pinned reader is followed too", () => {
    // The composer growing to a second line, or the window resizing, moves the
    // live edge without any state changing — so the growth effect cannot see it
    // and a pinned reader would silently drift off the edge.
    const ro = chat.slice(chat.indexOf("new ResizeObserver("));
    expect(ro.slice(0, 400)).toContain("if (pinnedRef.current)");
    expect(ro.slice(0, 400)).toContain('el.scrollTo({ top: el.scrollHeight, behavior: "auto" });');
  });
});

describe("card 271's fold rule is absorbed, not fought", () => {
  // The region is the LAYOUT EFFECT alone, not everything up to the next
  // landmark. Written wider once, it reached over the follow effect that now
  // sits below it — and the stamp assertion passed on the follow effect's stamp
  // while the fold's own was deleted. Green for its own opposite, exactly the
  // shape this project keeps getting bitten by, caught by biting it.
  const foldEffect = (): string => {
    const from = chat.indexOf("const anchor = foldAnchor.current;");
    expect(from).toBeGreaterThan(-1);
    const end = chat.indexOf("}, [childFolds]);", from);
    expect(end).toBeGreaterThan(from);
    return chat.slice(from, end);
  };

  it("the fold still reads the pin and never sets it", () => {
    expect(foldEffect()).toContain("pinned: anchor.pinned,");
    expect(foldEffect()).not.toContain("pinnedRef.current =");
    expect(chat.slice(chat.indexOf("const toggleChildFold"), chat.indexOf("setChildFolds((open)"))).toContain(
      "pinned: pinnedRef.current",
    );
  });

  it("the fold's correction is still the plain one card 271 wrote", () => {
    // Nothing was bolted onto it: it runs only for a reader who is already
    // disarmed, so it cannot move a pin whichever way it scrolls.
    expect(foldEffect()).toContain("if (delta !== 0) el.scrollTop += delta;");
  });
});
