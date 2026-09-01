// Card 362, criterion 5 — the pixel floor that made the divider inert.
//
// MEASURED as arithmetic, not remembered: `.ws-tree` carried
// `min-height: 90px` while its inline style is `flex: 0 0 ${split}%`. A used
// height is `max(basis, min-height)`, so for any container inner height below
// `100 × floor / split` px the floor wins and the stored split changes NOTHING
// on screen. At the shipped split of 40 that is 225px; at the band's own floor
// of 15 it is 600px — so in a column 600px tall the divider did nothing at all
// between 15% and 40%, which is most of the range a person would drag through.
//
// The fix is the floor, not the band: a split the reader chose is the reader's
// business, and the tree scrolls. A guard rather than a comment, because a
// pixel floor is exactly the kind of well-meant line that comes back.
//
// The locator is card 360's parsed one, and the reason is forward-looking
// rather than measured: `grep -rn ws-tree src --include='*.css'` returns
// exactly ONE line today (panels.css:59) and there is no scoped rule anywhere
// in the tree. The sentence here used to claim one already existed, which was
// simply untrue (review 2026-09-01). What the parsed locator buys is that a
// `.ws--narrow .ws-tree { min-height: … }` added later cannot be read as the
// unscoped rule — which is exactly what a substring search would do, and the
// second case below is the half that catches it.

import { describe, expect, it } from "vitest";
import { blockOf, read, rules, stripComments } from "../testkit/source";

const css = read("../styles/panels.css", import.meta.url);

/** The raw value a rule declares for `prop`, or null when it declares none. */
function declared(decls: string, prop: string): string | null {
  const m = decls.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

/**
 * Whether a `min-height` value can outrank a percentage flex basis.
 *
 * ANY UNIT, not px. The first cut of this guard parsed `^-?[\d.]+px$` and read
 * everything else as "absent", so `min-height: 6rem` reintroduced the exact
 * inertness card 362 measured and passed green (review 2026-09-01). The header
 * above calls a pixel floor "the kind of well-meant line that comes back" — it
 * comes back in `rem` as readily as in `px`, and in `%` and `em` too.
 *
 * Absent and a zero of any unit are both "the basis decides". `auto` is
 * allowed as well and that is not a hole: for a flex item it resolves to the
 * automatic minimum size, which the tree's own `overflow-y: auto` — pinned by
 * the third case below — collapses to zero. Anything else is a height the
 * divider cannot go under, silently.
 */
const noFloor = (value: string | null): boolean =>
  value === null || value === "auto" || /^0(?:[a-z]+|%)?$/i.test(value);

describe("the tree's height is the split's to decide (card 362)", () => {
  it("declares no floor of any unit that could outrank the stored split", () => {
    const floor = declared(blockOf(css, ".ws-tree"), "min-height");
    expect(noFloor(floor), `.ws-tree min-height is ${String(floor)}`).toBe(true);
  });

  it("no scoped .ws-tree rule reintroduces one either", () => {
    // The parsed locator above answers for the UNSCOPED rule only. A floor
    // under an ancestor would be just as inert-making and would not show up
    // there, which is the shape card 360 was written about.
    const seen = rules("panels.css", css).filter((r) => r.subject === ".ws-tree");
    // An empty violation list is not a broken parser: the sheet really does
    // carry the rule this file is about.
    expect(seen.map((r) => r.selector)).toContain(".ws-tree");
    for (const rule of seen) {
      const floor = declared(rule.body, "min-height");
      expect(noFloor(floor), `${rule.selector} (line ${rule.line}) min-height is ${String(floor)}`).toBe(
        true,
      );
    }
  });

  it("the tree still scrolls, which is what makes a small split usable", () => {
    // Removing the floor without this would trade an inert divider for a tree
    // that clips.
    expect(blockOf(css, ".ws-tree")).toMatch(/overflow-y:\s*auto/);
  });
});

describe("the divider's call site hands over the right height (card 362)", () => {
  // The arithmetic is pinned in wsSplit.test.ts; what no case in a DOM-less
  // suite can reach is WHICH number the component measures. A rect-derived
  // divisor here is the defect back with the fix still sitting next to it.
  const tab = stripComments(read("./WorkspaceTab.tsx", import.meta.url));

  it("measures the container's own inner height, not a distance between two rects", () => {
    const call = tab.match(/splitPctFromPointer\(([^;]*?)\);/)?.[1] ?? "";
    expect(call, "the divider does not go through splitPctFromPointer").not.toBe("");
    expect(call).toContain("cont.clientHeight");
    // The old shape, named so it cannot come back wearing the new function's
    // clothes: bottom-minus-top is the container height MINUS whatever stands
    // above the tree, and a percentage basis does not resolve against that.
    expect(call).not.toMatch(/bottom/);
  });

  it("the container it measures is the flex parent the basis resolves against", () => {
    expect(tab).toMatch(/className="ws" ref=\{containerRef\}/);
    expect(blockOf(read("../styles/panels.css", import.meta.url), ".ws")).toMatch(/flex-direction:\s*column/);
  });
});
