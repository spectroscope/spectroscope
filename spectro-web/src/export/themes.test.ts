// The export's theme table, read as a reader would meet it: does the document
// come out in the theme that was picked, does it SAY which theme, and can the
// syntax colouring still be read on that theme's own ground.

import { describe, expect, it } from "vitest";
import { CODE_TOKENS, EXPORT_THEMES, MIN_CODE_CONTRAST, contrastRatio, themeById, themeCss } from "./themes";
import { DESIGNS } from "../state/designPrefs";

describe("the table covers the picker", () => {
  it("carries one entry per design the app offers", () => {
    // Held to DESIGNS rather than to a literal: the export dialog lists the
    // catalog, so a design in the picker with no theme here is a radio button
    // that produces a document in somebody else's palette.
    expect(EXPORT_THEMES.map((th) => th.id)).toEqual(DESIGNS.map((d) => d.id));
  });

  it("agrees with the catalog about which designs are dark", () => {
    // The swatch in the picker and the colour-scheme in the exported file are
    // two statements about the same design; a reader meets both.
    for (const th of EXPORT_THEMES) {
      const swatch = DESIGNS.find((d) => d.id === th.id);
      expect(swatch, `no picker entry for ${th.id}`).toBeDefined();
      expect(th.tokens.bg.toLowerCase()).toBe(swatch?.bg.toLowerCase());
      expect(th.tokens.accent.toLowerCase()).toBe(swatch?.accent.toLowerCase());
    }
  });

  it("names each theme in both chrome languages", () => {
    for (const th of EXPORT_THEMES) {
      expect(th.name.en).not.toBe("");
      expect(th.name.de).not.toBe("");
    }
  });

  it("declares every token the export stylesheet reads", () => {
    // A missing token would fall back to an inherited value or to nothing at
    // all, and the file has no app around it to inherit from.
    const required = [
      "bg",
      "surface",
      "surface-2",
      "surface-3",
      "border",
      "border-strong",
      "shade",
      "text",
      "text-dim",
      "text-faint",
      "accent",
      "sand",
      "sp-red",
      "sp-amber",
      "sp-teal",
      "sp-ocean",
      "sp-violet",
      "ok",
      "warn",
      "error",
      "agent-root",
      "agent-explore",
      "agent-worker",
      "agent-extra",
      "font-ui",
      "font-mono",
    ];
    for (const th of EXPORT_THEMES) {
      for (const key of required) expect(Object.keys(th.tokens)).toContain(key);
    }
  });
});

describe("themeById", () => {
  it("returns the named theme", () => {
    expect(themeById("paper").id).toBe("paper");
  });

  it("falls back to the app's default for an unknown id", () => {
    // The id can arrive from a stored preference written by an older build.
    expect(themeById("nebula").id).toBe("spectroscope");
  });
});

describe("themeCss", () => {
  it("emits every token as a custom property", () => {
    const css = themeCss(themeById("paper"));
    expect(css).toContain("--bg: #f6f4ee");
    expect(css).toContain("--sp-teal: #0f9d77");
  });

  it("declares the colour scheme, so form controls and scrollbars match", () => {
    expect(themeCss(themeById("paper"))).toContain("color-scheme: light");
    expect(themeCss(themeById("spectroscope"))).toContain("color-scheme: dark");
  });
});

describe("code stays readable on the ground it is printed on", () => {
  // The export uses the spectral ramp for TEXT, not only for the mark: keyword,
  // string and number are coloured code. A ramp inherited from another theme's
  // ground is how a light document ends up with near-invisible highlighting.
  it("clears the floor for every syntax token on every theme", () => {
    for (const th of EXPORT_THEMES) {
      for (const key of CODE_TOKENS) {
        const ratio = contrastRatio(th.tokens[key], th.tokens.bg);
        expect(
          ratio,
          `${th.id}: --${key} ${th.tokens[key]} on --bg ${th.tokens.bg} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST);
      }
    }
  });

  it("measures the espresso ramp on the white ground as unreadable", () => {
    // The reason `still` borrows rather than inherits, kept as a live number so
    // nobody re-points it at the dark ramp on the grounds that it "looks fine".
    const still = themeById("still");
    const espressoTeal = themeById("spectroscope").tokens["sp-teal"];
    expect(contrastRatio(espressoTeal, still.tokens.bg)).toBeLessThan(2);
  });

  it("measures the espresso ramp on the graphite ground as the same ramp", () => {
    // `still` borrows because its ground moved. Graphite's did not: it is the
    // same rung of lightness in a different temperature, so every spectral line
    // lands within a rounding error of where espresso puts it. That is the
    // argument for graphite carrying no ramp of its own, and it is a number, so
    // a future retune of either ground has to answer to it.
    const graphite = themeById("graphite");
    const espresso = themeById("spectroscope");
    // themeById falls back to espresso for an id it does not ship, which would
    // make every comparison below a colour against itself and pass on nothing.
    expect(graphite.id, "no graphite theme: the rest of this test is vacuous").toBe("graphite");
    expect(graphite.tokens.bg).not.toBe(espresso.tokens.bg);
    for (const key of CODE_TOKENS) {
      const here = contrastRatio(espresso.tokens[key], graphite.tokens.bg);
      const there = contrastRatio(espresso.tokens[key], espresso.tokens.bg);
      expect(
        Math.abs(here - there),
        `--${key} shifts by ${(here - there).toFixed(2)} between grounds`,
      ).toBeLessThan(0.25);
    }
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#2dd4a7", "#17120d")).toBeCloseTo(contrastRatio("#17120d", "#2dd4a7"), 6);
  });

  it("is 1:1 for a colour against itself", () => {
    expect(contrastRatio("#ce9440", "#ce9440")).toBeCloseTo(1, 6);
  });
});
