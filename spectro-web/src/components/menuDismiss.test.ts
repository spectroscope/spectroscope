// A press inside a modal is not a press outside the menu that opened it.
//
// Measured 2026-08-17 on the live app (vite dev against a temp-home server,
// 1440x900): with the session tools in the three-dots menu, the translation
// trigger opened its sheet and the menu stayed open — the trigger sits inside
// the menu's anchor. The sheet does NOT: TranslatePanel portals it to the body
// so a bar with its own stacking context cannot decide whether it is visible.
// So the first `mousedown` anywhere in the sheet read as an outside click, the
// menu closed, TranslatePanel unmounted with it, and the sheet disappeared
// before the press became a click. One dispatched mousedown was enough; the
// sheet had no reachable control at all.
//
// Card 243 shipped that below 500px, where the menu was the tools' only home on
// a narrow screen. Card 255 makes the menu their home everywhere, so the same
// press would have taken translation away from every reader on every screen.

import { describe, expect, it } from "vitest";
import { dismissesMenu, MODAL_LAYER } from "./menuDismiss";
import { read, stripComments } from "../testkit/source";

describe("what closes an open popover menu", () => {
  it("closes on a press with nothing of ours under it", () => {
    expect(dismissesMenu({ inAnchor: false, inModal: false })).toBe(true);
  });

  it("stays open for a press on its own button or in its popover", () => {
    expect(dismissesMenu({ inAnchor: true, inModal: false })).toBe(false);
  });

  it("stays open under a modal that one of its rows opened", () => {
    // The modal is above the menu, not beside it: closing the menu underneath
    // takes the modal's own component down with it.
    expect(dismissesMenu({ inAnchor: false, inModal: true })).toBe(false);
  });

  it("stays open when both answers are yes", () => {
    // A modal rendered inline rather than portalled — the export dialog — is
    // inside the anchor AND a modal layer. Neither reading may close the menu.
    expect(dismissesMenu({ inAnchor: true, inModal: true })).toBe(false);
  });

  it("looks for the marker this app already puts on every modal", () => {
    // 19 dialogs carry aria-modal="true" (grep, 2026-08-17). A private class
    // name would have to be kept in step with each of them.
    expect(MODAL_LAYER).toBe('[aria-modal="true"]');
  });
});

describe("the menu asks both questions", () => {
  const menu = stripComments(read("./DisclosureMenu.tsx", import.meta.url));

  it("hands the decision the anchor test and the modal test", () => {
    // The real call shape, not the mere presence of an import: a caller that
    // passes `inModal: false` would compile, pass every unit test above, and
    // lose the sheet again on the next press.
    expect(menu).toMatch(/const press = \{[\s\S]{0,240}inAnchor:[\s\S]{0,240}inModal:[\s\S]{0,240}\}/);
    expect(menu).toMatch(/dismissesMenu\(press\)/);
    expect(menu).toMatch(/closest\(MODAL_LAYER\)/);
  });

  it("still closes the menu when the decision says so", () => {
    // The guard belongs in the mousedown listener, not somewhere the listener
    // has already decided to close.
    expect(menu).toMatch(/dismissesMenu\([\s\S]{0,320}setOpen\(false\)/);
  });
});
