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

describe("the workspace lays panels out as COLUMNS (card 236, replacing 228's grid)", () => {
  // Card 228's pins stood on auto-fit: the column count followed the
  // workspace width. That premise is the measured defect of card 236 — a
  // resize crossing a breakpoint re-seated every card — so these pins are
  // REPLACED, not loosened: the arrangement now comes from the layout store's
  // column model and the stylesheet must never derive a column from a width.
  it("declares the column row in the dock stylesheet, with no width-derived columns", () => {
    const css = readFileSync(path.join(__dirname, "..", "styles", "panel-dock.css"), "utf8");
    const at = css.indexOf(".dock-columns");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/display:\s*flex/);
    // The jumping's mechanism, banned at the source: no auto-fit / auto-fill
    // track anywhere in the dock stylesheet.
    expect(css).not.toMatch(/auto-fit|auto-fill/);
  });

  it("drags on both axes with the promoted ws-divider idiom: capture, keys, floors", () => {
    // Pointer capture keeps the drag when the pointer outruns the 8px strip;
    // the arrow keys are the keyboard path; PANEL_MIN_PX is the pixel floor
    // both axes clamp against before a ratio is stored.
    expect(rightPanel).toMatch(/setPointerCapture/);
    expect(rightPanel).toMatch(/releasePointerCapture/);
    expect(rightPanel).toMatch(/ArrowLeft|ArrowRight/);
    expect(rightPanel).toMatch(/ArrowUp|ArrowDown/);
    expect(rightPanel).toMatch(/PANEL_MIN_PX/);
  });

  it("re-reports the browser rectangle on every arrangement commit — drags included", () => {
    // The seam (cards 219/226/228): the segment's report effect re-runs off
    // reportNonce. Card 236 adds the arrangement string to the nonce, so a
    // divider drag or a column change re-posts the hole even when only its
    // POSITION moved — the change a ResizeObserver cannot see.
    expect(rightPanel).toMatch(/reportNonce[\s\S]{0,200}dockColumns/);
  });
});

describe("the browser panel tells the shell when it is covered or shut", () => {
  it("derives the segment's active from the panel mode AND the covering state", () => {
    expect(rightPanel).toMatch(/active=\{[^}]*covered/);
  });

  it("counts a SIBLING'S fullscreen as covering — no CSS can paint over the pane", () => {
    // Card 228 gave every card the expand control. A files card gone
    // fullscreen lies over the browser hole with z-index alone, which is
    // exactly the covering a WebContentsView ignores (card 201) — so the
    // segment's active must fold the expanded-sibling case in, the same way
    // it folds `covered`.
    expect(rightPanel).toMatch(/active=\{[^}]*fullPanel/);
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

  it("escapes the reveal's containing block while fullscreen", () => {
    // The scroll-reveal leaves will-change: transform on .chat-row, which
    // traps every position:fixed descendant (measured 2026-08-14: fullscreen
    // laid out at 1200x767 inside the row). The dock stylesheet must lift the
    // row's containing-block properties for exactly the fullscreen case.
    const css = readFileSync(path.join(__dirname, "..", "styles", "panel-dock.css"), "utf8");
    const at = css.indexOf(":has(.dock-panel--full)");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/will-change:\s*auto/);
    expect(rule).toMatch(/transform:\s*none/);
  });
});
