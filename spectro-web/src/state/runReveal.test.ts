// Card 586: a run that starts opens the run panel beside the chat, once per run.
//
// The reveal reads the session's own run_step run_start on the live socket and
// opens the dock with its plan panel, the panel the run lives in. A second
// batch of the same run asks nothing again: an operator who closed the panel
// during the run has answered. A new run may open it again.

import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { __resetRunRevealForTests, revealRunPanel, runRevealPushLive } from "./runReveal";
import { __getState, __resetForTests, setDockTabs, toggleDockPanel, toggleRightPanel } from "./layout";

const runStart = (runId: string): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId,
    runKind: "playbook",
    phase: "run_start",
    ts: 1,
  }) as unknown as RunEvent;
const stepStart = (runId: string): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId,
    runKind: "playbook",
    phase: "step_start",
    node: "a",
    ts: 2,
  }) as unknown as RunEvent;
const noise = { type: "text_delta", agentId: "main", text: "x", ts: 3 } as unknown as RunEvent;

describe("a run that starts opens the run panel (card 586)", () => {
  beforeEach(() => {
    __resetForTests();
    setDockTabs(false);
    __resetRunRevealForTests();
  });

  it("opens the dock and the plan panel on a run_start", () => {
    expect(__getState().rightPanelOpen).toBe(false);
    expect(__getState().dockPlan).toBe("closed");
    runRevealPushLive([noise, runStart("r1")]);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockPlan).toBe("open");
  });

  it("does not open again for a later batch of the same run", () => {
    runRevealPushLive([runStart("r1")]);
    toggleDockPanel("plan");
    toggleRightPanel();
    expect(__getState().dockPlan).toBe("closed");
    expect(__getState().rightPanelOpen).toBe(false);
    runRevealPushLive([runStart("r1"), stepStart("r1")]);
    expect(__getState().dockPlan).toBe("closed");
    expect(__getState().rightPanelOpen).toBe(false);
  });

  it("opens again for a new run", () => {
    runRevealPushLive([runStart("r1")]);
    toggleDockPanel("plan");
    runRevealPushLive([runStart("r2")]);
    expect(__getState().dockPlan).toBe("open");
  });

  it("moves nothing for a batch without a run_start", () => {
    runRevealPushLive([noise, stepStart("r1")]);
    expect(__getState().rightPanelOpen).toBe(false);
    expect(__getState().dockPlan).toBe("closed");
  });

  it("reveals by run id when called directly, once", () => {
    revealRunPanel("r9");
    expect(__getState().dockPlan).toBe("open");
    toggleDockPanel("plan");
    revealRunPanel("r9");
    expect(__getState().dockPlan).toBe("closed");
  });
});

describe("the run reveal in tabs mode, the default", () => {
  beforeEach(() => {
    __resetForTests();
    __resetRunRevealForTests();
  });

  it("shows the plan panel alone", () => {
    expect(__getState().dockTabs).toBe(true);
    runRevealPushLive([runStart("r1")]);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockPlan).toBe("open");
    expect(__getState().dockBrowser).toBe("closed");
  });
});

// Card 586, task 10: the chat's "open the run" asks for the panel by hand, so
// it opens also after the run's one automatic reveal.
describe("a press on a run's link opens the run panel again (card 586)", () => {
  beforeEach(() => {
    __resetForTests();
    setDockTabs(false);
    __resetRunRevealForTests();
  });

  it("opens with force after the reveal was used and the panel closed", () => {
    runRevealPushLive([runStart("r1")]);
    toggleDockPanel("plan");
    toggleRightPanel();
    revealRunPanel("r1");
    expect(__getState().rightPanelOpen, "premise: the automatic reveal stays answered").toBe(false);
    revealRunPanel("r1", true);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockPlan).toBe("open");
  });

  it("a forced open does not use up the automatic reveal of a run that has not started", () => {
    revealRunPanel("r2", true);
    toggleDockPanel("plan");
    toggleRightPanel();
    runRevealPushLive([runStart("r2")]);
    expect(__getState().rightPanelOpen).toBe(true);
  });
});
