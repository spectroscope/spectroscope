import { describe, it, expect } from "vitest";
import { formatWindow } from "./contextWindow";

// The vendor table that used to be tested here moved to Java with card 366 —
// its cases moved with it, into ModelWindowsTest, including the claude-fable-5
// regression that made the ring read 379 % on a healthy session. What is left
// on this side is how a window is PRINTED.
describe("formatWindow", () => {
  it("formats k and M cleanly", () => {
    expect(formatWindow(128_000)).toBe("128k");
    expect(formatWindow(200_000)).toBe("200k");
    expect(formatWindow(1_000_000)).toBe("1M");
    expect(formatWindow(2_000_000)).toBe("2M");
  });

  it("rounds a measured window to the nearest thousand", () => {
    // The figures that arrive now are MEASURED, not published, so they are not
    // round: the owner's loaded instance is 250,368 and his server's ceiling
    // 1,048,576.
    expect(formatWindow(250_368)).toBe("250k");
    expect(formatWindow(204_288)).toBe("204k");
    expect(formatWindow(1_048_576)).toBe("1M");
    expect(formatWindow(1_500_000)).toBe("1.5M");
  });
});
