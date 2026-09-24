// Card 390: the header hands the ring its "set the window" handler only in the
// live view. A replay reads a recorded session; a set pressed there would go to
// whatever socket is live (review 2026-09-24, E8), so the ring gets no handler
// and the popover draws no row.

import { describe, expect, it } from "vitest";
import { ringWindowOverride } from "./AppHeader";

describe("ringWindowOverride", () => {
  it("passes the handler through in the live view", () => {
    const handler = (): void => {};
    expect(ringWindowOverride(true, handler)).toBe(handler);
  });

  it("passes nothing in a replay", () => {
    expect(ringWindowOverride(false, () => {})).toBeUndefined();
  });
});
