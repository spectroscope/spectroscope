// Card 408: the composer and the status bar carry less padding.
//
// The owner asked for a few pixels less above the message field and a lower
// status bar under it. Three declared values move and one must not:
//
//   .composer        padding-top     --sp-3 (12px) to --sp-2 (8px)
//   .composer-history margin-bottom  --sp-1 (4px)  to 0
//   .usage-footer    padding-top and padding-bottom, --sp-2 (8px) to --sp-1 (4px)
//   .composer        padding-bottom  stays --sp-3 (12px)
//
// The last line is the seam with card 383: composerRow.drift.test.ts reads the
// same padding-bottom for its reach math, against two ceilings and a tolerance
// of one --sp-1 rung, so it accepts more than one value. This file pins one.
//
// How a value is read. A rule counts only when one of its comma-separated
// selectors is exactly the selector asked for, and only in the ./styles/
// sheets that app.css @imports. Those rules are taken in import order,
// shorthand and longhand alike, and the last declaration wins. Rules inside an
// @media block are read as if they always applied, so a media override of
// these properties reads as the value here. On 2026-09-24 none of the rules
// this file reads sits inside one.
//
// What it does not read. It weighs neither specificity nor !important, so a
// scoped rule such as ".chat .composer" or "[data-design] .composer" is
// skipped. It skips the rules app.css declares after its own imports,
// designs.css (main.tsx loads it after app.css), and the sheets a component
// imports on its own, such as bus.css and export-dialog.css. An override in
// any of those leaves this file green while the browser renders another
// value. On 2026-09-24 a scan of every .css file under src found no skipped
// rule that sets padding, margin or font-size on .composer, .composer-history
// or .usage-footer.

import { describe, expect, it } from "vitest";
import { read, rules } from "../testkit/source";

const app = read("../app.css", import.meta.url);
const tokens = read("../tokens.css", import.meta.url);

/** The spacing ladder, read out of tokens.css. */
const SPACING = new Map<string, number>(
  [...tokens.matchAll(/--(sp-\d+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]),
);

/** One rung of the spacing ladder in px, or a throw naming the missing token. */
function rung(name: string): number {
  const n = SPACING.get(name);
  if (n === undefined) throw new Error(`tokens.css has no --${name}`);
  return n;
}

/** A `0`, an `Npx` or a `var(--sp-N)` as px, or a throw naming what failed. */
function px(value: string | null, what: string): number {
  if (value === null) throw new Error(`${what}: nothing is declared`);
  const token = value.match(/^var\(--(sp-\d+)\)$/);
  if (token) return rung(token[1]);
  if (value === "0") return 0;
  const literal = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (literal) return Number(literal[1]);
  throw new Error(`${what}: cannot resolve "${value}" to px`);
}

/** Every rule in the ./styles/ sheets app.css @imports, in import order. */
const SHEETS = [...app.matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]);
const ALL_RULES = SHEETS.flatMap((name) => rules(name, read(`./${name}`, import.meta.url)));

type Side = "top" | "right" | "bottom" | "left";
const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

/**
 * The four sides of `padding` or `margin` for one exact selector, read across
 * ALL_RULES in order: a shorthand sets all four, a `-top` style longhand sets
 * one, and a later declaration replaces an earlier one.
 */
function box(selector: string, prop: "padding" | "margin"): Record<Side, string | null> {
  const out: Record<Side, string | null> = { top: null, right: null, bottom: null, left: null };
  const matching = ALL_RULES.filter((r) => r.selector === selector);
  if (matching.length === 0) throw new Error(`no sheet in app.css declares ${selector}`);
  for (const rule of matching) {
    for (const decl of rule.body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (name === prop) {
        const parts = value.split(/\s+(?![^(]*\))/);
        const four = {
          1: [parts[0], parts[0], parts[0], parts[0]],
          2: [parts[0], parts[1], parts[0], parts[1]],
          3: [parts[0], parts[1], parts[2], parts[1]],
          4: parts,
        }[parts.length];
        if (four === undefined) throw new Error(`${selector} ${prop} has ${parts.length} parts`);
        SIDES.forEach((side, i) => (out[side] = four[i]));
      } else {
        for (const side of SIDES) if (name === `${prop}-${side}`) out[side] = value;
      }
    }
  }
  return out;
}

/** The last value ALL_RULES declares for a plain property on one exact selector, or null. */
function last(selector: string, prop: string): string | null {
  let value: string | null = null;
  for (const rule of ALL_RULES.filter((r) => r.selector === selector)) {
    for (const decl of rule.body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon >= 0 && decl.slice(0, colon).trim() === prop) value = decl.slice(colon + 1).trim();
    }
  }
  return value;
}

describe("the band above the message field is smaller (card 408)", () => {
  it("gives .composer a padding-top of --sp-2", () => {
    const top = px(box(".composer", "padding").top, ".composer padding-top");
    expect(top, ".composer padding-top").toBe(rung("sp-2"));
  });

  it("gives the walk counter slot no bottom margin", () => {
    const bottom = px(box(".composer-history", "margin").bottom, ".composer-history margin-bottom");
    expect(bottom, ".composer-history margin-bottom").toBe(0);
  });

  it("leaves .composer's padding-bottom at --sp-3, the value card 383's reach math reads", () => {
    const bottom = px(box(".composer", "padding").bottom, ".composer padding-bottom");
    expect(bottom, ".composer padding-bottom").toBe(rung("sp-3"));
  });

  it("leaves .composer's side padding at --sp-4", () => {
    const sides = box(".composer", "padding");
    expect(px(sides.left, ".composer padding-left"), ".composer padding-left").toBe(rung("sp-4"));
    expect(px(sides.right, ".composer padding-right"), ".composer padding-right").toBe(rung("sp-4"));
  });
});

describe("the status bar is lower (card 408)", () => {
  it("gives .usage-footer a padding of --sp-1 on top and bottom", () => {
    const sides = box(".usage-footer", "padding");
    expect(px(sides.top, ".usage-footer padding-top"), ".usage-footer padding-top").toBe(rung("sp-1"));
    expect(px(sides.bottom, ".usage-footer padding-bottom"), ".usage-footer padding-bottom").toBe(
      rung("sp-1"),
    );
  });

  it("leaves the side padding at --sp-4 and the font size at --fs-12", () => {
    const sides = box(".usage-footer", "padding");
    expect(px(sides.left, ".usage-footer padding-left"), ".usage-footer padding-left").toBe(rung("sp-4"));
    expect(px(sides.right, ".usage-footer padding-right"), ".usage-footer padding-right").toBe(rung("sp-4"));
    expect(last(".usage-footer", "font-size"), ".usage-footer font-size").toBe("var(--fs-12)");
  });
});
