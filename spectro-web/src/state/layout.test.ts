import { beforeEach, describe, expect, it } from "vitest";
import {
  __getState,
  __resetForTests,
  clampW,
  DEFAULT_LAYOUT,
  hydrateLayout,
  openDockPanel,
  openRightPanel,
  setActiveRightTab,
  setChatW,
  setDockWeights,
  setRightPanelW,
  setSidebarW,
  setTraceW,
  toggleChat,
  toggleDockCollapse,
  toggleDockPanel,
  toggleRightPanel,
  toggleTrace,
} from "./layout";

beforeEach(() => __resetForTests());

describe("layout store", () => {
  it("starts from the defaults", () => {
    expect(__getState()).toEqual(DEFAULT_LAYOUT);
  });

  it("clampW keeps a value inside [min, max] and rounds", () => {
    expect(clampW(50, 200, 1200)).toBe(200);
    expect(clampW(5000, 200, 1200)).toBe(1200);
    expect(clampW(340.6, 200, 1200)).toBe(341);
  });

  it("setters clamp the width to sane bounds", () => {
    setSidebarW(10);
    expect(__getState().sidebarW).toBe(180);
    setChatW(99999);
    expect(__getState().chatW).toBe(1200);
    setTraceW(260);
    expect(__getState().traceW).toBe(260);
  });

  it("the Lab panes start collapsed and toggles flip them", () => {
    expect(__getState().chatOpen).toBe(false);
    expect(__getState().traceOpen).toBe(false);
    toggleChat();
    expect(__getState().chatOpen).toBe(true);
    toggleTrace();
    expect(__getState().traceOpen).toBe(true);
    toggleChat();
    expect(__getState().chatOpen).toBe(false);
  });

  it("the right panel starts closed and toggles/resizes/switches tab", () => {
    expect(__getState().rightPanelOpen).toBe(false);
    expect(__getState().activeRightTab).toBe("agents");
    toggleRightPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    setRightPanelW(10); // clamps up to the min
    expect(__getState().rightPanelW).toBe(260);
    setRightPanelW(99999); // clamps down to the max
    expect(__getState().rightPanelW).toBe(720);
    setActiveRightTab("context");
    expect(__getState().activeRightTab).toBe("context");
  });

  it("a no-op set does not change the state object identity", () => {
    setSidebarW(240); // already the default → clamped 240, no change
    const before = __getState();
    setSidebarW(240);
    expect(__getState()).toBe(before);
  });

  it("openRightPanel opens once and stays idempotent", () => {
    // The workspace announcement calls this on every session — an already
    // open panel must not churn state (or re-render subscribers).
    if (__getState().rightPanelOpen) toggleRightPanel();
    openRightPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    const before = __getState();
    openRightPanel();
    expect(__getState()).toBe(before);
  });
});

describe("the dock panels (card 219, first cut)", () => {
  it("starts with the roster open and everything else closed — today's face", () => {
    expect(__getState().dockAgents).toBe("open");
    for (const key of [
      "dockWork",
      "dockPlan",
      "dockContext",
      "dockFiles",
      "dockTerminal",
      "dockBrowser",
    ] as const) {
      expect(__getState()[key], key).toBe("closed");
    }
    expect(__getState().dockWeights).toBe("");
  });

  it("toggles a panel between closed and open, never through collapsed", () => {
    toggleDockPanel("files");
    expect(__getState().dockFiles).toBe("open");
    toggleDockPanel("files");
    expect(__getState().dockFiles).toBe("closed");
    // A collapsed panel closes on toggle — the strip button is show/hide.
    toggleDockPanel("files");
    toggleDockCollapse("files");
    expect(__getState().dockFiles).toBe("collapsed");
    toggleDockPanel("files");
    expect(__getState().dockFiles).toBe("closed");
  });

  it("collapses only an open panel and folds it back", () => {
    toggleDockCollapse("agents");
    expect(__getState().dockAgents).toBe("collapsed");
    toggleDockCollapse("agents");
    expect(__getState().dockAgents).toBe("open");
    // Collapsing a closed panel opens nothing.
    toggleDockCollapse("browser");
    expect(__getState().dockBrowser).toBe("closed");
  });

  it("openDockPanel opens the dock's panel idempotently and expands a collapsed one", () => {
    openDockPanel("context");
    expect(__getState().dockContext).toBe("open");
    const before = __getState();
    openDockPanel("context");
    expect(__getState()).toBe(before);
    toggleDockCollapse("context");
    openDockPanel("context");
    expect(__getState().dockContext).toBe("open");
  });

  it("stores the weights string and stays identity-stable on a no-op", () => {
    setDockWeights("files:2,terminal:0.5");
    expect(__getState().dockWeights).toBe("files:2,terminal:0.5");
    const before = __getState();
    setDockWeights("files:2,terminal:0.5");
    // The hand-written equality check in set() must cover the new field, or
    // this write would store and never notify — the layout.ts:76-93 trap.
    expect(__getState()).toBe(before);
  });
});

describe("hydrating a stored blob (card 219 migration)", () => {
  it("loads a pre-card blob through the merge: defaults fill the dock fields", () => {
    const state = hydrateLayout({ sidebarW: 300 }, null);
    expect(state.sidebarW).toBe(300);
    expect(state.dockAgents).toBe("open");
    expect(state.dockFiles).toBe("closed");
    expect(state.dockWeights).toBe("");
  });

  it("carries the old active tab into the dock: the reader lands where they left", () => {
    const state = hydrateLayout({ rightPanelOpen: true, activeRightTab: "files" }, null);
    expect(state.dockFiles).toBe("open");
    // Only the tab that WAS showing is open — the migration reproduces the
    // one-surface face the reader had, not a wall of every panel at once.
    expect(state.dockAgents).toBe("closed");
  });

  it("reopens the terminal panel for a reader who had the terminal open", () => {
    const state = hydrateLayout({ activeRightTab: "agents" }, "1");
    expect(state.dockTerminal).toBe("open");
    expect(hydrateLayout({}, "0").dockTerminal).toBe("closed");
  });

  it("never migrates over stored dock fields, and normalizes junk in them", () => {
    const state = hydrateLayout(
      { activeRightTab: "files", dockAgents: "collapsed", dockFiles: "banana" },
      "1",
    );
    // Dock fields exist, so the blob is post-card: activeRightTab and the old
    // terminal key are history and must not reshape what the reader stored.
    expect(state.dockAgents).toBe("collapsed");
    expect(state.dockFiles).toBe("closed"); // junk reads as closed
    expect(state.dockTerminal).toBe("closed");
  });

  it("survives garbage wholesale", () => {
    expect(hydrateLayout(null, null)).toEqual(DEFAULT_LAYOUT);
    expect(hydrateLayout("nonsense", null)).toEqual(DEFAULT_LAYOUT);
  });
});
