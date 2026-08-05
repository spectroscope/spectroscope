// Input mapping is pure. There is no DOM in this suite, so a component that did
// this arithmetic inline would be untestable by construction; the component
// stays a wire between an event and these functions.
//
// The collision that matters is pinned here rather than described in a comment:
// the band already owns the bare arrow keys for its event scrub, so the viewport
// may only have them with a modifier.

import { describe, expect, it } from "vitest";
import {
  stripGripAt,
  stripResize,
  applyIntent,
  buttonToIntent,
  followMark,
  keyToIntent,
  stripWindowFromPointer,
  wheelToIntent,
  zoomEnabled,
} from "./gestures";
import type { LaneTick, TickKind } from "./spectrumModel";
import { fit, minWidthFor, rebase, storeWindow, type Window } from "./viewport";

const M = 0.01;
const tick = (x: number, kind: TickKind, seq: number): LaneTick => ({ x, kind, seq });
const ctx = (over: Partial<Parameters<typeof applyIntent>[2]> = {}) => ({
  anchorPx: 500,
  widthPx: 1000,
  minW: M,
  ticks: [] as LaneTick[],
  ...over,
});

describe("wheelToIntent", () => {
  it("zooms when the gesture carries ctrl, which is also how a trackpad pinch arrives", () => {
    const i = wheelToIntent(0, -40, true, 1000);
    expect(i?.kind).toBe("zoom");
  });

  it("zooms IN on a negative deltaY and out on a positive one", () => {
    const zin = wheelToIntent(0, -40, true, 1000);
    const zout = wheelToIntent(0, 40, true, 1000);
    expect(zin).toMatchObject({ kind: "zoom" });
    expect(zout).toMatchObject({ kind: "zoom" });
    if (zin?.kind !== "zoom" || zout?.kind !== "zoom") throw new Error("not a zoom");
    expect(zin.factor).toBeLessThan(1);
    expect(zout.factor).toBeGreaterThan(1);
  });

  it("never returns a runaway factor, however hard the wheel is spun", () => {
    for (const dy of [-100000, -5000, 5000, 100000]) {
      const i = wheelToIntent(0, dy, true, 1000);
      if (i?.kind !== "zoom") throw new Error("not a zoom");
      expect(i.factor).toBeGreaterThan(0.05);
      expect(i.factor).toBeLessThan(20);
    }
  });

  it("pans on a horizontal wheel, preferring deltaX", () => {
    const i = wheelToIntent(120, 4, false, 1000);
    expect(i).toMatchObject({ kind: "pan" });
    if (i?.kind !== "pan") throw new Error("not a pan");
    // 120px of a 1000px viewport is 12% of the visible window.
    expect(i.byWindows).toBeCloseTo(0.12, 12);
  });

  it("leaves a plain VERTICAL wheel alone so the lane list keeps its scroll", () => {
    // Hijacking the page scroll over a band is hostile with twenty lanes on
    // screen. Vertical belongs to the document; horizontal belongs to the axis.
    expect(wheelToIntent(0, 120, false, 1000)).toBeNull();
    expect(wheelToIntent(3, 120, false, 1000)).toBeNull();
  });

  it("stays null rather than dividing by a viewport that has not been measured", () => {
    expect(wheelToIntent(120, 0, false, 0)).toBeNull();
  });
});

describe("keyToIntent", () => {
  it("returns null for a bare arrow so the band keeps its event scrub", () => {
    expect(keyToIntent("ArrowLeft", false)).toBeNull();
    expect(keyToIntent("ArrowRight", false)).toBeNull();
  });

  it("pans only with shift held", () => {
    expect(keyToIntent("ArrowRight", true)).toMatchObject({ kind: "pan" });
    expect(keyToIntent("ArrowLeft", true)).toMatchObject({ kind: "pan" });
    const right = keyToIntent("ArrowRight", true);
    const left = keyToIntent("ArrowLeft", true);
    if (right?.kind !== "pan" || left?.kind !== "pan") throw new Error("not a pan");
    expect(right.byWindows).toBeGreaterThan(0);
    expect(left.byWindows).toBe(-right.byWindows);
  });

  it("zooms on plus and minus, accepting the unshifted equals sign as plus", () => {
    for (const k of ["+", "="]) {
      const i = keyToIntent(k, false);
      if (i?.kind !== "zoom") throw new Error(`${k} is not a zoom`);
      expect(i.factor).toBeLessThan(1);
    }
    const out = keyToIntent("-", false);
    if (out?.kind !== "zoom") throw new Error("not a zoom");
    expect(out.factor).toBeGreaterThan(1);
  });

  it("fits on zero, and jumps to either end", () => {
    expect(keyToIntent("0", false)).toEqual({ kind: "fit" });
    expect(keyToIntent("Home", false)).toEqual({ kind: "home" });
    expect(keyToIntent("End", false)).toEqual({ kind: "end" });
  });

  it("pages across dead air with the brackets", () => {
    expect(keyToIntent("]", false)).toEqual({ kind: "page", dir: 1 });
    expect(keyToIntent("[", false)).toEqual({ kind: "page", dir: -1 });
  });

  it("returns null for anything it does not own", () => {
    for (const k of ["Enter", "Escape", "a", "Tab", "ArrowUp", "PageDown"]) {
      expect(keyToIntent(k, false)).toBeNull();
    }
  });
});

describe("applyIntent", () => {
  it("zooms around the pointer, which stays under the cursor", () => {
    const win = { a: 0, b: 1 };
    const next = applyIntent(win, { kind: "zoom", factor: 0.5 }, ctx({ anchorPx: 250 }));
    // The anchor is the domain fraction 0.25; it must still sit a quarter of the
    // way across the narrower window.
    expect((0.25 - next.a) / (next.b - next.a)).toBeCloseTo(0.25, 12);
  });

  it("pans by a share of the VISIBLE window, so a drag means less time when zoomed in", () => {
    // The same gesture: half the domain wide it covers 0.05, a tenth wide 0.01.
    const wide = applyIntent({ a: 0.2, b: 0.7 }, { kind: "pan", byWindows: 0.1 }, ctx());
    expect(wide.a).toBeCloseTo(0.25, 12);
    expect(wide.b - wide.a).toBeCloseTo(0.5, 12);
    const narrow = applyIntent({ a: 0.4, b: 0.5 }, { kind: "pan", byWindows: 0.1 }, ctx());
    expect(narrow.a).toBeCloseTo(0.41, 12);
    expect(narrow.b - narrow.a).toBeCloseTo(0.1, 12);
  });

  it("pans nowhere at full extent, because there is nowhere to go", () => {
    expect(applyIntent(fit(), { kind: "pan", byWindows: 0.5 }, ctx())).toEqual({ a: 0, b: 1 });
  });

  it("fits to the whole", () => {
    expect(applyIntent({ a: 0.4, b: 0.5 }, { kind: "fit" }, ctx())).toEqual({ a: 0, b: 1 });
  });

  it("jumps to either end without changing the zoom level", () => {
    const home = applyIntent({ a: 0.4, b: 0.5 }, { kind: "home" }, ctx());
    expect(home.a).toBe(0);
    expect(home.b - home.a).toBeCloseTo(0.1, 12);
    const end = applyIntent({ a: 0.4, b: 0.5 }, { kind: "end" }, ctx());
    expect(end.b).toBeCloseTo(1, 12);
    expect(end.b - end.a).toBeCloseTo(0.1, 12);
  });

  it("pages forward and back over the marks it is given", () => {
    const ticks = [tick(0.3, "token", 0), tick(0.9, "token", 1)];
    const win = { a: 0.25, b: 0.35 };
    const fwd = applyIntent(win, { kind: "page", dir: 1 }, ctx({ ticks }));
    // One window on is empty axis, so it snaps the next mark to the left edge.
    expect(fwd.a).toBeCloseTo(0.9, 12);
    const back = applyIntent(fwd, { kind: "page", dir: -1 }, ctx({ ticks }));
    // Coming back, the previous mark returns to the RIGHT edge: you land where
    // the earlier work ended, not where it started.
    expect(back.b).toBeCloseTo(0.3, 12);
  });

  it("holds the window when the viewport has no width yet", () => {
    const win = { a: 0.4, b: 0.5 };
    expect(applyIntent(win, { kind: "zoom", factor: 0.5 }, ctx({ widthPx: 0 }))).toEqual(win);
  });
});

describe("stripWindowFromPointer", () => {
  it("centres the current window width on the pointer", () => {
    const w = stripWindowFromPointer({ a: 0, b: 0.1 }, 500, 1000, M);
    expect(w.a).toBeCloseTo(0.45, 12);
    expect(w.b).toBeCloseTo(0.55, 12);
  });

  it("clamps at either edge as a rigid body, keeping the width", () => {
    const left = stripWindowFromPointer({ a: 0.5, b: 0.6 }, 0, 1000, M);
    expect(left.a).toBe(0);
    expect(left.b - left.a).toBeCloseTo(0.1, 12);
    const right = stripWindowFromPointer({ a: 0.5, b: 0.6 }, 1000, 1000, M);
    expect(right.b).toBeCloseTo(1, 12);
    expect(right.b - right.a).toBeCloseTo(0.1, 12);
  });

  it("holds the window when the strip has not been measured", () => {
    const win = { a: 0.5, b: 0.6 };
    expect(stripWindowFromPointer(win, 40, 0, M)).toEqual(win);
  });
});

describe("followMark", () => {
  it("leaves the window untouched while the walk stays inside it", () => {
    const win = { a: 0.4, b: 0.5 };
    expect(followMark(win, 0.45, 0.01)).toEqual(win);
    // The edges count as inside: a mark drawn exactly on the pad is on screen.
    expect(followMark(win, 0.4, 0.01)).toEqual(win);
    expect(followMark(win, 0.5, 0.01)).toEqual(win);
  });

  it("shifts by the least it can when the walk steps off an edge, and keeps the zoom", () => {
    // Arrowing past the edge of a zoomed window must bring the event on screen.
    // Otherwise the scrub line and its tooltip anchor outside the band, naming an
    // event at a place where nothing is drawn. Least movement, because a scrubber
    // running along should read as the axis following the reader, not jumping.
    const win = { a: 0.4, b: 0.5 };
    const back = followMark(win, 0.35, 0.01);
    expect(back.a).toBeCloseTo(0.35, 9);
    expect(back.b - back.a).toBeCloseTo(0.1, 9);
    const on = followMark(win, 0.62, 0.01);
    expect(on.b).toBeCloseTo(0.62, 9);
    expect(on.b - on.a).toBeCloseTo(0.1, 9);
  });

  it("stops at the domain edge instead of walking the window out of the domain", () => {
    expect(followMark({ a: 0, b: 0.1 }, 0, 0.01)).toEqual({ a: 0, b: 0.1 });
    const end = followMark({ a: 0.9, b: 1 }, 1, 0.01);
    expect(end.b).toBeLessThanOrEqual(1);
    expect(end.a).toBeGreaterThanOrEqual(0);
  });
});

// The owner reported the wheel as dead and asked for plus and minus buttons.
// The wheel turned out to be bound and working, but it needs ctrl held, and
// nothing on screen says so. These buttons are the discoverable form of the same
// gesture, so the thing they must never do is grow a second vocabulary: a button
// that zooms by a different step than the key it mirrors is two features that
// drift. They are pinned to keyToIntent rather than to a copy of its numbers.
describe("buttonToIntent", () => {
  it("speaks the SAME intent as the key it mirrors, so the two cannot drift", () => {
    expect(buttonToIntent("in")).toEqual(keyToIntent("+", false));
    expect(buttonToIntent("out")).toEqual(keyToIntent("-", false));
    expect(buttonToIntent("fit")).toEqual(keyToIntent("0", false));
  });

  it("narrows on in and widens on out", () => {
    const i = buttonToIntent("in");
    const o = buttonToIntent("out");
    expect(i.kind).toBe("zoom");
    expect(o.kind).toBe("zoom");
    if (i.kind === "zoom" && o.kind === "zoom") {
      expect(i.factor).toBeLessThan(1);
      expect(o.factor).toBeGreaterThan(1);
    }
  });
});

describe("zoomEnabled", () => {
  it("cannot zoom out or fit at full extent, because that IS the whole", () => {
    const e = zoomEnabled(fit(), M);
    expect(e.out).toBe(false);
    expect(e.fit).toBe(false);
    expect(e.in).toBe(true);
  });

  it("cannot zoom in at the floor, which is the limit the button has to admit to", () => {
    const e = zoomEnabled({ a: 0.5, b: 0.5 + M }, M);
    expect(e.in).toBe(false);
    expect(e.out).toBe(true);
    expect(e.fit).toBe(true);
  });

  it("offers all three from a window that is neither the whole nor the floor", () => {
    expect(zoomEnabled({ a: 0.25, b: 0.75 }, M)).toEqual({ in: true, out: true, fit: true });
  });

  // The property that makes "disabled" honest rather than decorative: a button is
  // enabled EXACTLY when pressing it would move the window. Anything else is a
  // control that either lies about being dead or goes dead quietly.
  it("is enabled exactly when the press would actually change the window", () => {
    const ctxAt = { anchorPx: 500, widthPx: 1000, minW: M, ticks: [] as LaneTick[] };
    let win = fit();
    for (let step = 0; step < 40; step++) {
      const enabled = zoomEnabled(win, M);
      for (const b of ["in", "out", "fit"] as const) {
        const next = applyIntent(win, buttonToIntent(b), ctxAt);
        const moved = Math.abs(next.a - win.a) > 1e-12 || Math.abs(next.b - win.b) > 1e-12;
        expect({ button: b, step, enabled: enabled[b] }).toEqual({ button: b, step, enabled: moved });
      }
      win = applyIntent(win, buttonToIntent("in"), ctxAt);
    }
  });

  // A stream shorter than the zoom floor gets minW 1 from minWidthFor, so the
  // whole IS the floor. Every control must then be off rather than inviting a
  // press that cannot do anything.
  it("offers nothing when the floor is the whole domain", () => {
    expect(zoomEnabled(fit(), 1)).toEqual({ in: false, out: false, fit: false });
  });
});

// The wheel used to be handed a deltaX already scaled into the band's 1000-unit
// viewBox while deltaY arrived raw, so the axis verdict depended on how wide the
// band happened to be drawn. Both numbers now arrive in the space the browser
// reported them in, and this pins that the verdict cannot move with the layout.
describe("the wheel's axis, settled in one space", () => {
  it("gives the same swipe the same verdict at any band width", () => {
    // One physical trackpad swipe, mostly horizontal, on four band widths a real
    // window produces. It panned the spectrum on a laptop and scrolled the page
    // on a wide monitor.
    for (const widthPx of [300, 604, 764, 1884]) {
      expect(wheelToIntent(12, 10, false, widthPx)?.kind).toBe("pan");
    }
  });

  it("never claims a mostly VERTICAL swipe, however narrow the band is", () => {
    // The other direction of the same defect: a scaled-up dx won the comparison
    // on a narrow band, and the handler then took the page scroll it exists to
    // protect.
    for (const widthPx of [300, 604, 764, 1884]) {
      expect(wheelToIntent(10, 15, false, widthPx)).toBeNull();
    }
  });

  it("measures the pan against the width the deltas were reported in", () => {
    // 120 css px of a 600 px band is a fifth of the visible window.
    const i = wheelToIntent(120, 4, false, 600);
    if (i?.kind !== "pan") throw new Error("not a pan");
    expect(i.byWindows).toBeCloseTo(0.2, 12);
  });
});

// The owner-visible defect behind the fit button: it stored the pair {0,1} where
// this view documents null as the only way to say "the whole". On a live stream
// the whole keeps moving, so the next arriving event rebased that pair into a
// window that is no longer everything, the button the reader had just pressed
// lit back up, and the newest events sat off the right edge of a view whose
// button reads "show everything".
describe("pressing fit on a live stream", () => {
  const SPAN = 60_000;
  const press = (win: Window) =>
    storeWindow(applyIntent(win, buttonToIntent("fit"), ctx({ minW: minWidthFor(SPAN, 1_000) })));

  it("goes back to following the live edge instead of freezing the window", () => {
    expect(press({ a: 0.4, b: 0.6 })).toBeNull();
  });

  it("leaves nothing for an arriving event to rebase, so the button stays pressed", () => {
    const stored = press({ a: 0.4, b: 0.6 });
    // A stored pair would come back from rebase as {0, 0.9836} one second later,
    // which re-enables both controls that are supposed to be at their limit.
    const win = stored === null ? fit() : rebase(stored, 0, SPAN, 0, SPAN + 1_000);
    expect(win).toEqual({ a: 0, b: 1 });
    const enabled = zoomEnabled(win, minWidthFor(SPAN + 1_000, 1_000));
    expect(enabled.out).toBe(false);
    expect(enabled.fit).toBe(false);
  });

  it("stores a window that is genuinely narrower, untouched", () => {
    const zoomed = applyIntent(fit(), buttonToIntent("in"), ctx({ minW: minWidthFor(SPAN, 1_000) }));
    expect(storeWindow(zoomed)).toEqual(zoomed);
  });
});

// The window's ends can be grabbed (owner, 2026-08-05: "die anfasser sind
// immernoch nicht da"). No knobs are drawn — the box stays exactly as wide as
// the window it stands for — so the generosity lives entirely in the hit zone.
describe("stripGripAt", () => {
  const wide = { a: 0.2, b: 0.8 }; // 600px of a 1000px strip

  it("finds the end the pointer is nearest", () => {
    expect(stripGripAt(wide, 200, 1000, 6)).toBe("start");
    expect(stripGripAt(wide, 800, 1000, 6)).toBe("end");
    expect(stripGripAt(wide, 500, 1000, 6)).toBe("body");
  });

  it("reaches as far as the grab zone and no further", () => {
    expect(stripGripAt(wide, 206, 1000, 6)).toBe("start");
    expect(stripGripAt(wide, 207, 1000, 6)).toBe("body");
    expect(stripGripAt(wide, 794, 1000, 6)).toBe("end");
    expect(stripGripAt(wide, 793, 1000, 6)).toBe("body");
  });

  it("has no ends at all when the window is too narrow to have two", () => {
    // The objection that kept handles out: at the zoom floor the box is a
    // fraction of a pixel. Two zones need room to be two — below that the
    // window is one thing, and reaching for it means the whole of it.
    const hair = { a: 0.5, b: 0.5008 }; // under a pixel of 1000
    expect(stripGripAt(hair, 500, 1000, 6)).toBe("body");
    expect(stripGripAt(hair, 500.4, 1000, 6)).toBe("body");
  });

  it("says body for a pointer that is not a number, or a strip with no width", () => {
    expect(stripGripAt(wide, Number.NaN, 1000, 6)).toBe("body");
    expect(stripGripAt(wide, 200, 0, 6)).toBe("body");
  });
});

describe("stripResize", () => {
  const win = { a: 0.2, b: 0.8 };

  it("moves the end that is held and leaves the other alone", () => {
    expect(stripResize(win, "start", 400, 1000, 0.001)).toEqual({ a: 0.4, b: 0.8 });
    expect(stripResize(win, "end", 600, 1000, 0.001)).toEqual({ a: 0.2, b: 0.6 });
  });

  it("does not flip the window when an end is dragged past the other", () => {
    // A window whose start is after its end is not a thing this app can show,
    // so the drag stops at the floor instead of turning inside out.
    const flipped = stripResize(win, "start", 950, 1000, 0.01);
    expect(flipped.a).toBeLessThan(flipped.b);
    expect(flipped.b).toBeCloseTo(0.8, 5);
    const other = stripResize(win, "end", 50, 1000, 0.01);
    expect(other.a).toBeLessThan(other.b);
    expect(other.a).toBeCloseTo(0.2, 5);
  });

  it("honours the zoom floor", () => {
    const tight = stripResize(win, "start", 799, 1000, 0.05);
    expect(tight.b - tight.a).toBeGreaterThanOrEqual(0.05 - 1e-9);
  });

  it("leaves the window alone for a body grip, which pans instead", () => {
    expect(stripResize(win, "body", 400, 1000, 0.001)).toEqual(win);
  });
});
