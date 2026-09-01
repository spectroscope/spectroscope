// The session tools live in the three-dots menu, at every width (card 255).
// Read off disk like the other style guards.
//
// Card 243 built this as a WIDTH decision: chips in the action row while the
// composer column was wide, chips in the menu's section below 500px, exactly
// one copy visible. The owner's answer to that build was that the menu is
// enough — "wenn in den drei punkten export und translation drinne sind können
// sie hier im haupt view weg" — so the threshold is gone, and with it the
// arithmetic that picked 500px. The assertions that pinned the threshold are
// REPLACED rather than relaxed: their premise (a width at which the row is the
// home) no longer exists, and a loosened guard would have kept passing while
// the rule underneath it changed.
//
// Measured on a temp-home jar at 1440x900 before the flip: at composer column
// 860px the row's copy was `display: flex` and 179.7px wide, at column 488px it
// was `display: none` and the menu carried the section. After the flip both
// widths report `display: none`, and there is no @container left to ask.
//
// What survives from card 243 is the promise underneath the fold: no control is
// ever pushed out of the rounded container, because a clipped control is an
// unreachable one. That promise now rests on the two wrap rules alone (the
// lab's chat column goes to 220px), so they are pinned here as before.

import { describe, expect, it } from "vitest";
import { blockOf } from "../testkit/source";
import { blankBlockComments as code, read } from "../testkit/source";


/**
 * The stylesheet with every at-rule BLOCK removed, so what is left is what
 * applies unconditionally.
 *
 * This is the shape of the guard, not a convenience: "the row is never a home"
 * is a claim about rules that answer to no query, and a rule wrapped back into
 * an `@container` or an `@media` would satisfy a plain substring check while
 * reintroducing exactly the width dependency this card removed. Removed here,
 * such a rule simply disappears from the text and the assertion fails.
 */
function unconditional(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@", i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    const open = css.indexOf("{", at);
    const semi = css.indexOf(";", at);
    // A statement at-rule (`@import "x.css";`) carries no block: skip the
    // statement, not the next rule's braces.
    if (open < 0 || (semi > -1 && semi < open)) {
      if (semi < 0) return out;
      i = semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

describe("the tools have one home, and it is the menu (card 255)", () => {
  const modal = code(read("./modal-composer.css", import.meta.url));
  const chat = code(read("./chat.css", import.meta.url));

  it("hides the row's copy without asking how wide anything is", () => {
    expect(blockOf(unconditional(modal), ".composer-tools")).toMatch(/display:\s*none/);
  });

  it("keeps no width query for the composer at all", () => {
    // The 500px threshold was the whole of card 243's decision. Leaving the
    // query in place with a different body is the drift that would read as
    // this card being done while the row came back on some screen.
    expect(modal).not.toContain("@container composer");
  });

  it("drops the container the threshold measured", () => {
    // `container: composer / inline-size` existed for that one query. A
    // containment context nobody asks about is not free: `container-type`
    // brings layout and style containment with it, so it changes what the
    // composer's descendants — the slash picker, the export dialog's fixed
    // backdrop — resolve against, for no reader's benefit.
    expect(blockOf(modal, ".composer-inner")).not.toMatch(/container(-type)?:/);
  });

  it("shows the menu's section without a query to switch it on", () => {
    const section = blockOf(unconditional(modal), ".disc-fold");
    expect(section).toMatch(/display:\s*flex/);
    expect(section).toMatch(/flex-direction:\s*column/);
  });

  it("leaves no rule that hides the menu's section again", () => {
    // Card 243 hid it by default and revealed it below the threshold. Both
    // halves are gone; a leftover `display: none` would empty the only home
    // the chips have, and nothing else in the app would look wrong.
    for (const [i, part] of modal.split(".disc-fold").entries()) {
      if (i === 0) continue;
      expect(part.slice(0, part.indexOf("}")), "a .disc-fold block hides it").not.toMatch(
        /display:\s*none/,
      );
    }
  });

  it("gives the suppressed row no shape in any stylesheet", () => {
    // chat.css used to lay the row out (nowrap, right-aligned, and a centred
    // variant for the archive bar). Those rules described something a reader
    // saw; nobody sees it now, and a rule for an invisible element is the
    // phantom the next reader styles around. The element stays in the markup —
    // the chat builds the chips once and hands them to the menu — so this is
    // about its shape, not its existence.
    expect(chat).not.toContain(".composer-tools");
  });

  it("wraps the action row as the last resort — nothing clips or escapes", () => {
    expect(blockOf(modal, ".composer-actions")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("wraps the archive bar's own row too", () => {
    // Card 243's verify round measured this one: the tools left the archive
    // bar, but the bar's own controls (note, resume, export, delete,
    // return-to-live) sat in a nowrap row — at chat 360 / inner 328 the EN
    // "Return to live" rendered 55px outside the container, and DE escaped
    // even at a 1440 window with a 710px dock. Same last resort as the action
    // row: wrap, never clip.
    expect(blockOf(modal, ".archive-bar .composer-inner")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("keeps the menu offering the section, and the chat handing it the tools", () => {
    const menu = read("../components/DisclosureMenu.tsx", import.meta.url);
    expect(menu).toContain("disc-fold");
    expect(menu).toMatch(/fold\??:/); // the prop, typed
    expect(read("../components/Chat.tsx", import.meta.url)).toMatch(
      /<DisclosureMenu[\s\S]{0,200}fold=/,
    );
  });
});
