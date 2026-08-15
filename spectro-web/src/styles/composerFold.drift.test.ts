// Card 243's no-overflow rule, read off disk like the other style guards.
//
// Measured 2026-08-15 on a temp-home jar: at the owner's ~1310px window with
// the dock open the composer's inner column is 410px, and at a 1150px window
// it is 324px — there the mic device chevron and the gear ESCAPED the rounded
// container (right edges 591 and 643 against an inner right edge of 580), and
// the tools group wrapped "translation" onto a second line first
// (.composer-tools carried flex-wrap: wrap).
//
// The deliberate degradation: below the fold threshold the tools chips leave
// the row and reappear as a section in the three-dots menu (the overflow menu
// the row already has); the icons keep one line; and if a surface is narrower
// than even the icon row (the lab's 220px chat column), the row wraps rather
// than clips — a clipped control is an unreachable one. The draft box and its
// send seat sit ABOVE this row and never shrink for it.
//
// The threshold: the un-folded row needs ~463px (chips 44+44+179+44+44+16+44
// plus six 8px gaps, EN labels); 500 carries the German labels too. Folded,
// the row needs ~277px, under the 360px chat floor card 242 pins.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The declarations of the FIRST block whose selector line contains `sel`,
 *  searched from `from` (to look inside an at-rule block). */
function blockOf(css: string, sel: string, from = 0): string {
  const at = css.indexOf(sel, from);
  expect(at, `selector ${sel} exists`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("the composer folds instead of spilling (card 243)", () => {
  const modal = read("./modal-composer.css");
  const chat = read("./chat.css");

  it("the composer column is the container the fold measures", () => {
    expect(blockOf(modal, ".composer-inner")).toMatch(/container:\s*composer\s*\/\s*inline-size/);
  });

  it("below the fold threshold the tools chips leave the row for the menu", () => {
    const q = modal.indexOf("@container composer (max-width: 500px)");
    expect(q, "the fold query exists at the measured threshold").toBeGreaterThan(-1);
    expect(blockOf(modal, ".composer-tools", q)).toMatch(/display:\s*none/);
    expect(blockOf(modal, ".disc-fold", q)).not.toMatch(/display:\s*none/);
  });

  it("the folded chips hide in the menu above the threshold", () => {
    // The default: the menu section is absent until the fold engages — wide
    // screens must never show the chips twice.
    const firstDiscFold = blockOf(modal, ".disc-fold");
    expect(firstDiscFold).toMatch(/display:\s*none/);
  });

  it("the tools group no longer stacks lines of its own", () => {
    expect(blockOf(chat, ".composer-tools")).toMatch(/flex-wrap:\s*nowrap/);
  });

  it("the action row wraps as the last resort — nothing clips or escapes", () => {
    expect(blockOf(modal, ".composer-actions")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("the menu offers the fold section and the chat hands it the tools", () => {
    const menu = read("../components/DisclosureMenu.tsx");
    expect(menu).toContain("disc-fold");
    expect(menu).toMatch(/fold\??:/); // the prop, typed
    const chatTsx = read("../components/Chat.tsx");
    expect(chatTsx).toMatch(/<DisclosureMenu[\s\S]{0,200}fold=/);
  });
});
