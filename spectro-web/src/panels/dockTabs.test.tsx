// Card 444: the dock shows one panel at a time on request.
//
// The owner, 2026-09-25: "wenn man auf Files klickt, sieht man nur die Files.
// Und wenn man dann auf Work klickt, sieht man nur die Work." And 2026-09-29:
// the default stays side by side, the switch sits on the dock itself.
//
// Tabs mode lives in the layout store, because every door into the dock goes
// through the store's verbs (dockOpeners.drift.test.ts lists them). The entry
// paths below are the functions those doors call, imported rather than
// re-typed, so a door that changes what it calls changes what is tested.

import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RightPanel } from "../components/RightPanel";
import { DOCK_ORDER } from "./dockModel";
import { keepOnTabs, nextParked, tabsSeating } from "./dockTabs";
import { pressDockPanel } from "./headerPanelControls";
import {
  __getState,
  __resetForTests,
  applyDockReturn,
  DEFAULT_LAYOUT,
  openDockPanel,
  openRightPanel,
  readLayoutBlob,
  setDockTabs,
  toggleDockPanel,
  toggleRightPanel,
} from "../state/layout";
import type { DockPanelId, LayoutState } from "../state/layout";
import { revealImagesPanel, toggleImagesPanel } from "../state/imagesPanel";
import { __resetBrowserRevealForTests, revealBrowserPanel } from "../state/browserReveal";
import { dict } from "../i18n/i18n";

beforeEach(() => {
  __resetForTests();
  __resetBrowserRevealForTests();
});

/** The panels whose mode is not "closed", in dock order. */
function shownPanels(s: LayoutState = __getState()): DockPanelId[] {
  const field = (id: DockPanelId): keyof LayoutState =>
    `dock${id[0].toUpperCase()}${id.slice(1)}` as keyof LayoutState;
  return DOCK_ORDER.filter((id) => s[field(id)] !== "closed");
}

function renderDock(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <RightPanel
      agents={[]}
      plan={null}
      onClose={() => {}}
      thinking
      workspace={null}
      sessionId={null}
      {...extra}
    />,
  );
}

describe("a switch with two positions (criterion 1)", () => {
  it("defaults to side by side: owner call 1, answered 2026-09-29", () => {
    expect(DEFAULT_LAYOUT.dockTabs).toBe(false);
    expect(__getState().dockTabs).toBe(false);
  });

  it("is kept per browser and read at hydration, before the first render", () => {
    const { state } = readLayoutBlob(JSON.stringify({ ...DEFAULT_LAYOUT, dockTabs: true }), null);
    expect(state.dockTabs).toBe(true);
    const off = readLayoutBlob(JSON.stringify({ ...DEFAULT_LAYOUT, dockTabs: false }), null);
    expect(off.state.dockTabs).toBe(false);
  });

  it("junk heals to side by side without resetting the rest of the layout", () => {
    const { state, recovered } = readLayoutBlob(
      JSON.stringify({ ...DEFAULT_LAYOUT, dockTabs: "yes", sidebarW: 300 }),
      null,
    );
    expect(recovered).toBe(false);
    expect(state.dockTabs).toBe(false);
    expect(state.sidebarW).toBe(300);
  });

  it("a stored tabs layout with several panels open heals to one", () => {
    const blob = {
      ...DEFAULT_LAYOUT,
      dockTabs: true,
      dockAgents: "open",
      dockFiles: "open",
      dockColumns: "agents~1~0.5|files~1~0.5",
    };
    const { state } = readLayoutBlob(JSON.stringify(blob), null);
    expect(shownPanels(state)).toEqual(["agents"]);
    expect(state.dockColumns).toBe("agents~1~0.5");
  });

  it("sits on the dock as a checkbox with a name and a tooltip in both languages", () => {
    for (const key of ["dock.tabs", "dock.tabsTitle"]) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key].en.length).toBeGreaterThan(0);
      expect(dict[key].de.length).toBeGreaterThan(0);
    }
    const html = renderDock();
    const sw = html.match(/<label class="dock-tabs-switch"[^>]*>[\s\S]*?<\/label>/)?.[0] ?? "";
    expect(sw).toContain('type="checkbox"');
    expect(sw).toContain(`title="${dict["dock.tabsTitle"].en}"`);
    expect(sw).toContain(`>${dict["dock.tabs"].en}<`);
    expect(sw).not.toContain("checked");
    setDockTabs(true);
    expect(renderDock()).toMatch(/<label class="dock-tabs-switch"[^>]*>[\s\S]*?checked=""/);
  });
});

/** Every door into the dock, by what it calls. */
const ENTRIES: Record<string, (id: DockPanelId) => void> = {
  "strip in tabs mode (select)": (id) => openDockPanel(id),
  "strip toggle": (id) => toggleDockPanel(id),
  "header icon and overflow menu row": (id) => pressDockPanel(id),
  "work chip, agent row, v2 flip": (id) => {
    openRightPanel();
    openDockPanel(id);
  },
  "header images toggle and View > Images": () => toggleImagesPanel(),
  "a picture arrives": () => revealImagesPanel(),
  "the agent drives the browser": () => {
    __resetBrowserRevealForTests();
    revealBrowserPanel();
  },
  "entering a session": () => applyDockReturn(),
  "the header's dock toggle": () => toggleRightPanel(),
};

describe("tabs mode: exactly one panel while the dock is open (criterion 2)", () => {
  const starts: Record<string, () => void> = {
    "the default roster": () => {},
    "files after agents": () => {
      openRightPanel(true);
      openDockPanel("files");
    },
    "the terminal, dock hidden": () => {
      openDockPanel("terminal");
      if (__getState().rightPanelOpen) toggleRightPanel();
    },
  };
  for (const [startName, start] of Object.entries(starts)) {
    for (const [entryName, entry] of Object.entries(ENTRIES)) {
      it(`${entryName}, from ${startName}`, () => {
        setDockTabs(true, "agents");
        start();
        for (const id of DOCK_ORDER) {
          entry(id);
          const s = __getState();
          if (s.rightPanelOpen) expect(shownPanels(s), `${entryName} ${id}`).toHaveLength(1);
          // The store's arrangement agrees: one seat.
          expect(s.dockColumns.split("|").filter(Boolean).length, `${entryName} ${id}`).toBeLessThanOrEqual(
            1,
          );
        }
      });
    }
  }

  it("a door to a closed panel shows that panel, and it is the one open", () => {
    setDockTabs(true, "agents");
    openRightPanel(true);
    pressDockPanel("files");
    expect(shownPanels()).toEqual(["files"]);
    toggleImagesPanel();
    expect(shownPanels()).toEqual(["images"]);
    openDockPanel("context");
    expect(shownPanels()).toEqual(["context"]);
    expect(__getState().rightPanelOpen).toBe(true);
  });

  it("the header door of the shown panel hides the dock instead of emptying it", () => {
    setDockTabs(true, "agents");
    openRightPanel(true);
    pressDockPanel("agents");
    expect(__getState().rightPanelOpen).toBe(false);
    expect(shownPanels()).toEqual(["agents"]);
    pressDockPanel("agents");
    expect(__getState().rightPanelOpen).toBe(true);
    expect(shownPanels()).toEqual(["agents"]);
  });

  it("renders one card, the strip as a tablist, no fold and no close on the card", () => {
    setDockTabs(true, "agents");
    openDockPanel("files");
    const html = renderDock();
    expect([...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1])).toEqual(["files"]);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>Files/);
    expect(html).not.toContain("dock-panel-fold");
    expect(html).not.toContain("dock-panel-x");
    // The dock's own close stays.
    expect(html).toContain("rp-close");
  });
});

describe("side by side is unchanged (criterion 3)", () => {
  it("opening a panel adds it beside the others", () => {
    openDockPanel("files");
    openDockPanel("plan");
    expect(shownPanels()).toEqual(["agents", "plan", "files"]);
  });

  it("the strip stays a toolbar of pressed toggles and the cards keep fold and close", () => {
    const html = renderDock();
    expect(html).toContain('role="toolbar"');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("dock-panel-fold");
    expect(html).toContain("dock-panel-x");
  });
});

describe("switching keeps what it can (criterion 4)", () => {
  it("side by side to tabs keeps the panel that had focus", () => {
    openDockPanel("files");
    openDockPanel("plan");
    setDockTabs(true, "plan");
    expect(shownPanels()).toEqual(["plan"]);
    expect(__getState().dockTabs).toBe(true);
  });

  it("without focus, the first open panel in dock order stays", () => {
    openDockPanel("files");
    openDockPanel("plan");
    setDockTabs(true);
    expect(shownPanels()).toEqual(["agents"]);
  });

  it("the keep rule: focus if it is open and offered, else first open, else first offered", () => {
    const modes = {
      work: "closed",
      agents: "closed",
      plan: "open",
      context: "closed",
      files: "open",
      terminal: "closed",
      browser: "closed",
      images: "closed",
    } as const;
    const offered = DOCK_ORDER.filter((id) => id !== "work");
    expect(keepOnTabs(modes, offered, "files")).toBe("files");
    expect(keepOnTabs(modes, offered, "terminal")).toBe("plan");
    expect(keepOnTabs(modes, offered, null)).toBe("plan");
    const none = { ...modes, plan: "closed", files: "closed" } as const;
    expect(keepOnTabs(none, offered, null)).toBe("agents");
    // Work is kept only where it is offered.
    const onlyWork = { ...none, work: "open" } as const;
    expect(keepOnTabs(onlyWork, offered, null)).toBe("agents");
    expect(keepOnTabs(onlyWork, DOCK_ORDER, null)).toBe("work");
  });

  it("tabs to side by side keeps the one open panel and nothing else appears", () => {
    setDockTabs(true, "agents");
    openDockPanel("terminal");
    setDockTabs(false);
    expect(shownPanels()).toEqual(["terminal"]);
    expect(__getState().dockTabs).toBe(false);
    openDockPanel("files");
    expect(shownPanels()).toEqual(["files", "terminal"]);
  });
});

describe("a panel's own state survives a swap (criterion 5)", () => {
  // Measured 2026-09-29 before building (kanban evidence 444,
  // today-close-reopen.txt): closing the terminal panel and opening it again
  // gives a NEW shell (PID 54641, then 54720), because a closed panel is
  // unmounted. A swap is not a close: the swapped-out panel stays mounted and
  // hidden, which is the only way a terminal keeps its shell.
  it("a swapped-out panel is parked, mounted and hidden, and comes back when selected", () => {
    let parked: DockPanelId[] = [];
    parked = nextParked(parked, "terminal", "files");
    expect(parked).toEqual(["terminal"]);
    const seating = tabsSeating(parked, "files");
    expect(seating.mounted).toEqual(["files", "terminal"]);
    expect(seating.shown).toBe("files");
    parked = nextParked(parked, "files", "terminal");
    expect(parked).toEqual(["files"]);
    expect(tabsSeating(parked, "terminal")).toEqual({ mounted: ["files", "terminal"], shown: "terminal" });
  });

  it("no swap, no parking; a hidden dock (no shown panel) parks nothing new", () => {
    expect(nextParked([], "files", "files")).toEqual([]);
    expect(nextParked([], null, "files")).toEqual([]);
    expect(nextParked(["terminal"], "files", null)).toEqual(["terminal", "files"]);
  });

  it("the seating keeps dock order, so a swap never reorders the mounted cards", () => {
    expect(tabsSeating(["terminal", "agents"], "images").mounted).toEqual(["agents", "terminal", "images"]);
  });
});
