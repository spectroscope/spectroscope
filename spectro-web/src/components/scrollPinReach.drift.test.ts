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

/** The dependency ARRAY of the follow effect, and nothing from its body. The
 *  difference matters: a `void childFolds;` marker in the body satisfies a
 *  search for the name while the array itself has lost it. */
function followDeps(src: string): string {
  const eff = followEffect(src);
  const at = eff.lastIndexOf("}, [");
  expect(at).toBeGreaterThan(-1);
  return eff.slice(at);
}

/** One button of the jump rail, by the dictionary key it is labelled with —
 *  its onClick and nothing else. Sliced, because a whole-file search for
 *  `setPin(true);` is answered by submit and by the search-hit jump, and both
 *  rail buttons could be gutted with the file-wide assertion still green. That
 *  is what the review found here. */
function railControl(src: string, label: string): string {
  const at = src.indexOf(`t(lang, "${label}")`);
  expect(at).toBeGreaterThan(-1);
  const from = src.indexOf("onClick={", at);
  expect(from).toBeGreaterThan(at);
  const end = src.indexOf("}}", from);
  expect(end).toBeGreaterThan(from);
  expect(end - from).toBeLessThan(300);
  return src.slice(from, end);
}

/** The effect that starts a reading over when the view is swapped. */
function viewSwapEffect(src: string): string {
  const from = src.indexOf("setPin(liveView);");
  expect(from).toBeGreaterThan(-1);
  const end = src.indexOf("}, [", from);
  expect(end).toBeGreaterThan(from);
  expect(end - from).toBeLessThan(500);
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
    //
    // Read from the ARRAY and not from the effect's body. Written as a search
    // over the whole effect, this passed on a `void childFolds;` marker that
    // sat in the body while the array had lost the name — green for its own
    // opposite, found by the review.
    expect(followDeps(chat)).toContain("childFolds");
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
    expect(chat).toContain("onTouchStart={onTouchStart}");
    expect(chat).toContain("onTouchMove={onTouchMove}");
    expect(chat).toContain("onPointerDown={onPointerDown}");
  });

  it("a gesture with no direction does not erase the one on record", () => {
    // The review's finding: every gesture overwrote lastPull, "unknown"
    // included, so one click in the transcript wiped the away a wheel had just
    // recorded — and the away flag is all that stops a follow reaching the edge
    // from arming the pin again on the reader's behalf.
    const note = chat.slice(
      chat.indexOf("const noteReaderIntent = useCallback"),
      chat.indexOf("const onWheel = useCallback"),
    );
    expect(note).toContain("lastPull.current = nextPull(lastPull.current, pull);");
  });

  it("a touch drag carries its direction to the rule, like a wheel", () => {
    // Touch passed no pull at all, so its disarm fell back on the scroll-event
    // path this card measured as lossy — the input that cannot escape the race
    // left standing on the mechanism that loses it.
    const touch = chat.slice(
      chat.indexOf("const onTouchStart = useCallback"),
      chat.indexOf("const setPin = "),
    );
    expect(touch).toContain("lastTouchY.current = e.touches[0]?.clientY ?? null;");
    expect(touch).toContain(
      'noteReaderIntent(from === null || y === null ? "unknown" : touchPull(y - from));',
    );
  });

  it("a press on the scrollbar is a grab, a press on the content is not", () => {
    // Measured: a thumb drag delivers pointerdown and pointerup and no
    // pointermove at all, so there is no direction to read while it happens.
    // The press itself is the news — the reader has the position control.
    const down = chat.slice(
      chat.indexOf("const onPointerDown = useCallback"),
      chat.indexOf("const onTouchStart = useCallback"),
    );
    expect(down).toContain("onScrollbar(e.clientX, el.getBoundingClientRect().left, el.clientWidth)");
    expect(down).toContain('noteReaderIntent(grabbed ? "grab" : "unknown");');
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
    expect(note).toContain("lastPull.current = nextPull(lastPull.current, pull);");
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
  it("jump-to-end arms the pin, and nothing else in that button does", () => {
    const toEnd = railControl(chat, "trace.toEnd");
    expect(toEnd).toContain("setPin(true);");
    expect(toEnd).not.toContain("setPin(false);");
  });

  it("jump-to-start releases it, and nothing else in that button does", () => {
    const toStart = railControl(chat, "trace.toStart");
    expect(toStart).toContain("setPin(false);");
    expect(toStart).not.toContain("setPin(true);");
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

  it("swapping the view starts that reading's pin over, on every swap", () => {
    // pinnedRef is seeded once at mount, and App swaps props instead of
    // remounting. Without this, a reader who scrolled up in the live view opens
    // an archive already disarmed — and comes back to a live run that never
    // follows again.
    //
    // WHEN it runs is the whole content of the decision, so the dependency line
    // is named here. Written as a file-wide search for the call, this stayed
    // green with the array emptied and the re-seed silently never happening.
    expect(viewSwapEffect(chat)).toContain("}, [props.viewKey, liveView]);");
  });

  it("swapping the view also decides where the reader STANDS in it", () => {
    // Seeding the pin alone left a hole the review found: with the follow effect
    // standing down for a disarmed reader, an archive opened on whatever
    // scrollTop the previous view happened to have, clamped into an unrelated
    // transcript. A live view opens at its edge; a record is read from the top.
    const swap = viewSwapEffect(chat);
    expect(swap).toContain('el.scrollTo({ top: liveView ? el.scrollHeight : 0, behavior: "auto" });');
    // The two records that would otherwise carry the previous reading's numbers
    // into this one: the last scroll position the handler compares against, and
    // the turn count that decides what counts as a new turn.
    expect(swap).toContain("lastScrollTop.current = el.scrollTop;");
    expect(swap).toContain("prevTurnCount.current = 0;");
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
