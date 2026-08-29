// Card 303, defect B: the replay scrub collapsed to four pixels.
//
// MEASURED on the merged head with getBoundingClientRect().width over
// .lab-scrub-track, dock CLOSED: 1440px viewport -> 672.9, 1100 -> 326.3,
// 900 -> 126.3, 771 -> 4.0. With the dock OPEN it was already 16.3 at 1100 and
// 4.0 at 950. In the linear stretch the track is exactly the leftover: every
// pixel taken off the viewport came off the track (1100 -> 900 moved it by
// 200.0), because the track was the only thing in the row that could shrink.
//
// So the row spent its last pixels on the pills, the counter and the clock and
// handed the scrub what was left — while the scrub is the control the row
// exists for, and card 299's chapter marks live on it. It stayed present and
// stopped working, which is the worst of the three possible outcomes.
//
// This decides, in one pure function, what the row gives up and in what order.
// No DOM: a threshold that only exists in a stylesheet cannot be reasoned about
// and cannot be bitten branch by branch.
import { describe, expect, it } from "vitest";
import {
  SCRUB_MIN_WIDTH,
  TRANSPORT_YIELD_ORDER,
  dropWidthOf,
  scrubWidthIn,
  transportFit,
  type TransportPart,
} from "./transportFit";

const ALL: readonly TransportPart[] = TRANSPORT_YIELD_ORDER;
const kept = (w: number): TransportPart[] => ALL.filter((p) => transportFit(w)[p]);

/** THE FLOOR'S OWN FLOOR, and the reason this literal is written out rather
 *  than taken from the module.
 *
 *  Every other assertion in this file is relative to SCRUB_MIN_WIDTH, and the
 *  stylesheet's breakpoints are derived from it too — so the whole set stays
 *  green if the constant itself walks back down to the defect. Bitten, and it
 *  does: with SCRUB_MIN_WIDTH edited to 4 and the four @container widths
 *  regenerated from it, all eleven tests across both files passed while the
 *  scrub was four pixels wide again. A number that every check is measured
 *  against cannot also be the thing under test. This one is absolute. */
const NEVER_BELOW = 200;

describe("what the transport row gives up, and in what order", () => {
  it("states a floor that is a floor, not whatever the row had left", () => {
    // 4.0px was the measured defect. Anything in that neighbourhood is the
    // same defect wearing a constant's name.
    expect(SCRUB_MIN_WIDTH).toBeGreaterThanOrEqual(NEVER_BELOW);
  });

  it("keeps every part on a roomy row", () => {
    expect(kept(1440)).toEqual([...ALL]);
    expect(scrubWidthIn(1440, transportFit(1440))).toBeGreaterThanOrEqual(SCRUB_MIN_WIDTH);
  });

  it("yields in the stated order: pills, then clock, then counter, then more", () => {
    // Stated, and each with its reason:
    //   the speed pills go first — a pill only matters while the run is
    //     PLAYING, which is the opposite of scrubbing, and the same tempo sits
    //     in the "more" drawer, so nothing becomes unreachable;
    //   the clock next — it is a second reading of the position the counter
    //     already gives;
    //   the counter after it — the slider's own thumb still shows the position,
    //     less precisely;
    //   "more" last, because once the pills are gone it is the only speed
    //     control the row still has.
    expect(TRANSPORT_YIELD_ORDER).toEqual(["pills", "clock", "counter", "advanced"]);
    const order = [...ALL].sort((a, b) => dropWidthOf(b) - dropWidthOf(a));
    expect(order).toEqual([...ALL]);
    for (let i = 1; i < ALL.length; i++) {
      expect(dropWidthOf(ALL[i - 1]), ALL[i - 1]).toBeGreaterThan(dropWidthOf(ALL[i]));
    }
  });

  it("drops each part exactly at its own width, and not one pixel earlier", () => {
    for (const part of ALL) {
      const at = dropWidthOf(part);
      expect(transportFit(at)[part], `${part} at ${at}`).toBe(false);
      expect(transportFit(at + 1)[part], `${part} at ${at + 1}`).toBe(true);
    }
  });

  it("never takes a part back as the row gets narrower", () => {
    for (let w = 1600; w > 200; w -= 1) {
      for (const part of ALL) {
        if (!transportFit(w)[part]) expect(transportFit(w - 1)[part], `${part} at ${w}`).toBe(false);
      }
    }
  });

  it("gives the scrub its minimum wherever the row can pay for it", () => {
    // The whole point. Above the floor the row always finds SCRUB_MIN_WIDTH by
    // dropping something; below it there is nothing left to drop and the row
    // has to grow a line instead of crushing the scrub — which is the
    // stylesheet's half (scrubKeepsItsWidth.drift.test.ts).
    for (let w = 1600; w >= 200; w -= 1) {
      const fit = transportFit(w);
      const scrub = scrubWidthIn(w, fit);
      if (scrub >= SCRUB_MIN_WIDTH) continue;
      expect(
        ALL.every((p) => !fit[p]),
        `w=${w} still holds ${kept(w).join(",")}`,
      ).toBe(true);
    }
  });

  it("holds at the four widths the browser measured", () => {
    // The row is narrower than the viewport by the shell's own chrome; these
    // are the row widths, and the failing viewports were wider still.
    for (const w of [1440, 1100, 900, 771]) {
      const fit = transportFit(w);
      expect(scrubWidthIn(w, fit), `row ${w}`).toBeGreaterThanOrEqual(SCRUB_MIN_WIDTH);
    }
  });

  it("never claims a negative scrub", () => {
    expect(scrubWidthIn(0, transportFit(0))).toBeGreaterThanOrEqual(0);
    expect(scrubWidthIn(-40, transportFit(-40))).toBeGreaterThanOrEqual(0);
  });
});
