// Card 517: the dock opens as tabs on a fresh installation.
//
// The owner, 2026-10-11: the Tabs checkbox in the dock is on by default when
// an installation is new. "New" means an origin with no layout blob stored.
// A stored blob decides for itself, and a blob written before card 444 has no
// dockTabs key and stays side by side, because its owner already has a layout.
//
// The layout store reads localStorage once, at module load. These tests stub
// localStorage BEFORE a dynamic import, so they run the same read a browser
// runs on its first load. Own file, because it resets the module registry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DockPanelId, LayoutState } from "../state/layout";

const KEY = "spectroscope:layout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A localStorage holding `entries` and nothing else. */
function stubStorage(entries: Record<string, string>): void {
  const store = new Map(Object.entries(entries));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

/** Loads the layout store and its neighbours fresh, against the stubbed storage. */
async function load() {
  vi.resetModules();
  const layout = await import("../state/layout");
  const model = await import("./dockModel");
  const images = await import("../state/imagesPanel");
  const browser = await import("../state/browserReveal");
  const header = await import("./headerPanelControls");
  const panel = await import("../components/RightPanel");
  return { layout, model, images, browser, header, panel };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** The panels whose mode is not "closed", in dock order. */
function shownPanels(m: Loaded, s: LayoutState = m.layout.__getState()): DockPanelId[] {
  return m.model.DOCK_ORDER.filter(
    (id) => s[`dock${id[0].toUpperCase()}${id.slice(1)}` as keyof LayoutState] !== "closed",
  );
}

/** The dock's Tabs checkbox as the first render draws it. */
function tabsSwitch(m: Loaded): string {
  const html = renderToStaticMarkup(
    <m.panel.RightPanel
      agents={[]}
      plan={null}
      onClose={() => {}}
      thinking
      workspace={null}
      sessionId={null}
    />,
  );
  return html.match(/<label class="dock-tabs-switch"[^>]*>[\s\S]*?<\/label>/)?.[0] ?? "";
}

/** A blob the way 0.14.0 wrote it: dock fields, no dockTabs key (before card 444). */
function blobBefore444(): Record<string, unknown> {
  return {
    sidebarW: 260,
    chatW: 340,
    traceW: 300,
    ctxW: 320,
    chatOpen: false,
    traceOpen: false,
    ctxOpen: false,
    rightPanelOpen: false,
    rightPanelW: 620,
    imagesW: 300,
    activeRightTab: "agents",
    dockWork: "closed",
    dockAgents: "open",
    dockPlan: "closed",
    dockContext: "closed",
    dockFiles: "open",
    dockTerminal: "closed",
    dockBrowser: "closed",
    dockImages: "closed",
    dockWeights: "",
    dockColumns: "agents~1~0.5|files~1~0.5",
    dockTermTabs: "",
    dockReturn: false,
  };
}

describe("a new installation starts with the dock as tabs (criterion 1)", () => {
  it("an origin with no layout blob starts in tabs mode with the checkbox checked", async () => {
    stubStorage({});
    const m = await load();
    expect(m.layout.DEFAULT_LAYOUT.dockTabs).toBe(true);
    expect(m.layout.__getState().dockTabs).toBe(true);
    const sw = tabsSwitch(m);
    expect(sw).toContain('type="checkbox"');
    expect(sw).toContain('checked=""');
  });
});

describe("a stored blob decides for itself (criterion 2)", () => {
  it("a blob with dockTabs true stays on", async () => {
    stubStorage({ [KEY]: JSON.stringify({ ...blobBefore444(), dockTabs: true }) });
    const m = await load();
    expect(m.layout.__getState().dockTabs).toBe(true);
    expect(tabsSwitch(m)).toContain('checked=""');
  });

  it("a blob with dockTabs false stays off", async () => {
    stubStorage({ [KEY]: JSON.stringify({ ...blobBefore444(), dockTabs: false }) });
    const m = await load();
    expect(m.layout.__getState().dockTabs).toBe(false);
    expect(shownPanels(m)).toEqual(["agents", "files"]);
    const sw = tabsSwitch(m);
    expect(sw).toContain('type="checkbox"');
    expect(sw).not.toContain("checked");
  });

  it("a blob without the key (written before card 444) reads as off and keeps its panels", async () => {
    const blob = blobBefore444();
    expect("dockTabs" in blob).toBe(false);
    stubStorage({ [KEY]: JSON.stringify(blob) });
    const m = await load();
    expect(m.layout.__getState().dockTabs).toBe(false);
    expect(m.layout.__getState().sidebarW).toBe(260);
    expect(shownPanels(m)).toEqual(["agents", "files"]);
    const sw = tabsSwitch(m);
    expect(sw).toContain('type="checkbox"');
    expect(sw).not.toContain("checked");
  });
});

describe("one panel from the first render (criterion 3)", () => {
  // Since card 402 a sent message opens no panel. What still opens the dock
  // without a click is the v2 flip (work), a picture that arrives (images)
  // and the agent driving the browser (browser); the header's toggle and its
  // panel icons are the clicks. Each starts from an origin with no blob.
  const doors: Record<string, (m: Loaded, id: DockPanelId) => void> = {
    "the header's dock toggle": (m) => m.layout.toggleRightPanel(),
    "a header panel icon": (m, id) => m.header.pressDockPanel(id),
    "the v2 flip and the work chip": (m, id) => {
      m.layout.openRightPanel();
      m.layout.openDockPanel(id);
    },
    "a picture arrives": (m) => m.images.revealImagesPanel(),
    "the agent drives the browser": (m) => {
      m.browser.__resetBrowserRevealForTests();
      m.browser.revealBrowserPanel();
    },
  };

  it("with no blob and the dock open, exactly one panel is open", async () => {
    stubStorage({});
    const m = await load();
    expect(shownPanels(m)).toEqual(["agents"]);
    m.layout.toggleRightPanel();
    expect(m.layout.__getState().rightPanelOpen).toBe(true);
    expect(shownPanels(m)).toHaveLength(1);
  });

  for (const [name, door] of Object.entries(doors)) {
    it(`${name} opens exactly one panel on a fresh installation`, async () => {
      stubStorage({});
      const m = await load();
      for (const id of m.model.DOCK_ORDER) {
        door(m, id);
        const s = m.layout.__getState();
        if (s.rightPanelOpen) expect(shownPanels(m, s), `${name} ${id}`).toHaveLength(1);
        expect(shownPanels(m, s).length, `${name} ${id}`).toBeLessThanOrEqual(1);
        expect(s.dockColumns.split("|").filter(Boolean).length, `${name} ${id}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it("Files and then Work leaves only Work open (the scenario)", async () => {
    stubStorage({});
    const m = await load();
    m.layout.openRightPanel();
    expect(tabsSwitch(m)).toContain('checked=""');
    m.header.pressDockPanel("files");
    expect(shownPanels(m)).toEqual(["files"]);
    m.header.pressDockPanel("work");
    expect(shownPanels(m)).toEqual(["work"]);
    expect(m.layout.__getState().rightPanelOpen).toBe(true);
  });
});
