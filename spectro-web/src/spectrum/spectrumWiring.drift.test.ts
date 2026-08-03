// How the Spectrum's window and the band's wheel are WIRED, read off disk.
//
// The arithmetic is pure and pinned next door. What no unit test in a suite
// without a DOM can see is the .tsx line that composes it, and all three defects
// below lived exactly there:
//
//   - the readout asked whether the state slot had ever been written instead of
//     whether the window is narrower than the whole, so pressing "all" printed
//     the total span twice and never stopped.
//   - the raw setter was handed to three children, so "all" stored the pair
//     {0,1} where the view documents null as the only way to say "the whole";
//     the next arriving event rebased that pair and the button lit up again.
//   - the band scaled deltaX into its 1000-unit viewBox and compared it against
//     a raw deltaY, so the same trackpad swipe panned on a laptop and scrolled
//     the page on a wide monitor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const view = read("./SpectrumView.tsx");
const band = read("./SpectrumBand.tsx");

describe("the window readout", () => {
  it("asks the window, not the state slot, whether the reader has left the whole", () => {
    const line = view.split("\n").find((l) => l.includes("sp.ofSpan"));
    expect(line).toContain("isWhole(win)");
    expect(line).not.toContain("winState !== null");
  });
});

describe("one rule stores the window", () => {
  it("hands no child the raw setter, so the buttons and the keys cannot drift", () => {
    expect(view).not.toContain("setWinState}");
    expect(view).not.toContain("? setWinState :");
  });

  it("keeps exactly one writer, and it goes through the sentinel rule", () => {
    expect(view.split("setWinState(").length - 1).toBe(1);
    expect(view).toContain("setWinState(storeWindow(");
  });
});

describe("the band's wheel", () => {
  it("settles the axis on the raw deltas, in one space", () => {
    // viewBoxX scales deltaX by 1000/rect.width. Comparing that against a raw
    // deltaY decides which axis owns the gesture by how wide the band happens
    // to be drawn, and at a narrow band it claims a vertical swipe and traps
    // the page scroll the handler's own comment says it is protecting.
    expect(band).not.toContain("viewBoxX(e.deltaX");
    const from = band.indexOf("wheelToIntent(");
    const call = band.slice(from, band.indexOf(");", from));
    expect(call).toContain("e.deltaX");
    expect(call).toContain("e.deltaY");
    expect(call).toContain("innerWidthPx(");
  });
});
