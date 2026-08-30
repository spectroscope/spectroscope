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
//
// SECOND FIX ROUND — THE RESOLVER READ THE WRONG RULE. This file used to look a
// selector up with `Array.find`, which answers with the FIRST rule declaring
// it. A browser answers with the LAST at equal specificity: the cascade orders
// equally-specific declarations by document position, so the winner is the one
// nearest the bottom of the sheet. Reading the first meant this file compared
// the rules at the TOP of the stylesheet, never the ones that paint, and the
// drift it exists to catch had a one-line bypass — appending
// `.lab-mark--spawn { --tick: var(--error); }` at the end of lab.css left all
// fourteen assertions green while the tick and the chip painted two different
// colours (measured). The resolver below walks the declarations in document
// order and takes the last, and `the resolver itself` block bites that against
// a synthetic sheet so the rule is pinned rather than remembered.

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

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost rule of a sheet, in document order. The inner `[^{}]` on
 *  both halves is what makes an `@media` wrapper fall out rather than be read
 *  as a selector. */
function innermostRules(sheet: string): Rule[] {
  const stripped = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    body: m[2],
  }));
}

/** The rules that PAINT a kind: the ones declaring `--tick`. */
const declaringTick = (rules: readonly Rule[]): Rule[] => rules.filter((r) => /--tick:/.test(r.body));

/**
 * The rule a browser would let win for one selector, or undefined where the
 * sheet never names it.
 *
 * THE CASCADE, NOT THE FIRST MATCH. Where several equally specific rules
 * declare the same property for the same selector, CSS keeps the one that comes
 * LAST in the sheet; everything above it is overwritten and never reaches a
 * pixel. So this walks the whole list and answers with the final declaration,
 * which is the only one worth comparing against anything. `Array.find` would
 * answer with the first — the rules at the top of the file — and a later
 * declaration could then re-colour one surface without a single assertion in
 * this file moving.
 *
 * Equal specificity is a PRECONDITION of that answer, not an assumption:
 * `oneClassDeep` below refuses the sheet if any `--tick` declaration reaches a
 * kind through a compound or descendant selector, because such a rule outranks
 * the table whatever its position, and then "the last one wins" is simply the
 * wrong reading.
 */
function winner(rules: readonly Rule[], selector: string): Rule | undefined {
  let found: Rule | undefined;
  for (const r of rules) if (r.selectors.includes(selector)) found = r;
  return found;
}

/** Specificity as CSS counts it: ids, then classes/attributes/pseudo-classes,
 *  then types and pseudo-elements. Enough for the flat selectors this sheet
 *  uses, and it is only ever read to REPORT a difference. */
function specificity(selector: string): [number, number, number] {
  const withoutPseudoElements = selector.replace(/::[\w-]+/g, " ");
  return [
    (withoutPseudoElements.match(/#[\w-]+/g) ?? []).length,
    (withoutPseudoElements.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g) ?? []).length,
    (selector.match(/::[\w-]+/g) ?? []).length +
      (withoutPseudoElements.replace(/[.#:[][^\s>+~]*/g, " ").match(/[a-zA-Z][\w-]*/g) ?? []).length,
  ];
}

const css = readFileSync(join(__dirname, "..", "styles", "lab.css"), "utf8");
const rules = innermostRules(css);
const tickRules = declaringTick(rules);
const ruleFor = (selector: string): Rule | undefined => winner(tickRules, selector);

describe("the resolver itself — a sheet is read the way the cascade reads it", () => {
  // Without this block the resolver is a claim in a comment. The bug it
  // replaces was exactly a resolver that looked right and answered with the
  // wrong rule, and no assertion over the real sheet could tell the two apart
  // while the real sheet happened to declare each selector once.
  it("answers with the LAST declaration, not the first", () => {
    const sheet = ".a {\n  --tick: red;\n}\n.b {\n  --tick: green;\n}\n.a {\n  --tick: blue;\n}\n";
    const winners = declaringTick(innermostRules(sheet));
    expect(winner(winners, ".a")?.body).toContain("blue");
    expect(winner(winners, ".a")?.body).not.toContain("red");
  });

  it("says nothing at all about a selector the sheet never names", () => {
    const winners = declaringTick(innermostRules(".a {\n  --tick: red;\n}\n"));
    expect(winner(winners, ".b")).toBeUndefined();
  });

  it("counts a compound selector as more specific than a bare class", () => {
    expect(specificity(".lab-mark--spawn")).toEqual([0, 1, 0]);
    expect(specificity(".lab-marks .lab-mark--spawn")).toEqual([0, 2, 0]);
    expect(specificity(".lab-mark::before")).toEqual([0, 1, 1]);
  });
});

describe("one moment, one colour — the chip and the tick are painted by one table", () => {
  it("declares --tick somewhere at all, so the bites below are not vacuous", () => {
    expect(tickRules.length).toBeGreaterThan(0);
  });

  it.each(KINDS)("reaches the %s colour through bare classes, so document order decides it", (kind) => {
    // The precondition of every identity check below. A `--tick` declaration
    // that reaches a kind through a compound or descendant selector wins on
    // SPECIFICITY rather than position, and then the last-wins reading above
    // is not what the browser does. That is a finding to act on, not a case
    // to absorb: whoever writes such a rule has to redo the comparison here
    // by hand, so the sheet is refused instead.
    for (const prefix of [".lab-mark--", ".lab-moment-kind--"]) {
      const bare = `${prefix}${kind}`;
      const reaching = tickRules
        .flatMap((r) => r.selectors)
        .filter((s) => s.includes(`${prefix}${kind}`) && s !== bare);
      expect(
        reaching,
        `${bare} is also coloured through ${reaching.join(", ")} (specificity ` +
          `${reaching.map((s) => specificity(s).join("-")).join(", ")} against ${specificity(bare).join("-")}). ` +
          "The tick and the chip no longer resolve at equal specificity, so this file's comparison is void: " +
          "fold the rule back into the one table, or redo the resolution by hand.",
      ).toEqual([]);
    }
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
    expect(winner(rules, ".lab-mark::before")?.body).toMatch(fallback);
    expect(winner(rules, ".lab-moment-kind")?.body).toMatch(fallback);
  });
});
