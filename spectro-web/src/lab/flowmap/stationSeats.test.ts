import { describe, expect, it } from "vitest";
import { osBandWidth, stationSeats } from "./stationSeats";

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
