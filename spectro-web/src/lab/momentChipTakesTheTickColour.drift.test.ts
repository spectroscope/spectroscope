// Card 309A, fix round: a moment reads the same colour on the bar and in the
// list, and that is now a measurement rather than a sentence in a comment.
//
// WHAT WAS FALSE. The comment over the moments block said the chips "inherit
// the very custom properties the scrub ticks are painted with, so … re-colouring
// one re-colours both". Nothing inherited: the tick lives on the transport row
// and the chip lives in the dock, neither is the other's ancestor, and the
// stylesheet held TWO byte-identical copies of the same eleven-kind `--tick`
// table under two class prefixes. Re-colouring `.lab-mark--spawn` would have
// left `.lab-moment-kind--spawn` on the old colour, and nothing compared them.
// The two agreed only because they were written in the same minute.
//
// THE REPAIR IS STRUCTURAL, not a better comment: one table, two selectors per
// row, so a re-colour is one edit by construction. This file is what stops the
// table being split again — and, because a split would look exactly like the
// shape that shipped, it pins the rule IDENTITY, not merely the two values.
//
// An unknown custom property warns nowhere (bus.css named 37 that did not
// exist and the whole Spectrum surface lost its frames for months), so the
// fallback both surfaces fall through to is pinned here too: that is what makes
// `compaction`, which neither prefix colours, honest rather than lucky.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChapterKind } from "../state/stepper";

const KINDS: ChapterKind[] = [
  "turn",
  "spawn",
  "compaction",
  "gate",
  "denied",
  "no_progress",
  "intervention",
  "question",
  "skill",
  "error",
  "end",
];

const css = readFileSync(join(__dirname, "..", "styles", "lab.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost rule of the sheet. The inner `[^{}]` on both halves is what
 *  makes an `@media` wrapper fall out rather than be read as a selector. */
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  body: m[2],
}));

/** The rules that PAINT a kind: the ones declaring `--tick`. */
const tickRules = rules.filter((r) => /--tick:/.test(r.body));

const ruleFor = (selector: string): Rule | undefined => tickRules.find((r) => r.selectors.includes(selector));

describe("one moment, one colour — the chip and the tick are painted by one table", () => {
  it("declares --tick somewhere at all, so the bites below are not vacuous", () => {
    expect(tickRules.length).toBeGreaterThan(0);
  });

  it.each(KINDS)("paints the %s tick and its chip from the SAME rule", (kind) => {
    const tick = ruleFor(`.lab-mark--${kind}`);
    const chip = ruleFor(`.lab-moment-kind--${kind}`);
    // Neither, or one rule holding both. A kind coloured for one surface and
    // not the other is the drift this file exists to catch, and so is a second
    // rule that happens to say the same thing today.
    if (tick === undefined && chip === undefined) return;
    expect(chip, `.lab-moment-kind--${kind} must be coloured wherever the tick is`).toBeDefined();
    expect(tick, `.lab-mark--${kind} must be coloured wherever the chip is`).toBeDefined();
    expect(chip).toBe(tick);
  });

  it("leaves no kind coloured on one surface only", () => {
    const painted = (prefix: string): Set<string> =>
      new Set(KINDS.filter((k) => ruleFor(`${prefix}${k}`) !== undefined));
    expect([...painted(".lab-moment-kind--")].sort()).toEqual([...painted(".lab-mark--")].sort());
  });

  it("falls through to ONE colour for a kind the table does not name", () => {
    // `compaction` is in neither half. That is a decision, not an omission, and
    // it is only honest while both surfaces fall back the same way — otherwise
    // the one kind nobody coloured is the one kind that reads differently.
    const uncoloured = KINDS.filter((k) => ruleFor(`.lab-mark--${k}`) === undefined);
    expect(uncoloured).toContain("compaction");
    const fallback = /var\(--tick,\s*var\(--text-faint\)\)/;
    expect(rules.find((r) => r.selectors.includes(".lab-mark::before"))?.body).toMatch(fallback);
    expect(rules.find((r) => r.selectors.includes(".lab-moment-kind"))?.body).toMatch(fallback);
  });
});
