// A rule that reaches the bundle and still does nothing. Read off disk.
//
// sheetReach.drift.test.ts, written the same day, asks whether a stylesheet is
// LOADED. This asks the next question, and card 195's review found the gap
// between them: `.hk-command { font-family: var(--font-mono) }` was in the
// shipped CSS and lost the cascade to `.settings-field input { font: inherit }`
// — (0,1,0) against (0,2,0) — so the one rule that card added had no effect on
// the page. Measured in the running app: the Command field rendered in the
// proportional UI face while the Default Workspace field below it was mono. The
// sheet's own comment said "so it is set in mono like the rows it will join",
// and that sentence was false from the day it was written.
//
// Nothing catches this class. tsc, eslint, prettier and vite all pass; the
// selector is real, the property is real, the token is real, the file is loaded.
// Only the cascade disagrees, and only a browser or this test can see it.
//
// SCOPE, deliberately narrow: one element, the settings Command field, and one
// property family. The matcher below understands descendant combinators over
// tag/class compounds, which is every rule that competes for this element today;
// anything more exotic that declares a font for it fails the last expectation
// rather than being skipped, so the guard cannot go quietly out of its depth.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments as code } from "../testkit/source";

const STYLES = fileURLToPath(new URL(".", import.meta.url));

/** The element the Command field actually is, innermost last —
 *  `<label class="settings-field"><input class="hk-command">`. */
const ELEMENT = [
  { tag: "label", classes: ["settings-field"] },
  { tag: "input", classes: ["hk-command"] },
];

/** One declaration block that sets a font, with where it stands in the cascade. */
interface FontRule {
  selector: string;
  /** [ids, classes, elements] — the cascade's own tie-break, before order. */
  weight: [number, number, number];
  /** Position in the concatenated sheet order; higher wins an exact tie. */
  order: number;
  /** The declared value of `font-family` (or of the `font` shorthand). */
  value: string;
}

/** Specificity of one selector: ids, classes (incl. attributes/pseudo-classes),
 *  elements (incl. pseudo-elements).
 *  @param sel one selector, no comma
 *  @return the three-part weight */
function specificity(sel: string): [number, number, number] {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (sel.match(/\.[\w-]+/g) ?? []).length +
    (sel.match(/\[[^\]]*\]/g) ?? []).length +
    (sel.match(/(?<!:):[\w-]+/g) ?? []).length;
  const elements =
    (sel.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length + (sel.match(/::[\w-]+/g) ?? []).length;
  return [ids, classes, elements];
}

/** Whether one compound (`input.hk-command`) describes one element. */
function compoundMatches(compound: string, el: { tag: string; classes: string[] }): boolean {
  const tag = compound.match(/^[a-zA-Z][\w-]*/);
  if (tag !== null && tag[0] !== el.tag) return false;
  for (const cls of compound.match(/\.[\w-]+/g) ?? []) {
    if (!el.classes.includes(cls.slice(1))) return false;
  }
  return true;
}

/** Whether a descendant-only selector matches ELEMENT's innermost node.
 *  @param sel one selector, no comma
 *  @return true when it applies to the Command input */
function matchesElement(sel: string): boolean {
  const parts = sel.trim().split(/\s+/);
  if (!compoundMatches(parts[parts.length - 1], ELEMENT[ELEMENT.length - 1])) return false;
  let at = ELEMENT.length - 1;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (--at >= 0) {
      if (compoundMatches(parts[i], ELEMENT[at])) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** Selectors this matcher cannot reason about — anything but descendant
 *  combinators over tag/class compounds. */
function tooExotic(sel: string): boolean {
  return /[>+~#[:]/.test(sel);
}

const rules: FontRule[] = [];
const exotic: string[] = [];
let order = 0;
for (const name of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
  for (const block of code(readFileSync(join(STYLES, name), "utf8")).matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    const body = block[2];
    const family = body.match(/(?:^|;)\s*font-family\s*:([^;]+)/);
    const shorthand = body.match(/(?:^|;)\s*font\s*:([^;]+)/);
    if (family === null && shorthand === null) continue;
    for (const selector of block[1].split(",")) {
      order++;
      const sel = selector.trim();
      if (sel === "" || sel.startsWith("@")) continue;
      if (tooExotic(sel)) {
        // Only worth reporting when it plausibly aims at this field at all.
        if (/hk-command|settings-field/.test(sel)) exotic.push(`${name}: ${sel}`);
        continue;
      }
      if (!matchesElement(sel)) continue;
      rules.push({
        selector: `${name}: ${sel}`,
        weight: specificity(sel),
        order,
        value: (family ?? shorthand!)[1].trim(),
      });
    }
  }
}

/** The rule the browser would apply: highest specificity, then last declared. */
function winner(): FontRule {
  return rules.reduce((best, rule) => {
    for (let i = 0; i < 3; i++) {
      if (rule.weight[i] !== best.weight[i]) return rule.weight[i] > best.weight[i] ? rule : best;
    }
    return rule.order > best.order ? rule : best;
  });
}

describe("the font a settings field is written to have is the font it gets", () => {
  it("has competitors at all, so a passing run means something", () => {
    // If this ever drops to one, the guard is measuring nothing and should be
    // read again rather than trusted.
    expect(rules.length).toBeGreaterThan(1);
  });

  it("gives the Command field the mono face the rule was written for", () => {
    const won = winner();
    expect(won.value, `${won.selector} wins the cascade`).toContain("--font-mono");
  });

  it("has no font rule aimed at this field that the matcher cannot weigh", () => {
    expect(exotic).toEqual([]);
  });
});
