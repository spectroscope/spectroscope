// Card 219 built the panel MODEL (independent show/hide, fold-without-unmount,
// keyed identity); card 228 criterion 0 changes the LAYOUT those panels land
// in: a GRID of independent cards, two or three columns like the reference,
// each card with expand and close — none inside a shared section, and no
// divider pair arithmetic between vertical neighbours.
//
// renderToStaticMarkup, the house idiom (sessionRowDensity.test.tsx says why):
// the suite runs in plain Node, so these assertions are about output markup.
// No effect runs here — persistence and the viewport POST are pinned by the
// layout store's own tests and the drift tests beside this file.

import { describe, expect, it, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RightPanel } from "../components/RightPanel";
import { DOCK_ORDER, panelFills } from "../panels/dockModel";
import {
  __resetForTests,
  openDockPanel,
  setDockColumnShare,
  setDockColumnSplit,
  toggleDockCollapse,
  toggleDockPanel,
} from "../state/layout";

beforeEach(() => __resetForTests());

const base = {
  agents: [],
  plan: null,
  onClose: () => {},
  thinking: true,
  workspace: null,
  sessionId: null as string | null,
};

function render(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(<RightPanel {...base} {...extra} />);
}

/** All data-panel ids present in the markup, in DOM order. */
function panelsIn(html: string): string[] {
  return [...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("each surface stands on its own", () => {
  it("opens with the roster panel alone — the face the app has always had", () => {
    expect(panelsIn(render())).toEqual(["agents"]);
  });

  it("offers a toggle per panel; work only when the v2 reading offers it", () => {
    const v1 = render();
    // Six toggles (no work), each carrying its pressed state.
    expect(count(v1, "dock-toggle")).toBeGreaterThanOrEqual(6);
    expect(count(v1, 'aria-pressed="true"')).toBe(1); // agents only
    const v2 = render({ work: [] });
    expect(count(v2, "dock-toggle")).toBeGreaterThan(count(v1, "dock-toggle"));
  });

  it("shows several panels at once, as sibling cards", () => {
    toggleDockPanel("plan");
    toggleDockPanel("files");
    expect(panelsIn(render())).toEqual(["agents", "plan", "files"]);
  });

  it("closing one panel leaves the rest standing", () => {
    toggleDockPanel("plan");
    toggleDockPanel("files");
    toggleDockPanel("plan"); // close it again
    expect(panelsIn(render())).toEqual(["agents", "files"]);
  });

  it("keys every section by its panel id, so a toggle never remounts a sibling", () => {
    // Keyed JSX children tie identity to the id rather than to the ordinal
    // position — that is what keeps the terminal's PTY alive when a panel
    // above it closes. Keys never reach the markup, so this is pinned in
    // dockSeparation.drift.test.ts; here we pin the order instead — since
    // card 236 the DOM order is the ARRANGEMENT's (the order panels were
    // opened in, column-major), not DOCK_ORDER.
    toggleDockPanel("terminal");
    toggleDockPanel("context");
    expect(panelsIn(render())).toEqual(["agents", "terminal", "context"]);
  });
});

describe("the workspace is columns of cards (card 236 over card 228)", () => {
  // Card 228's auto-fit grid derived the column count from the width and
  // re-flowed the cards on every breakpoint — the owner's "das Layout
  // springt", measured live 2026-08-14. Card 236 replaces it: the arrangement
  // comes from the layout store's column model, the width only scales pixels.
  it("walks the fill rule in the DOM: full height → split → new column", () => {
    // CARD 362 MOVED HALF OF THIS CASE, and the half that moved is named here
    // rather than quietly re-typed: it used to press `files` as its second
    // panel, and Files now takes a column of its own. What did NOT move is the
    // shape the case is about — full height → split → new column — so the
    // second panel is a PROSE one (plan) and the walk is unchanged.
    // One panel: one column, no dividers.
    let html = render();
    expect(count(html, "data-col=")).toBe(1);
    expect(count(html, 'role="separator"')).toBe(0);
    // A second prose panel splits the first column: one column, one row divider.
    toggleDockPanel("plan");
    html = render();
    expect(count(html, "data-col=")).toBe(1);
    expect(count(html, 'aria-orientation="horizontal"')).toBe(1);
    expect(count(html, 'aria-orientation="vertical"')).toBe(0);
    // A third opens a NEW column: two columns, plus a column divider.
    toggleDockPanel("context");
    html = render();
    expect(count(html, "data-col=")).toBe(2);
    expect(count(html, 'aria-orientation="horizontal"')).toBe(1);
    expect(count(html, 'aria-orientation="vertical"')).toBe(1);
    expect(panelsIn(html)).toEqual(["agents", "plan", "context"]);
  });

  it("a panel that FILLS lands in a column of its own, with no row divider (card 362)", () => {
    // The owner's gesture, in the DOM: the dock opens on the roster, he presses
    // Files. Before this card that made one column with a horizontal divider
    // through it, and the tree and its preview shared half the height with the
    // roster above them.
    toggleDockPanel("files");
    const html = render();
    expect(count(html, "data-col=")).toBe(2);
    expect(count(html, 'aria-orientation="horizontal"')).toBe(0);
    expect(count(html, 'aria-orientation="vertical"')).toBe(1);
    expect(panelsIn(html)).toEqual(["agents", "files"]);
  });

  it("projects the stored ratios as flex weights — pixels follow the store, never the window", () => {
    // Two prose panels and then a third: the case is about the PROJECTION, and
    // it needs a column of two to have a split to project. Card 362 took `files`
    // out of that role — a filling panel never shares — so `plan` stands in.
    toggleDockPanel("plan");
    toggleDockPanel("context");
    setDockColumnSplit(0, 0.3);
    setDockColumnShare(0, 0.25); // weights 0.5 : 1.5
    const html = render();
    expect(html).toContain("flex-grow:0.5");
    expect(html).toContain("flex-grow:1.5");
    expect(html).toContain("flex-grow:0.3");
    expect(html).toContain("flex-grow:0.7");
  });

  it("shows no row divider against a folded header — there is no height to trade", () => {
    // `plan` since card 362: a folded panel can only be the top half of a
    // shared column, and Files no longer shares one.
    toggleDockPanel("plan");
    toggleDockCollapse("plan");
    const html = render();
    expect(count(html, 'role="separator"')).toBe(0);
  });

  it("gives the fill class to exactly the panels the seating rule calls filling", () => {
    // Card 362 made ONE predicate answer two questions: which panels get a
    // column to themselves, and which bodies own their own layout instead of
    // scrolling as prose. This case is what keeps them the same answer — a
    // hand-typed list back in RightPanel would seat Files alone and then let
    // its body scroll, which is the two-copies-of-one-truth defect wearing the
    // face of a fix.
    for (const id of DOCK_ORDER) openDockPanel(id); // open, never toggle: agents starts open
    const html = render({ work: [] });
    for (const id of DOCK_ORDER) {
      const at = html.indexOf(`data-panel="${id}"`);
      expect(at, `${id} did not render`).toBeGreaterThan(-1);
      // This panel's own section: up to the next one, so a neighbour's fill
      // class can never be read as this one's.
      const next = html.indexOf("data-panel=", at + 1);
      const section = html.slice(at, next === -1 ? undefined : next);
      expect(section.includes("dock-panel-body--fill"), `${id}`).toBe(panelFills(id));
    }
  });

  it("gives EVERY card an expand control and a close control", () => {
    toggleDockPanel("plan");
    toggleDockPanel("files");
    const html = render();
    const cards = panelsIn(html).length;
    expect(count(html, "dock-full-btn")).toBe(cards);
    expect(count(html, "dock-panel-x")).toBe(cards);
  });

  it("names each card's OWN panel on its expand control, not the browser's", () => {
    // Found live on 2026-08-14: dock.fullscreen was written for card 219's
    // single fullscreen surface, so the Files card announced "Browser full
    // screen". The label carries the panel's name now — one key, one {p}.
    toggleDockPanel("files");
    const html = render();
    expect(html).toContain('aria-label="Files full screen"');
    expect(html).not.toContain('aria-label="Browser full screen"');
    toggleDockPanel("browser");
    expect(render()).toContain('aria-label="Browser full screen"');
  });
});

describe("collapse hides, it does not unmount", () => {
  it("keeps a collapsed panel's CONTENT in the tree, hidden with display:none", () => {
    toggleDockCollapse("agents");
    const html = render();
    expect(html).toContain("dock-panel--collapsed");
    expect(html).toContain('style="display:none"');
    // The surface itself is still mounted inside the hidden body — the roster
    // renders its own empty-state. A wrapper div hidden around NOTHING would
    // pass the two lines above; this line is the one that pins mounted-not-
    // unmounted (the 955 ms trace lesson, card 175 — and for the terminal the
    // difference between a folded shell and a killed one).
    expect(html).toContain("agents-empty");
  });

  it("says which way its fold control points", () => {
    const open = render();
    expect(open).toContain('aria-expanded="true"');
    __resetForTests();
    toggleDockCollapse("agents");
    expect(render()).toContain('aria-expanded="false"');
  });
});

describe("the browser is one of them", () => {
  it("renders the browser panel with the hole", () => {
    toggleDockPanel("browser");
    const html = render();
    expect(panelsIn(html)).toContain("browser");
    expect(html).toContain("browser-hole");
  });
});

describe("an empty dock says so", () => {
  it("offers the strip and a sentence instead of a blank column", () => {
    toggleDockPanel("agents");
    const html = render();
    expect(panelsIn(html)).toEqual([]);
    expect(html).toContain("dock-empty");
  });
});
