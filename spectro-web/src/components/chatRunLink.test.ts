// Card 586: the chat's start line of a run links to the run.
//
// A playbook's start line (playbook_progress) and a workflow's (run_step
// run_start) name their run. The chat draws "open the run" after such a line;
// the press brings the chat back from the wide view, shows that run in the
// panel and opens the dock's plan panel, also after the run's one automatic
// reveal was used up and the operator closed the panel.
//
// The Chat runs under HookHost (testkit/chatHost.ts); the layout store is the
// real one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import {
  __getState,
  __resetForTests,
  setDockTabs,
  setRunWide,
  toggleDockPanel,
  toggleRightPanel,
} from "../state/layout";
import { __resetRunPickForTests, currentRunPick, pickedIndex } from "../state/runPick";
import { __resetRunRevealForTests, runRevealPushLive } from "../state/runReveal";
import { hostChat, liveChatView, sessionHarness, stubBrowser, treeOf, type El } from "../testkit/chatHost";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const runStart = (runId: string, runKind: string, name: string): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId,
    runKind,
    phase: "run_start",
    name,
    nodes: [],
    ts: 1,
  }) as unknown as RunEvent;
const runEnd = (runId: string, runKind: string): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId,
    runKind,
    phase: "run_end",
    stopReason: "done",
    ts: 2,
  }) as unknown as RunEvent;
const progressStart = (runId: string): RunEvent =>
  ({
    type: "playbook_progress",
    agentId: "playbook",
    runId,
    phase: "start",
    playbook: "spectro",
    task: "add a CSV export",
    ts: 1,
  }) as unknown as RunEvent;

const links = (tree: El[]): El[] =>
  tree.filter((el) => el.type === "button" && el.props.className === "link info-line-link chat-run-open");

beforeEach(() => {
  __resetForTests();
  setDockTabs(false);
  __resetRunRevealForTests();
  __resetRunPickForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  stubBrowser();
});
afterEach(() => vi.unstubAllGlobals());

describe("the start line of a run links to the run (card 586)", () => {
  it("a playbook's start line and a workflow's carry the link, the other lines none", () => {
    const h = sessionHarness();
    h.sockets[0].emit([
      progressStart(A),
      runStart(A, "playbook", "spectro"),
      runEnd(A, "playbook"),
      runStart(B, "workflow", "fanout-review"),
      runEnd(B, "workflow"),
    ]);
    const chat = hostChat(() => liveChatView(h.set, []));
    const tree = treeOf(chat);
    const found = links(tree);
    expect(found).toHaveLength(2);
    expect(found.map((el) => el.props.children)).toEqual([
      t("en", "chat.run.open"),
      t("en", "chat.run.open"),
    ]);
    expect(
      tree.filter((el) => String(el.props.className).startsWith("info-line")).length,
      "premise: three info lines, the workflow's end without a link",
    ).toBe(3);
    chat.unmount();
  });

  it("a press brings the chat back, shows that run and opens the plan panel, after the reveal was used and the panel closed", () => {
    const h = sessionHarness();
    const events = [
      progressStart(A),
      runStart(A, "playbook", "spectro"),
      runEnd(A, "playbook"),
      runStart(B, "workflow", "fanout-review"),
    ];
    h.sockets[0].emit(events);
    runRevealPushLive(events);
    toggleDockPanel("plan");
    toggleRightPanel();
    setRunWide(true);
    expect(__getState().rightPanelOpen, "premise: the operator closed the dock").toBe(false);
    expect(__getState().dockPlan, "premise: and the plan panel").toBe("closed");

    const chat = hostChat(() => liveChatView(h.set, []));
    (links(treeOf(chat))[0].props.onClick as () => void)();

    expect(__getState().runWide).toBe(false);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockPlan).toBe("open");
    const runs = h.set.view().state.runs;
    expect(
      runs.map((r) => r.runId),
      "premise: two runs, the newest last",
    ).toEqual([A, B]);
    expect(pickedIndex(currentRunPick(), runs), "the run of the line, not the newest").toBe(0);
    chat.unmount();
  });
});
