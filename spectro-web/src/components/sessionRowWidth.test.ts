// Card 464 (owner, 2026-09-29): "die Chats ... der Trenner zwischen dem
// Chat-Inneren und der Chatliste, die ist echt breit. Macht das mal bitte so,
// dass die da fast an den Rand rangehen." A session row reserved 28 px on its
// right for a menu button that shows only under the pointer, so every title
// ended 28 px early. The title runs to the row's own padding now, and the
// button, when it shows, stands over the end of the title on a ground of its
// own.

import { describe, expect, it } from "vitest";
import { blockOf, read } from "../testkit/source";

const menu = read("../styles/session-menu.css", import.meta.url);

describe("a session title runs to the edge of its row", () => {
  it("gives the button its ground wherever it shows without a pointer: focus, touch, narrow", () => {
    // Review 2026-09-29: below 768 px and on touch screens the button is
    // always shown, and it lay on the title's last letters with no ground.
    expect(blockOf(menu, ".session-item:focus-within .session-menu-btn:not(:hover)")).toMatch(
      /background:\s*var\(--surface-2\)/,
    );
    expect(menu).toMatch(
      /@media \(max-width: 767px\), \(hover: none\) \{[^}]*\.session-menu-btn \{[^}]*background:\s*var\(--surface-2\)/,
    );
  });

  it("reserves no room for the hidden menu button", () => {
    const row = blockOf(menu, ".session-item .session-row");
    expect(row).not.toMatch(/padding-right:\s*28px/);
    expect(row).toMatch(/padding-right:\s*var\(--sp-2\)/);
  });

  it("gives the button a ground when it shows, so it does not sit on letters", () => {
    expect(
      blockOf(menu, '.session-item:hover .session-menu-btn:not(:hover):not([aria-expanded="true"])'),
    ).toMatch(/background:\s*var\(--surface-2\)/);
  });
});
