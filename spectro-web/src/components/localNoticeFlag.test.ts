// Pins for the built-in model's first-use notice (card 91).

import { describe, expect, it } from "vitest";
import { shouldShowLocalNotice } from "./localNoticeFlag";

describe("shouldShowLocalNotice", () => {
  it("shows on the first spectro-local activation", () => {
    expect(shouldShowLocalNotice(null, "spectro-local")).toBe(true);
  });

  it("never again after a dismissal", () => {
    expect(shouldShowLocalNotice("1", "spectro-local")).toBe(false);
  });

  it("stays quiet for every other provider — and while none is known", () => {
    expect(shouldShowLocalNotice(null, "anthropic")).toBe(false);
    expect(shouldShowLocalNotice(null, null)).toBe(false);
  });
});
