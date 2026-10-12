// Card 241: the agent's browser cue reveals the DOCK PANEL — and only that.
//
// The owner's field report, measured on 2026-08-15: "öffne einen browser mit
// www.test.de" flipped the session TAB to a whole-surface browser and the UI
// broke to the point of a restart. The ruling this file pins: an agent browser
// action opens the dock's browser panel (opens if closed, raises if folded),
// never a tab — and at most ONCE per run, because an operator who closed the
// panel mid-run has answered the question and the app must not re-ask it
// (card 222's lesson: the app is not the operator).

import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { browserRevealPushLive, __resetBrowserRevealForTests } from "./browserReveal";
import { __getState, __resetForTests, setDockTabs, toggleDockCollapse, toggleDockPanel } from "./layout";

const action = { type: "browser_action" } as unknown as RunEvent;
const start = { type: "run_start" } as unknown as RunEvent;
const noise = { type: "token" } as unknown as RunEvent;

describe("the agent's browser cue reveals the dock panel (card 241)", () => {
  beforeEach(() => {
    __resetForTests();
    // Card 517: a fresh store starts in tabs mode; these cases are side by side.
    setDockTabs(false);
    __resetBrowserRevealForTests();
  });

  it("a browser_action opens the right panel and the browser panel", () => {
    expect(__getState().dockBrowser).toBe("closed");
    browserRevealPushLive([noise, action]);
    expect(__getState().dockBrowser).toBe("open");
    expect(__getState().rightPanelOpen).toBe(true);
  });

  it("raises a folded panel instead of leaving it collapsed", () => {
    browserRevealPushLive([action]);
    toggleDockCollapse("browser"); // folded to its header between runs
    expect(__getState().dockBrowser).toBe("collapsed");

    browserRevealPushLive([start, action]); // the next run's reveal
    expect(__getState().dockBrowser).toBe("open");
  });

  it("never reopens after the operator closed it in the same run", () => {
    browserRevealPushLive([start, action]);
    expect(__getState().dockBrowser).toBe("open");
    toggleDockPanel("browser"); // the operator's answer
    expect(__getState().dockBrowser).toBe("closed");

    browserRevealPushLive([action, action]);
    expect(__getState().dockBrowser).toBe("closed");
  });

  it("a new run may reveal again", () => {
    browserRevealPushLive([start, action]);
    toggleDockPanel("browser");
    browserRevealPushLive([start, action]);
    expect(__getState().dockBrowser).toBe("open");
  });

  it("a batch without a browser_action moves nothing", () => {
    browserRevealPushLive([noise, start, noise]);
    expect(__getState().dockBrowser).toBe("closed");
    expect(__getState().rightPanelOpen).toBe(false);
  });
});

describe("the browser cue in tabs mode, the default since card 517", () => {
  beforeEach(() => {
    __resetForTests();
    __resetBrowserRevealForTests();
  });

  it("opens the dock on the browser alone, and an operator who hid it is not asked again", () => {
    expect(__getState().dockTabs).toBe(true);
    browserRevealPushLive([start, action]);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockBrowser).toBe("open");
    expect(__getState().dockAgents).toBe("closed");
    toggleDockPanel("browser"); // in tabs mode the shown panel's door hides the dock
    expect(__getState().rightPanelOpen).toBe(false);

    browserRevealPushLive([action, action]);
    expect(__getState().rightPanelOpen).toBe(false);
  });
});
