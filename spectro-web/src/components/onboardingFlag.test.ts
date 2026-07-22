import { describe, it, expect } from "vitest";
import { shouldOnboard } from "./onboardingFlag";

describe("shouldOnboard", () => {
  it("shows on first run when the flag was never set", () => {
    expect(shouldOnboard(null)).toBe(true);
  });

  it("stays hidden once the dialog has been dismissed", () => {
    expect(shouldOnboard("1")).toBe(false);
  });

  it("treats any non-'1' value as first run (tolerant of junk)", () => {
    expect(shouldOnboard("")).toBe(true);
    expect(shouldOnboard("true")).toBe(true);
  });
});
