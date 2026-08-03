import { describe, it, expect } from "vitest";
import { fracAt, markX, seqAt, viewBoxX } from "./bandGeometry";
import { seqAtFrac } from "./bandScrub";
import { fit, normalize } from "./viewport";
import type { LaneTick } from "./spectrumModel";

const W = 1000;
const PAD = 4;
const INNER = W - 2 * PAD;

const tick = (x: number, seq: number): LaneTick => ({ x, kind: "token", seq });

describe("markX", () => {
  it("puts the window's own edges at the pads, whatever the window is", () => {
    for (const win of [fit(), { a: 0.5, b: 0.51 }, { a: 0.9, b: 1 }]) {
      expect(markX(win.a, win, W, PAD)).toBeCloseTo(PAD, 6);
      expect(markX(win.b, win, W, PAD)).toBeCloseTo(PAD + INNER, 6);
    }
  });

  it("draws at full extent exactly where the band has always drawn", () => {
    // The geometry the band carried before there was a window. Zoom is only
    // allowed to be a new capability, never a silent nudge of every mark.
    for (const x of [0, 0.25, 0.5, 0.731, 1]) {
      expect(markX(x, fit(), W, PAD)).toBeCloseTo(PAD + x * INNER, 6);
    }
  });

  it("spreads two neighbouring marks apart as the window narrows around them", () => {
    const wide = markX(0.5001, fit(), W, PAD) - markX(0.5, fit(), W, PAD);
    const deep = markX(0.5001, { a: 0.5, b: 0.5002 }, W, PAD) - markX(0.5, { a: 0.5, b: 0.5002 }, W, PAD);
    expect(wide).toBeLessThan(1);
    expect(deep).toBeGreaterThan(400);
  });

  it("leaves a mark outside the window outside the drawn area instead of clamping it onto the edge", () => {
    // Clamping would pile every earlier event onto the left pad, drawing a wall
    // of marks at an instant none of them happened at.
    expect(markX(0.1, { a: 0.5, b: 0.6 }, W, PAD)).toBeLessThan(PAD);
    expect(markX(0.9, { a: 0.5, b: 0.6 }, W, PAD)).toBeGreaterThan(PAD + INNER);
  });

  it("stays finite on a collapsed window rather than emitting NaN into an svg", () => {
    expect(Number.isFinite(markX(0.5, { a: 0.5, b: 0.5 }, W, PAD))).toBe(true);
    expect(Number.isFinite(markX(0.5, fit(), 0, PAD))).toBe(true);
  });
});

describe("viewBoxX", () => {
  it("carries a pointer from the element the reader touched into the coordinates the band draws in", () => {
    // The svg scales a fixed 1000-unit viewBox onto whatever width the lane got,
    // so a pointer measured in layout pixels means nothing until it is converted.
    expect(viewBoxX(0, 500, W)).toBe(0);
    expect(viewBoxX(250, 500, W)).toBe(500);
    expect(viewBoxX(500, 500, W)).toBe(W);
  });

  it("returns null for an element with no width instead of dividing by zero", () => {
    expect(viewBoxX(10, 0, W)).toBeNull();
  });

  it("round-trips against markX, so what is drawn is what gets pointed at", () => {
    const win = { a: 0.3, b: 0.31 };
    const rectW = 640;
    const drawn = markX(0.305, win, W, PAD);
    const pointerPx = (drawn / W) * rectW;
    expect(fracAt(viewBoxX(pointerPx, rectW, W) ?? -1, W, PAD, win)).toBeCloseTo(0.305, 9);
  });
});

describe("fracAt", () => {
  it("reads a pointer back to the fraction the mark was drawn from", () => {
    const win = { a: 0.25, b: 0.3 };
    for (const x of [0.25, 0.27, 0.3]) {
      expect(fracAt(markX(x, win, W, PAD), W, PAD, win)).toBeCloseTo(x, 9);
    }
  });

  it("clamps to the window rather than reporting time that is not on screen", () => {
    const win = { a: 0.4, b: 0.5 };
    expect(fracAt(-50, W, PAD, win)).toBeCloseTo(0.4, 9);
    expect(fracAt(W + 50, W, PAD, win)).toBeCloseTo(0.5, 9);
  });

  it("returns null for a band that has not been measured yet", () => {
    expect(fracAt(10, 0, PAD, fit())).toBeNull();
  });
});

describe("seqAt", () => {
  const ticks = [tick(0.1, 1), tick(0.5, 2), tick(0.9, 3)];

  it("scrubs only what the window shows, so a zoomed reader cannot land on an event that is off screen", () => {
    // The whole bug in one assertion. Hit-testing the FULL lane is right at full
    // extent and wrong the moment there is a window. Zoom into a burst and the
    // event just before the left edge is nearer to a pointer at that edge than
    // anything inside the window is: 0.001 away against 0.1. Scanning the lane
    // hands back that outside mark, whose rect is drawn past the pad and off the
    // band, so the tooltip names an event the reader cannot see and the scrub
    // line stands where nothing was drawn.
    const win = { a: 0.45, b: 0.55 };
    const straddling = [tick(0.449, 11), tick(0.55, 12), tick(0.551, 13)];
    expect(seqAt(straddling, PAD, W, PAD, win)).toBe(12);
    expect(seqAt(straddling, PAD + INNER, W, PAD, win)).toBe(12);
    // And what it returns is always something the band actually put on screen.
    const seq = seqAt(straddling, PAD, W, PAD, win);
    const landed = straddling.find((t) => t.seq === seq);
    expect(markX(landed?.x ?? -1, win, W, PAD)).toBeGreaterThanOrEqual(PAD);
    expect(markX(landed?.x ?? -1, win, W, PAD)).toBeLessThanOrEqual(PAD + INNER);
  });

  it("returns null when the window is over empty axis", () => {
    expect(seqAt(ticks, W / 2, W, PAD, { a: 0.2, b: 0.3 })).toBeNull();
  });

  it("lands at full extent on the same event the band always landed on", () => {
    for (const px of [0, 250, 500, 900, W]) {
      const frac = Math.min(1, Math.max(0, (px - PAD) / INNER));
      expect(seqAt(ticks, px, W, PAD, fit())).toBe(seqAtFrac(ticks, frac));
    }
  });

  it("picks the nearer of two marks inside the window", () => {
    const win = normalize(0, 1, 0);
    expect(seqAt([tick(0.2, 7), tick(0.8, 9)], PAD + 0.21 * INNER, W, PAD, win)).toBe(7);
    expect(seqAt([tick(0.2, 7), tick(0.8, 9)], PAD + 0.79 * INNER, W, PAD, win)).toBe(9);
  });

  it("stays calm on an empty lane and an unmeasured band", () => {
    expect(seqAt([], 10, W, PAD, fit())).toBeNull();
    expect(seqAt(ticks, 10, 0, PAD, fit())).toBeNull();
  });
});
