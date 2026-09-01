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
// The locator is card 360's parsed one. `.ws-tree` also appears under an
// ancestor in this sheet's neighbourhood; a substring search would have
// answered with whichever rule stood first.

import { describe, expect, it } from "vitest";
import { blockOf, read, rules, stripComments } from "../testkit/source";

const css = read("../styles/panels.css", import.meta.url);

/** A CSS length in px, or null when the declaration is absent or not px. */
function pxOf(decls: string, prop: string): number | null {
  const m = decls.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  if (!m) return null;
  const px = m[1].trim().match(/^(-?[\d.]+)px$/);
  return px ? Number(px[1]) : null;
}

describe("the tree's height is the split's to decide (card 362)", () => {
  it("declares no pixel floor that could outrank the stored split", () => {
    const floor = pxOf(blockOf(css, ".ws-tree"), "min-height");
    // null (absent) or 0 both mean "the basis decides"; anything else is a
    // height the divider cannot go under, silently.
    expect(floor === null || floor === 0, `.ws-tree min-height is ${String(floor)}px`).toBe(true);
  });

  it("no scoped .ws-tree rule reintroduces one either", () => {
    // The parsed locator above answers for the UNSCOPED rule only. A floor
    // under an ancestor would be just as inert-making and would not show up
    // there, which is the shape card 360 was written about.
    for (const rule of rules("panels.css", css)) {
      if (rule.subject !== ".ws-tree") continue;
      const floor = pxOf(rule.body, "min-height");
      expect(floor === null || floor === 0, `${rule.selector} (line ${rule.line})`).toBe(true);
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
