import { describe, it, expect } from "vitest";
import { shouldOnboard, shouldShowOnboarding } from "./onboardingFlag";

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

describe("shouldShowOnboarding", () => {
  const status = { anthropic: "needs-key", openai: "ready", ollama: "local" };

  it("shows when not dismissed and the boot provider needs a key", () => {
    expect(shouldShowOnboarding(false, "anthropic", status)).toBe(true);
  });
  it("never shows for a ready/configured boot provider (the reported bug)", () => {
    expect(shouldShowOnboarding(false, "openai", status)).toBe(false);
  });
  it("never shows for a configured local backend", () => {
    expect(shouldShowOnboarding(false, "ollama", status)).toBe(false);
  });
  it("stays hidden once dismissed, regardless of readiness", () => {
    expect(shouldShowOnboarding(true, "anthropic", status)).toBe(false);
  });
  it("waits (hidden) while the config is still loading", () => {
    expect(shouldShowOnboarding(false, null, status)).toBe(false);
    expect(shouldShowOnboarding(false, "anthropic", null)).toBe(false);
  });
});
