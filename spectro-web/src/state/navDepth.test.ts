// Card 179: how far back and forward the app can go.
//
// The desktop shell draws no URL bar, so it has no back button — the one control
// every browser view of this app has had for free. `history.back()` works there;
// what the DOM cannot answer is whether there is anywhere to GO. `history.length`
// counts the whole tab's life including entries from before this app loaded, and
// nothing reports forward availability at all. So the app stamps what it writes.

import { describe, expect, it } from "vitest";
import { afterPop, afterPush, canGoBack, canGoForward, NAV_START, stampFor } from "./navDepth";

describe("navDepth", () => {
  it("starts with nowhere to go", () => {
    expect(canGoBack(NAV_START)).toBe(false);
    expect(canGoForward(NAV_START)).toBe(false);
  });

  it("a push gives a back and no forward", () => {
    const d = afterPush(NAV_START);
    expect(canGoBack(d)).toBe(true);
    expect(canGoForward(d)).toBe(false);
  });

  it("going back gives a forward, and returning takes it away", () => {
    const two = afterPush(afterPush(NAV_START));
    const back = afterPop(two, stampFor({ index: 1, furthest: 2 }));
    expect(canGoBack(back)).toBe(true);
    expect(canGoForward(back)).toBe(true);
    const forward = afterPop(back, stampFor({ index: 2, furthest: 2 }));
    expect(canGoForward(forward)).toBe(false);
  });

  it("pushing from the middle throws the forward entries away", () => {
    // The browser's own rule, and the reason `furthest` cannot simply grow: a
    // reader who goes back twice and then opens something new has no forward,
    // and the button has to be dark rather than lie.
    const three = afterPush(afterPush(afterPush(NAV_START)));
    const middle = afterPop(three, stampFor({ index: 1, furthest: 3 }));
    expect(canGoForward(middle)).toBe(true);
    const pushed = afterPush(middle);
    expect(canGoForward(pushed)).toBe(false);
    expect(canGoBack(pushed)).toBe(true);
  });

  it("an entry this app did not write moves nothing", () => {
    // A hash somebody typed, or an entry from before the app loaded. Counting
    // it would make a button offer a step into somewhere we cannot describe.
    const two = afterPush(afterPush(NAV_START));
    expect(afterPop(two, null)).toEqual(two);
    expect(afterPop(two, { somethingElse: 3 })).toEqual(two);
    expect(afterPop(two, { spectroNav: "1" })).toEqual(two);
  });

  it("remembers the furthest it has been, across several steps back", () => {
    const three = afterPush(afterPush(afterPush(NAV_START)));
    const first = afterPop(
      afterPop(three, stampFor({ index: 2, furthest: 3 })),
      stampFor({ index: 0, furthest: 3 }),
    );
    expect(canGoBack(first)).toBe(false);
    expect(canGoForward(first)).toBe(true);
  });
});

// Found live, not by reading: the entry the app BOOTS on is written with a
// replace, and while that carried no stamp, returning to it looked like landing
// on somebody else's entry — so the depth never moved and forward stayed dark
// on exactly the step that had just created one.
describe("the entry the app booted on", () => {
  it("counts as a place, so coming back to it lights forward", () => {
    const pushed = afterPush(NAV_START); // boot entry -> one push
    const home = afterPop(pushed, stampFor(NAV_START));
    expect(canGoBack(home)).toBe(false);
    expect(canGoForward(home)).toBe(true);
  });
});
