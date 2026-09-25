// Card 445, criterion 1, where the stylesheet carries it: the three-dots button
// is hidden until the row is hovered or holds focus, and always shown below
// 768 px or on a screen without hover. Read off the sheet (no DOM in this
// suite); the wave's browser stage looks at the drawn result.

import { describe, expect, it } from "vitest";
import { blankBlockComments as code, read } from "../testkit/source";

const css = code(read("./session-menu.css", import.meta.url));

/** Every `selector { declarations }` block, with the at-rule it sits in. */
function rules(sheet: string): { at: string; selector: string; decls: string }[] {
  const out: { at: string; selector: string; decls: string }[] = [];
  const at = /@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  let m: RegExpExecArray | null;
  const nested = new Set<number>();
  while ((m = at.exec(sheet)) !== null) {
    const prelude = m[1].trim();
    const body = m[2];
    const inner = /([^{}]+)\{([^{}]*)\}/g;
    let r: RegExpExecArray | null;
    while ((r = inner.exec(body)) !== null) {
      out.push({ at: prelude, selector: r[1].trim(), decls: r[2].replace(/\s+/g, "") });
    }
    for (let i = m.index; i < m.index + m[0].length; i++) nested.add(i);
  }
  const top = /([^{}]+)\{([^{}]*)\}/g;
  while ((m = top.exec(sheet)) !== null) {
    if (nested.has(m.index + m[0].length - 1)) continue;
    const selector = m[1].trim();
    if (selector.startsWith("@")) continue;
    out.push({ at: "", selector, decls: m[2].replace(/\s+/g, "") });
  }
  return out;
}

const all = rules(css);

describe("the three-dots button", () => {
  it("is hidden by default and still in the tab order", () => {
    const base = all.find((r) => r.at === "" && r.selector === ".session-menu-btn");
    expect(base?.decls).toContain("opacity:0");
    expect(base?.decls).not.toMatch(/display:none|visibility:hidden/);
  });

  it("shows on hover, on keyboard focus inside the row and while its menu is open", () => {
    const reveal = all.find((r) => r.at === "" && r.decls.includes("opacity:1"));
    expect(reveal).toBeDefined();
    const selectors = reveal!.selector.split(",").map((s) => s.trim());
    expect(selectors).toContain(".session-item:hover .session-menu-btn");
    expect(selectors).toContain(".session-item:focus-within .session-menu-btn");
    expect(selectors).toContain('.session-menu-btn[aria-expanded="true"]');
  });

  it("is always shown below 768 px and on a screen without hover", () => {
    const narrow = all.find((r) => r.at.includes("max-width: 767px") && r.selector === ".session-menu-btn");
    expect(narrow?.decls).toContain("opacity:1");
    expect(narrow?.at).toContain("(hover: none)");
  });
});

describe("the delete item", () => {
  it("wears the danger colour", () => {
    const danger = all.find((r) => r.selector === ".row-menu-item--danger");
    expect(danger?.decls).toContain("color:var(--error)");
  });
});
