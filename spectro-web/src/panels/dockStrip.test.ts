// Release 0.14.2, live check D2: in German at 1440 px the last dock tab was
// cut at the strip's edge next to the "Reiter" switch, with nothing to say
// the strip scrolls. The strip now names the edges where tabs are hidden, and
// the stylesheet fades exactly those edges (dockStripFit.drift.test.ts).

import { describe, expect, it } from "vitest";
import { stripOverflow } from "./dockStrip";

describe("stripOverflow: which edges of the dock strip hide a tab", () => {
  it("says none when every tab fits", () => {
    expect(stripOverflow(0, 460, 505)).toBe("none");
    expect(stripOverflow(0, 505, 505)).toBe("none");
  });

  it("says end when tabs hide past the right edge (the D2 case)", () => {
    expect(stripOverflow(0, 510, 505)).toBe("end");
  });

  it("says start when the strip is scrolled to its end", () => {
    expect(stripOverflow(5, 510, 505)).toBe("start");
  });

  it("says both when tabs hide on each side", () => {
    expect(stripOverflow(20, 600, 505)).toBe("both");
  });

  it("ignores the sub-pixel rounding a fitting strip reports", () => {
    // Chrome rounds scrollWidth up and clientWidth down; a strip that fits
    // can report one pixel of overflow, which is not a hidden tab.
    expect(stripOverflow(0, 506, 505)).toBe("none");
    expect(stripOverflow(0.5, 506, 505)).toBe("none");
  });
});
