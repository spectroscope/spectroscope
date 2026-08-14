// Card 219, first cut — the separations that make the dock what it is, read
// off disk because no type checks them.
//
// Three facts carry the owner's ask ("each surface stands on its own"):
// 1. The terminal no longer lives inside the Files surface. Before this card,
//    switching the right panel's tab unmounted WorkspaceTab and took the PTY
//    with it — scrollback and a running shell died because a NEIGHBOUR closed.
// 2. Every surface is its own keyed section in the dock. Keyed identity is
//    what keeps React from remounting a sibling when one panel closes; a key
//    never reaches the rendered markup, so it is pinned here at the source.
// 3. The browser panel's `active` carries the covering state: a dialog that
//    opens over the dock must hide the native pane FIRST, because no CSS can
//    cover a WebContentsView (card 201). A pane that stays visible under a
//    modal is a disclosure surface, not a cosmetic bug.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(path.join(__dirname, "..", rel), "utf8");

const rightPanel = read(path.join("components", "RightPanel.tsx"));
const workspaceTab = read(path.join("workspace", "WorkspaceTab.tsx"));
const app = read("App.tsx");

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

describe("the terminal stands on its own", () => {
  it("is no longer mounted inside the Files surface", () => {
    expect(mounts(workspaceTab, "TerminalPane")).toBe(0);
  });

  it("is a dock panel of its own", () => {
    expect(mounts(rightPanel, "TerminalPanel")).toBe(1);
  });
});

describe("every surface is one keyed section", () => {
  it("mounts each surface exactly once in the dock", () => {
    for (const name of ["WorkPanel", "AgentsTab", "PlanTab", "SystemContextTab", "WorkspaceTab"]) {
      expect(mounts(rightPanel, name), name).toBe(1);
    }
  });

  it("keys the sections by panel id, never by position", () => {
    expect(rightPanel).toMatch(/key=\{id\}/);
  });
});

describe("the divider keeps the house idiom", () => {
  it("answers the keyboard and captures the pointer", () => {
    // Static markup drops handlers, so the wiring is read at the source: the
    // one resize idiom this card keeps (the .ws-divider one) is pointer events
    // WITH pointer capture plus arrow keys — Resizer.tsx's mouse-only shape
    // must not creep back in under a new name.
    expect(rightPanel).toMatch(/onKeyDown=\{onKey\}/);
    expect(rightPanel).toMatch(/setPointerCapture/);
    expect(rightPanel).toMatch(/releasePointerCapture/);
  });
});

describe("the browser panel tells the shell when it is covered or shut", () => {
  it("derives the segment's active from the panel mode AND the covering state", () => {
    expect(rightPanel).toMatch(/active=\{[^}]*covered/);
  });

  it("is handed the shown session from the app, like the other two doors", () => {
    // Within the element's own props ([^>] keeps the match inside the tag —
    // the dock's JSX carries no inline arrows before this prop by construction).
    expect(app).toMatch(/<RightPanel[^>]*sessionId=\{shownSessionId\}/);
  });

  it("reports again on a layout commit, not only on a resize", () => {
    // A ResizeObserver fires on size, never on position. The dock re-reports
    // whenever its layout state changes, so a panel that moved without
    // resizing still posts its rectangle (the card's riskiest seam).
    expect(rightPanel).toMatch(/reportNonce=\{/);
  });

  it("exits fullscreen from the keyboard and wears the fullscreen class", () => {
    expect(rightPanel).toContain("dock-panel--full");
    expect(rightPanel).toMatch(/key === "Escape"/);
  });
});
