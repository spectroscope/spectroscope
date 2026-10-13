// Card 586: reopening a stored session does not open the run panel for its old runs.
//
// The question Task 7 left open: does a stored session's history reach the
// app's batch funnel, where runRevealPushLive reads run_start lines? It does
// not. The server sends no stored event over the socket on a resume or a wake
// (SessionConnection.start and onWakeSession announce provider, mode, playbook
// and workspace frames only); the history comes over REST and enters the
// record as its initial state and events, which SessionSet never hands to
// onBatch. These tests pin that: the funnel sees only frames the socket
// brings, so only a run that starts live reveals the panel.
//
// The harness wires onBatch the way App's batchSink does for the record in
// view: runRevealPushLive(batch) when info.inView.

import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { SessionSet } from "./sessionSet";
import { initialState } from "./reducer";
import { __getState, __resetForTests, setDockTabs } from "./layout";
import { __resetRunRevealForTests, runRevealPushLive } from "./runReveal";

interface FakeSocket {
  emit(events: RunEvent[]): void;
  status(status: ConnectionStatus): void;
}

function harness() {
  const sockets: FakeSocket[] = [];
  const batches: RunEvent[][] = [];
  const connect = (options: ConnectOptions): Connection => {
    let open = false;
    sockets.push({
      emit: (events) => options.onEvents(events),
      status: (status) => {
        open = status === "open";
        options.onStatus?.(status);
      },
    });
    return { send: () => open, reconnectNow: () => {}, close: () => {} };
  };
  const set = new SessionSet({
    connect,
    mode: () => "learn",
    traceWanted: () => true,
    onBatch: (_key, batch, info) => {
      batches.push(batch);
      if (info.inView) runRevealPushLive(batch);
    },
  });
  return { set, sockets, batches };
}

const ID = "20261013-090000-r586";
const runStart = (runId: string, ts: number): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId,
    runKind: "playbook",
    phase: "run_start",
    name: "spectro",
    nodes: [],
    ts,
  }) as unknown as RunEvent;
const runEnd = (runId: string, ts: number): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId,
    runKind: "playbook",
    phase: "run_end",
    stopReason: "done",
    ts,
  }) as unknown as RunEvent;
/** The frames a resumed socket announces before anything runs. */
const connectFrames = (): RunEvent[] =>
  [
    { type: "provider_info", provider: "ollama", model: "qwen2.5:7b" },
    { type: "workspace_info", resolved: true, mode: "recorded", exists: true, sessionId: ID, path: "/w" },
  ] as unknown as RunEvent[];
/** A stored session with two ended runs, as the history REST call returns it. */
const history = (): RunEvent[] => [
  runStart("old1", 1),
  runEnd("old1", 2),
  runStart("old2", 3),
  runEnd("old2", 4),
];

const isRunStart = (e: RunEvent): boolean =>
  (e as { type?: string; phase?: string }).type === "run_step" &&
  (e as { phase?: string }).phase === "run_start";

describe("a stored session's old runs do not open the run panel (card 586)", () => {
  beforeEach(() => {
    __resetForTests();
    setDockTabs(false);
    __resetRunRevealForTests();
  });

  it("a resumed session's history never reaches the batch funnel, and the panel stays closed", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    h.set.open({ resumeId: ID, state: initialState, events: history(), replace: true });
    h.sockets[1].status("open");
    h.sockets[1].emit(connectFrames());

    expect(h.batches.flat().some(isRunStart)).toBe(false);
    expect(__getState().dockPlan).toBe("closed");
    expect(__getState().rightPanelOpen).toBe(false);
  });

  it("a woken session adopts its history without the funnel, and the panel stays closed", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    const key = h.set.open({ wake: ID });
    h.sockets[1].status("open");
    h.sockets[1].emit(connectFrames());
    h.set.continueWoken(key, { state: initialState, events: history(), firstMessage: { text: "go on" } });

    expect(h.set.viewKey()).toBe(key);
    expect(h.batches.flat().some(isRunStart)).toBe(false);
    expect(__getState().dockPlan).toBe("closed");
  });

  it("a run that starts live after the session was loaded opens the panel", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    h.set.open({ resumeId: ID, state: initialState, events: history(), replace: true });
    h.sockets[1].status("open");
    h.sockets[1].emit(connectFrames());
    expect(__getState().dockPlan).toBe("closed");

    h.sockets[1].emit([runStart("new1", 10)]);
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockPlan).toBe("open");
  });
});
