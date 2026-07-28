// The Lab's reading aid under the flow map. It is pinned here because the map it
// describes keeps moving underneath it: the packet takes its fill from --accent
// (theme-dependent) or --error, never one fixed hue, and a local model sits
// INSIDE the machine frame rather than out on the network side.
import { describe, expect, it } from "vitest";
import { dict, t } from "../i18n/i18n";

describe("lab.hint", () => {
  it("exists in both languages", () => {
    expect(dict["lab.hint"]).toBeDefined();
    expect(t("en", "lab.hint")).not.toBe("lab.hint");
    expect(t("de", "lab.hint")).not.toBe("lab.hint");
  });

  it("names no fixed packet colour (flowmap.css fills .pf-comet from --accent)", () => {
    for (const lang of ["de", "en"] as const) {
      expect(t(lang, "lab.hint").toLowerCase()).not.toMatch(/koral|coral/);
    }
  });

  it("carries no em dash (house rule for body text)", () => {
    for (const lang of ["de", "en"] as const) {
      expect(t(lang, "lab.hint")).not.toContain("—");
    }
  });

  it("is written per language, not one string served twice", () => {
    expect(t("de", "lab.hint")).not.toBe(t("en", "lab.hint"));
  });
});
