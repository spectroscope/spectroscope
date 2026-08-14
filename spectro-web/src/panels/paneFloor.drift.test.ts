// Card 219 — the pane floor is DERIVED, not chosen, and this file is the wire
// that keeps the two projects agreeing on it.
//
// The desktop shell refuses a reported rectangle smaller than MIN_PANE
// (spectro-desktop/src/paneBounds.ts): isUsable() rejects it and layout() falls
// back to "the right two-thirds under a 48px strip" — the pane JUMPS somewhere
// the frame is not. A dock panel can easily be dragged below that floor, so the
// web side must know the same number and post `visible: false` instead of a
// rectangle the shell would refuse. Same coupling style as
// browserMarker.drift.test.ts: two projects, one constant, no type between.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PANE_FLOOR, paneVisibility } from "../browser/viewport";

const repo = path.join(__dirname, "..", "..", "..");
const paneBounds = readFileSync(path.join(repo, "spectro-desktop", "src", "paneBounds.ts"), "utf8");
const segment = readFileSync(path.join(__dirname, "..", "browser", "BrowserSegment.tsx"), "utf8");

describe("one floor, two projects", () => {
  it("matches the shell's MIN_PANE byte for byte", () => {
    const m = paneBounds.match(/MIN_PANE = \{ width: (\d+), height: (\d+) \}/);
    expect(m).not.toBeNull();
    expect(PANE_FLOOR.width).toBe(Number(m![1]));
    expect(PANE_FLOOR.height).toBe(Number(m![2]));
  });

  it("is consulted by the segment before a rectangle is posted", () => {
    expect(segment).toContain("paneVisibility(");
  });

  it("re-reports when the dock's layout commits, not only when the hole resizes", () => {
    // The effect must be keyed on the nonce the dock bumps per layout change —
    // a swap or a neighbour closing can move the hole without resizing it.
    expect(segment).toMatch(/props\.reportNonce/);
  });
});

describe("what the floor decides", () => {
  it("hides an unwanted pane regardless of size", () => {
    expect(paneVisibility({ width: 800, height: 600 }, false, true)).toEqual({
      visible: false,
      belowFloor: false,
    });
  });

  it("floors only when the guard is on — the whole-surface doors keep today's shape", () => {
    expect(paneVisibility({ width: 100, height: 100 }, true, false)).toEqual({
      visible: true,
      belowFloor: false,
    });
  });

  it("refuses a rectangle the shell would refuse, and says why", () => {
    expect(paneVisibility({ width: PANE_FLOOR.width - 1, height: 600 }, true, true)).toEqual({
      visible: false,
      belowFloor: true,
    });
    expect(paneVisibility({ width: 600, height: PANE_FLOOR.height - 1 }, true, true)).toEqual({
      visible: false,
      belowFloor: true,
    });
  });

  it("posts the exact floor as visible — the boundary belongs to the pane", () => {
    expect(paneVisibility({ width: PANE_FLOOR.width, height: PANE_FLOOR.height }, true, true)).toEqual({
      visible: true,
      belowFloor: false,
    });
  });
});
