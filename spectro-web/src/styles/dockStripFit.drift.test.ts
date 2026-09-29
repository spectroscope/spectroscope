// Release 0.14.2, live check D2. German, 1440 px, the dock at its default
// width: the last tab "Bilder" was cut at the strip's edge beside the "Reiter"
// switch. The dark design showed only "B", and the point at the middle of the
// button hit the checkbox. Nothing overlapped in the DOM: the strip scrolls
// inside itself, its scrollbar is hidden, and the button ran past the strip's
// right edge, which sits a few pixels left of the switch.
//
// There is no layout in this suite, so the guard is in two parts.
//
// 1. The head's geometry rules: the strip is the one flex item that gives up
//    width, the switch never shrinks and is never lifted out of the flow, and
//    a strip that hides a tab fades the edge it hides it behind.
// 2. A width budget at the default dock width. The label widths and the room
//    for the strip are measurements; the chrome around each label (padding,
//    gap, one count badge) is read from the stylesheet, so a wider toggle
//    turns this red before a browser shows it.
//
// Measured 2026-09-29 with Playwright on the installed Chrome, 1440 x 900,
// dock at its default width (620 px), a fresh chat, all eight tabs offered
// (kanban/evidence/release-0.14.2/fix-d2/strip-before-pre.log): the label
// width is each button's width minus its padding, summed over the eight
// buttons; the room is the strip's clientWidth. These are snapshots of the
// fonts on that day and not properties of the code.

import { describe, expect, it } from "vitest";
import { blockOf, read, rules } from "../testkit/source";
import { DOCK_ORDER } from "../panels/dockModel";

const dock = read("./panel-dock.css", import.meta.url);
const tokens = read("../tokens.css", import.meta.url);

const SPACING = new Map<string, number>(
  [...tokens.matchAll(/--(sp-\d+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]),
);

/** A `0`, an `Npx` or a `var(--sp-N)` as px, or a throw naming what failed. */
function px(value: string, what: string): number {
  const v = value.trim();
  const token = v.match(/^var\(--(sp-\d+)\)$/);
  if (token) {
    const n = SPACING.get(token[1]);
    if (n === undefined) throw new Error(`${what}: tokens.css has no --${token[1]}`);
    return n;
  }
  if (v === "0") return 0;
  const literal = v.match(/^(\d+(?:\.\d+)?)px$/);
  if (literal) return Number(literal[1]);
  throw new Error(`${what}: cannot resolve "${v}" to px`);
}

/** One declaration's value in a block, or a throw naming the missing one. */
function decl(block: string, prop: string, what: string): string {
  const m = block.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`));
  if (!m) throw new Error(`${what} declares no ${prop}`);
  return m[1];
}

/** Left plus right of a `padding` shorthand with one or two values. */
function paddingInline(block: string, what: string): number {
  const parts = decl(block, "padding", what).trim().split(/\s+/);
  if (parts.length > 2) throw new Error(`${what}: padding with ${parts.length} values is not read here`);
  const side = parts.length === 2 ? parts[1] : parts[0];
  return 2 * px(side, `${what} padding`);
}

const toggle = blockOf(dock, ".dock-toggle");
const strip = blockOf(dock, ".dock-strip");
const tabsSwitch = blockOf(dock, ".dock-tabs-switch");
/** The count badge inside a toggle: the strip's own rule, else the global one in graph.css. */
function badgeBlock(): string {
  const scoped = rules("panel-dock.css", dock).filter((r) => r.selector === ".dock-toggle .tab-count");
  return scoped.length === 1 ? scoped[0].body : blockOf(read("./graph.css", import.meta.url), ".tab-count");
}

/** Width of one digit of the badge's font (--fs-11, mono), measured the same day. */
const BADGE_DIGIT_PX = 7;
/** The badge's own border, left plus right. */
const BADGE_BORDER_PX = 2;

// Label widths without padding and the strip's clientWidth, per design and
// language. "still" is the light design, "spectroscope" the dark one.
const MEASURED = [
  { case: "de, dark", labels: 368.2, room: 505 },
  { case: "de, light", labels: 347.9, room: 506 },
  { case: "en, dark", labels: 344.8, room: 511 },
  { case: "en, light", labels: 325.4, room: 513 },
];

describe("the dock head never lets the switch cover a tab (0.14.2 D2)", () => {
  it("the strip is the item that shrinks, and it scrolls inside itself", () => {
    expect(strip).toMatch(/(?:^|[;\s])flex:\s*1\s*;/);
    expect(strip).toMatch(/min-width:\s*0\s*;/);
    expect(strip).toMatch(/overflow-x:\s*auto\s*;/);
  });

  it("the switch keeps its width and stays in the flow", () => {
    expect(tabsSwitch).toMatch(/flex:\s*none\s*;/);
    expect(tabsSwitch).not.toMatch(/position:\s*(absolute|fixed|sticky)/);
    expect(tabsSwitch).not.toMatch(/margin[a-z-]*:\s*-/);
    const lifted = rules("panel-dock.css", dock).filter(
      (r) => r.subject.startsWith(".dock-tabs-switch") && /position:\s*(absolute|fixed|sticky)|z-index/.test(r.body),
    );
    expect(lifted.map((r) => r.selector)).toEqual([]);
  });

  it("a strip that hides a tab fades each edge it hides one behind", () => {
    for (const edge of ["start", "end", "both"]) {
      const faded = rules("panel-dock.css", dock).filter(
        (r) => r.selector.includes(`.dock-strip[data-overflow="${edge}"]`) && /(?:^|[;\s])mask-image:/.test(r.body),
      );
      expect(faded, `data-overflow="${edge}" has a mask`).toHaveLength(1);
    }
    const none = rules("panel-dock.css", dock).filter((r) => r.selector.includes('[data-overflow="none"]'));
    expect(none, "a strip that fits is not faded").toEqual([]);
  });

  it("all eight tabs and one count badge fit the default width in both languages and designs", () => {
    const n = DOCK_ORDER.length;
    expect(n).toBe(8);
    const perToggle = paddingInline(toggle, ".dock-toggle");
    const between = px(decl(strip, "gap", ".dock-strip"), ".dock-strip gap");
    const oneBadge =
      px(decl(toggle, "gap", ".dock-toggle"), ".dock-toggle gap") +
      paddingInline(badgeBlock(), ".dock-toggle .tab-count") +
      BADGE_BORDER_PX +
      BADGE_DIGIT_PX;
    for (const m of MEASURED) {
      const needed = m.labels + n * perToggle + (n - 1) * between + oneBadge;
      expect(needed, `${m.case}: ${needed.toFixed(1)} px needed in ${m.room} px`).toBeLessThanOrEqual(m.room);
    }
  });
});

describe("the strip tells the stylesheet which edge hides a tab (0.14.2 D2)", () => {
  it("both strips, tabs and side by side, carry data-overflow from stripOverflow", () => {
    const panel = read("../components/RightPanel.tsx", import.meta.url);
    const strips = [...panel.matchAll(/<div\s+([^>]*className="dock-strip"[^>]*)>/g)].map((m) => m[1]);
    expect(strips).toHaveLength(2);
    for (const attrs of strips) {
      expect(attrs).toMatch(/ref=\{stripRef\}/);
      expect(attrs).toMatch(/data-overflow=\{stripEdge\}/);
    }
    expect(panel).toMatch(/stripOverflow\(\s*el\.scrollLeft,\s*el\.scrollWidth,\s*el\.clientWidth\s*\)/);
  });
});
