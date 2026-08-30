import { describe, expect, it } from "vitest";
import { osBandWidth, stationSeats } from "./stationSeats";
import { readFileSync } from "node:fs";
import { COMPACT_BROWSER_H, COMPACT_BROWSER_W, OS_BAND_H, OS_STATION_DY } from "./sceneToFlow";

describe("stationSeats (the OS band derives from its stations, card 287)", () => {
  it("seats stations left-to-right with equal gaps", () => {
    expect(stationSeats([260, 460, 500, 104], 58, 26)).toEqual([58, 344, 830, 1356]);
  });

  it("derives the band width from the last seat plus pad", () => {
    // last seat 1356 + net 104 + pad 34 − the band's own x 24
    expect(osBandWidth([260, 460, 500, 104], 58, 26, 34)).toBe(1470);
  });

  it("with the compact widths it reproduces the hand-authored seats", () => {
    // the COMMON table's 58/236/462/678 in the 792 band came from exactly
    // these widths and gaps — the derivation replaces the transcription
    expect(stationSeats([152, 200, 190, 104], 58, 26)).toEqual([58, 236, 462, 678]);
    expect(osBandWidth([152, 200, 190, 104], 58, 26, 34)).toBe(792);
  });
});

// ---------------------------------------------------------------------------
// ROUND 2 — the two copies of the compact browser width are held together.
//
// `COMPACT_BROWSER_W` in sceneToFlow sizes the `z-os` frame and seats the
// fifth station; `.pf-os--browser` in flowmap.css paints the card. The frame
// derives from the first and the card from the second, so nothing went red if
// they came apart — and a card wider than the frame that holds it draws
// through its side. This reads the NUMBER out of the declaration rather than
// matching its text, so a reformat cannot break it and a changed value must.
// ---------------------------------------------------------------------------
describe("the browser station is one width, not two (card 330, round 2)", () => {
  const css = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");

  const widthOf = (selector: string): number => {
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    expect(rule, `${selector} has no rule in flowmap.css`).not.toBeNull();
    const w = /width:\s*([\d.]+)px/.exec(rule![1]);
    expect(w, `${selector} declares no px width`).not.toBeNull();
    return Number(w![1]);
  };

  it("the stylesheet paints the width the layout reserves", () => {
    expect(widthOf(".pf-os--browser")).toBe(COMPACT_BROWSER_W);
  });

  it("and the band derived from those widths is wide enough to hold the row", () => {
    // The derivation the frame actually uses, checked against the row it holds:
    // last seat + last width + the same air the first station gets.
    const widths = [152, 200, 190, 104, COMPACT_BROWSER_W];
    const xs = stationSeats(widths);
    expect(osBandWidth(widths)).toBeGreaterThanOrEqual(xs[4] + widths[4] - 24);
  });

  it("the compact browser card fits between its seat and the band's floor", () => {
    // MEASURED, and the reason the compact card names its state instead of
    // drawing the page — see COMPACT_BROWSER_H. Rendering the artefact
    // measured 202.44 against the 156 this asserts.
    expect(OS_STATION_DY + COMPACT_BROWSER_H).toBeLessThanOrEqual(OS_BAND_H);
  });
});
