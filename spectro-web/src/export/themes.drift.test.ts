// The drift gate. The export copies the app's tokens into a table, because an
// exported file has no stylesheet to link to and no app around it — the values
// have to be literals inside the document. A copy drifts, so this reads the
// REAL stylesheets off disk and holds the table to them.
//
// Two failures it is meant to catch, in opposite directions: a token retuned in
// tokens.css and not here (the export keeps printing last month's palette), and
// a token that `still` starts declaring for itself (the borrow list below would
// silently keep overriding it with paper's).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPORT_THEMES, GRAPHITE_BORROWS_FROM_ESPRESSO, STILL_BORROWS_FROM_PAPER } from "./themes";
import type { DesignId } from "../state/designPrefs";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

/**
 * The custom properties declared in one selector's block.
 *
 * A hand-rolled reader rather than a CSS parser: the two files are ours, the
 * shape is one flat block per selector, and a dependency for this would be a
 * dependency shipped to every user of the app.
 *
 * @param css      the stylesheet text
 * @param selector the exact selector line to open, e.g. `[data-design="paper"]`
 * @return token name (without the leading dashes) to declared value
 */
function blockTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no such selector in the stylesheet: ${selector}`);
  const open = css.indexOf("{", start);
  const end = css.indexOf("}", open);
  const body = css.slice(open + 1, end);
  const out: Record<string, string> = {};
  // Comments carry colons and semicolons of their own; strip them first.
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/\s+/g, " ");
  }
  return out;
}

const tokensCss = read("tokens.css");
const designsCss = read("designs.css");

const SOURCE: Record<DesignId, Record<string, string>> = {
  spectroscope: blockTokens(tokensCss, ":root"),
  paper: blockTokens(tokensCss, '[data-design="paper"]'),
  still: blockTokens(designsCss, '[data-design="still"]'),
  graphite: blockTokens(designsCss, '[data-design="graphite"]'),
};

describe("the export table matches the app's stylesheets", () => {
  // Every value is checked against the block that REALLY declares it. A skin
  // overrides only some tokens; the rest it inherits from :root at runtime,
  // which an exported file cannot do — so the table names its source per token
  // and this holds each one to that source.
  for (const theme of EXPORT_THEMES) {
    for (const [key, value] of Object.entries(theme.tokens)) {
      const from: DesignId = theme.borrows[key] ?? theme.id;
      const via = from === theme.id ? "declares" : `borrows from ${from}`;
      it(`${theme.id}: --${key} ${via}`, () => {
        expect(SOURCE[from][key], `--${key} is not declared by ${from}`).toBeDefined();
        expect(normalise(value)).toBe(normalise(SOURCE[from][key]));
      });
    }
  }
});

describe("the borrow list still describes reality", () => {
  it("borrows exactly the spectral tokens `still` leaves undeclared", () => {
    // If `still` grows its own ramp, this fails and the borrow has to be
    // removed rather than quietly outvoting the new values.
    for (const key of STILL_BORROWS_FROM_PAPER) {
      expect(SOURCE.still[key], `designs.css now declares --${key} for still`).toBeUndefined();
    }
  });

  it("borrows exactly the spectral tokens `graphite` leaves undeclared", () => {
    // Graphite's whole claim is that only the ground and the accent move. The
    // day it declares a line of its own, that claim is false and the borrow
    // here would keep printing espresso's over the top of it.
    for (const key of GRAPHITE_BORROWS_FROM_ESPRESSO) {
      expect(SOURCE.graphite[key], `designs.css now declares --${key} for graphite`).toBeUndefined();
    }
  });

  it("borrows nothing that the lender cannot supply", () => {
    for (const theme of EXPORT_THEMES) {
      for (const [key, from] of Object.entries(theme.borrows)) {
        if (from === undefined) continue;
        expect(SOURCE[from][key], `${from} cannot lend --${key}`).toBeDefined();
      }
    }
  });

  it("never borrows a token the theme declares for itself", () => {
    for (const theme of EXPORT_THEMES) {
      for (const key of Object.keys(theme.borrows)) {
        expect(SOURCE[theme.id][key], `${theme.id} declares --${key} and also borrows it`).toBeUndefined();
      }
    }
  });
});

/** Colours are compared as values, not as spelling: `#FFF` and `#ffffff` are
 *  the same instruction to a browser, and a case change is not drift. */
function normalise(value: string): string {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (hex === null) return value.trim().toLowerCase().replace(/,\s+/g, ", ");
  const digits = hex[1].toLowerCase();
  return digits.length <= 4
    ? `#${digits
        .split("")
        .map((c) => c + c)
        .join("")}`
    : `#${digits}`;
}
