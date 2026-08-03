// Input mapping is pure. There is no DOM in this suite, so a component that did
// this arithmetic inline would be untestable by construction; the component
// stays a wire between an event and these functions.
//
// The collision that matters is pinned here rather than described in a comment:
// the band already owns the bare arrow keys for its event scrub, so the viewport
// may only have them with a modifier.

import { describe, expect, it } from "vitest";
import { applyIntent, keyToIntent, stripWindowFromPointer, wheelToIntent } from "./gestures";
import type { LaneTick, TickKind } from "./spectrumModel";
import { fit } from "./viewport";

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
