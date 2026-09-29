// Card 443, criterion 3: old settings carry over.
//
// Measured on main (2420933c) before the card: the old area's open state was
// `useState(false)` in App.tsx and was never stored. A 0.14.1 blob therefore
// carries no images-open fact at all, only the area's width `imagesW`, and
// every launch of 0.14.1 showed the images closed. The blob below has the
// field set of DEFAULT_LAYOUT at 2420933c, with the values a reader who used
// the dock and dragged the gallery wider would have left behind.

import { beforeEach, describe, expect, it } from "vitest";
import { __resetForTests, hydrateLayout, readLayoutBlob, openDockPanel, DEFAULT_LAYOUT } from "./layout";

beforeEach(() => __resetForTests());

const STORED_BY_0_14_1 = {
  sidebarW: 240,
  chatW: 340,
  traceW: 300,
  ctxW: 320,
  chatOpen: false,
  traceOpen: false,
  ctxOpen: false,
  rightPanelOpen: true,
  rightPanelW: 620,
  imagesW: 420,
  activeRightTab: "agents",
  dockWork: "closed",
  dockAgents: "open",
  dockPlan: "closed",
  dockContext: "closed",
  dockFiles: "open",
  dockTerminal: "closed",
  dockBrowser: "closed",
  dockWeights: "",
  dockColumns: "agents~1~0.5|files~1~0.5",
  dockTermTabs: "",
  dockReturn: true,
};

describe("a layout stored by 0.14.1 (card 443, criterion 3)", () => {
  it("carries no images-open fact: the blob has no images mode to migrate", () => {
    expect(Object.keys(STORED_BY_0_14_1).filter((k) => /image/i.test(k))).toEqual(["imagesW"]);
  });

  it("hydrates with the images panel closed, which is what 0.14.1 showed on every launch", () => {
    const { state, recovered } = readLayoutBlob(JSON.stringify(STORED_BY_0_14_1), null);
    expect(recovered).toBe(false);
    expect(state.dockImages).toBe("closed");
    // Everything else the reader had is kept.
    expect(state.dockAgents).toBe("open");
    expect(state.dockFiles).toBe("open");
    expect(state.dockColumns).toBe("agents~1~0.5|files~1~0.5");
    expect(state.dockReturn).toBe(true);
    expect(state.imagesW).toBe(420);
  });

  it("a pre-0.9 blob (no dock fields) lands with the images closed as well", () => {
    const state = hydrateLayout({ rightPanelOpen: true, activeRightTab: "files" }, null);
    expect(state.dockImages).toBe("closed");
    expect(state.dockFiles).toBe("open");
  });

  it("junk in a stored images mode reads as closed", () => {
    const state = hydrateLayout({ ...STORED_BY_0_14_1, dockImages: "banana" }, null);
    expect(state.dockImages).toBe("closed");
    expect(state.dockFiles).toBe("open");
  });

  it("from now on the open images panel is stored and comes back with the dock", () => {
    openDockPanel("images");
    const stored = JSON.stringify({
      ...DEFAULT_LAYOUT,
      dockImages: "open",
      dockColumns: "agents~1~0.5|images~1~0.5",
    });
    const { state } = readLayoutBlob(stored, null);
    expect(state.dockImages).toBe("open");
    expect(state.dockColumns).toContain("images");
  });
});
