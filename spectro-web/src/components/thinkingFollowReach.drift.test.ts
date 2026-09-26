// Card 400: the thinking body pinned on its REAL call shape.
//
// The follow rule is pure and pinned in state/thinkingFollow.test.ts. What that
// suite cannot see is whether ThinkingDisclosure hands it the events: this
// suite has no DOM, and a component that kept its own copy of the rule, or
// forgot to report a gesture, would leave every rule test green. The same
// reasoning as scrollPinReach.drift.test.ts for the transcript, so each
// assertion names the call as it is written, arguments included.
//
// Comments are blanked first, so a comment quoting a call cannot stand in for
// the call.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const src = stripComments(read("./ThinkingDisclosure.tsx", import.meta.url));

/** The text between two landmarks, both of which must be there. */
function between(from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("the old distance-only pin is gone", () => {
  it("the component no longer recomputes a pin from the distance itself", () => {
    // The defect, written out: `pinnedRef.current = el.scrollHeight -
    // el.scrollTop - el.clientHeight < FOLLOW_PIN_THRESHOLD_PX`, from every
    // scroll event, its own jumps included.
    expect(src).not.toContain("pinnedRef");
    expect(src).not.toContain("FOLLOW_PIN_THRESHOLD_PX");
    expect(src).not.toContain("el.scrollHeight - el.scrollTop");
  });
});

describe("ThinkingDisclosure reports every event to the follow", () => {
  it("each scroll event goes to the rule, which asks who scrolled", () => {
    expect(between("const handleScroll = ()", "};")).toContain("if (el !== null) follow.scrolled(el);");
  });

  it("the growth effect asks the follow, for every change of the text the rule answers", () => {
    const effect = between("const wasActive = useRef(false);", "}, [");
    expect(effect).toContain(
      "const answered = followsTheText({ open, active: props.active, wasActive: wasActive.current });",
    );
    expect(effect).toContain("wasActive.current = props.active;");
    expect(effect).toContain("if (!answered || el === null) return;");
    expect(effect).toContain("follow.grew(el);");
    expect(src).toContain("}, [props.text, open, props.active, follow]);");
  });

  it("the growth effect asks the rule before it records the new state, and records it before the early return", () => {
    // Recorded before the ask, wasActive already reads false on the change
    // that ends the stream, and the lines that arrive with the end are not
    // followed. Recorded after the early return, a change the rule does not
    // answer is not recorded. The rule's unit test plays its own copy of this
    // effect, so only this case sees the component's order.
    const effect = between("const wasActive = useRef(false);", "}, [");
    const ask = effect.indexOf("const answered = followsTheText(");
    const record = effect.indexOf("wasActive.current = props.active;");
    const leave = effect.indexOf("if (!answered || el === null) return;");
    expect(ask, "the ask").toBeGreaterThan(-1);
    expect(record, "the record comes after the ask").toBeGreaterThan(ask);
    expect(leave, "the early return comes after the record").toBeGreaterThan(record);
  });

  it("the growth effect is a layout effect, so the jump lands before the new lines are painted", () => {
    // Wave H3d: as a passive effect the jump ran after the paint. On the H3b
    // build the browser stage's frame sampler found 17 to 32 frames per
    // stream at 390 px in which the streaming body stood more than 32 px above
    // its bottom (wave-H3b/browser/logs/c400.log).
    expect(between("const wasActive = useRef(false);", "follow.grew(el);")).toContain(
      "useLayoutEffect(() => {",
    );
  });

  it("opening mid-stream starts the follow at the live edge", () => {
    expect(between("const justOpened = open && !prevOpen.current;", "}, [")).toContain("follow.opened(el);");
  });
});

describe("what counts as the reader reaching for the body", () => {
  it("wheel, touch, press and scroll all sit on the body itself", () => {
    const body = between('className="thinking-body"', ">");
    expect(body).toContain("onScroll={handleScroll}");
    expect(body).toContain("onWheel={onWheel}");
    expect(body).toContain("onTouchStart={onTouchStart}");
    expect(body).toContain("onTouchMove={onTouchMove}");
    expect(body).toContain("onPointerDown={onPointerDown}");
  });

  it("a wheel carries its direction", () => {
    expect(between("const onWheel = ", "};")).toContain(
      "follow.gesture(e.currentTarget, wheelPull(e.deltaY));",
    );
  });

  it("a touch drag carries its direction, like a wheel", () => {
    expect(between("const onTouchMove = ", "};")).toContain(
      'follow.gesture(e.currentTarget, from === null || y === null ? "unknown" : touchPull(y - from));',
    );
  });

  it("a press on the scrollbar is a grab, a press on the content is not", () => {
    const down = between("const onPointerDown = ", "};");
    expect(down).toContain("onScrollbar(e.clientX, el.getBoundingClientRect().left, el.clientWidth)");
    expect(down).toContain('follow.gesture(el, grabbed ? "grab" : "unknown");');
    expect(down).toContain("pressedInside.current = true;");
  });

  it("a scrolling key counts only after a press in this body, and only when no control holds the focus", () => {
    const key = between("const onKey = ", "};");
    expect(key).toContain("if (el === null || !pressedInside.current) return;");
    expect(key).toContain(
      "const aimed = target === null || target === document.body || el.contains(target);",
    );
    expect(key).toContain(
      "if (aimed && isReaderScrollKey(e.key, inEditable)) follow.gesture(el, keyPull(e.key));",
    );
    expect(between("const onDown = ", "};")).toContain("pressedInside.current = false;");
  });
});
