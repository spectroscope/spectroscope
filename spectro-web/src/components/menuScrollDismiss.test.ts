// Card 459: a row menu opened on a session whose chat streams in view. The
// chat follows its live edge and scrolls on every batch; that scroll does not
// move the menu's button, so it must not close the menu. A scroll that moves
// the button (the rail, the page) still does.
import { describe, expect, it } from "vitest";
import { scrollDismissesMenu } from "./menuDismiss";

describe("scrollDismissesMenu", () => {
  it("keeps the menu open when something that does not hold its button scrolls", () => {
    expect(scrollDismissesMenu({ inAnchor: false, holdsAnchor: false })).toBe(false);
  });

  it("closes it when the scrolled box holds its button, because the button moved", () => {
    expect(scrollDismissesMenu({ inAnchor: false, holdsAnchor: true })).toBe(true);
  });

  it("never closes it for a scroll inside the menu itself", () => {
    expect(scrollDismissesMenu({ inAnchor: true, holdsAnchor: true })).toBe(false);
  });
});
