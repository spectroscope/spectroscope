// Card 382, criteria 3, 4 and 5: what the gate window is allowed to read, and
// what an answer is allowed to reach.
//
// The defect this pins is not cosmetic. The Lab's window read the stepper's
// FOLDED prefix, so scrubbing a live run back between a request and its
// decision resurrected an answered gate, while a gate that arrived one moment
// ago sat in the stepper queue and was drawn nowhere. The queue built here
// reads the live fold instead, which is the state App holds and never re-folds.
//
// The answer path is pinned in the same file on purpose: a surface that can
// show a stale call and a sender that posts any call id are the same bug seen
// from two ends, and the server answers an unknown id with silence.

import { describe, expect, it, beforeEach } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "./reducer";
import type { PendingPermission } from "./reducer";
import { __getState, __resetForTests, backToLive, pushLive, seek } from "./stepper";
import { gateQueue, gateEntryFor, gateSurface, routeGateAnswer } from "./gateQueue";

const td = (i: number): RunEvent => ({ type: "text_delta", agentId: "main", text: `t${i}`, ts: i });

/** The seven-event run the card measured: the request sits at index 4, its
 *  decision at index 5, so `seek(5)` applies the request and not the answer. */
const events: RunEvent[] = [
  td(1),
  td(2),
  { type: "tool_call", agentId: "main", callId: "c1", name: "Bash", input: { command: "ls" }, ts: 3 },
  td(4),
  {
    type: "permission_request",
    agentId: "main",
    callId: "c1",
    name: "Bash",
    input: { command: "ls" },
    ts: 5,
  },
  { type: "permission_decision", callId: "c1", allowed: true, ts: 6 },
  td(7),
];

const live2: RunEvent = {
  type: "permission_request",
  agentId: "main",
  callId: "LIVE-2",
  name: "Bash",
  input: { command: "rm -rf build" },
  ts: 8,
};

const fleetGate: PendingPermission = {
  callId: "F-1",
  agentId: "node-a",
  name: "Write",
  input: { path: "/tmp/x" },
};

beforeEach(() => {
  __resetForTests();
});

describe("the gate queue reads live state, never a stepped prefix", () => {
  it("draws nothing for a call the live run has already decided", () => {
    // The trap, measured first so the test says what it is guarding against:
    // scrubbed to the step where the request is applied and the decision is
    // not, the stepper's fold hands back the answered call.
    backToLive(events);
    seek(7);
    seek(0);
    seek(5);
    expect(__getState().applied.length).toBe(5);
    expect(__getState().ui.pendingPermissions.map((p) => p.callId)).toEqual(["c1"]);

    // The live fold — what App holds — knows the call was answered.
    const liveState = reduceAll(initialState, events);
    expect(gateQueue(liveState.pendingPermissions, [])).toEqual([]);
    // And the Lab, where the scrubbing happens, shows nothing for it.
    expect(gateSurface(gateQueue(liveState.pendingPermissions, []), true)).toBe("none");
  });

  it("names the call that is actually parked when a new request arrives", () => {
    backToLive(events);
    seek(7);
    seek(0);
    seek(5);
    pushLive([live2]);

    // The stepper is unmoved, by design: pushLive appends to the queue.
    expect(__getState().applied.length).toBe(5);
    expect(__getState().ui.pendingPermissions.map((p) => p.callId)).toEqual(["c1"]);

    const liveState = reduceAll(initialState, [...events, live2]);
    const queue = gateQueue(liveState.pendingPermissions, []);
    expect(queue.map((e) => e.permission.callId)).toEqual(["LIVE-2"]);
    expect(queue[0].source).toBe("session");
  });

  it("puts the session queue first and the fleet queue behind it, in one counter", () => {
    const parked = reduceAll(initialState, [...events, live2]).pendingPermissions;
    const queue = gateQueue(parked, [fleetGate]);
    expect(queue.map((e) => e.permission.callId)).toEqual(["LIVE-2", "F-1"]);
    expect(queue.map((e) => e.source)).toEqual(["session", "fleet"]);
  });

  it("carries a fleet gate on its own when no session gate is parked", () => {
    const queue = gateQueue([], [fleetGate]);
    expect(queue).toHaveLength(1);
    expect(queue[0].source).toBe("fleet");
  });
});

describe("an answer reaches only a call that is still parked", () => {
  it("refuses a call id the live queue does not hold", () => {
    const parked = reduceAll(initialState, [...events, live2]).pendingPermissions;
    const queue = gateQueue(parked, [fleetGate]);
    // c1 was requested and decided in the same run. The server drops an answer
    // for it without a word, so the browser has to stop before sending one.
    expect(gateEntryFor(queue, "c1")).toBeNull();
    expect(routeGateAnswer(queue, "c1")).toBeNull();
  });

  it("routes a live answer to the queue the call came from", () => {
    const parked = reduceAll(initialState, [...events, live2]).pendingPermissions;
    const queue = gateQueue(parked, [fleetGate]);
    expect(routeGateAnswer(queue, "LIVE-2")).toBe("session");
    expect(routeGateAnswer(queue, "F-1")).toBe("fleet");
  });

  it("refuses everything while nothing is parked", () => {
    expect(routeGateAnswer(gateQueue([], []), "LIVE-2")).toBeNull();
  });
});

describe("the Lab never draws the window (fix round 2026-09-24)", () => {
  // The owner on the Lab's window: "Der muss weg im Lab, weil im Lab macht der
  // überhaupt keinen Sinn." The first build removed only the stale re-ask and
  // still drew the window over the Lab for a live gate. Now the Lab shows a
  // notice at most, and the gate is answered in the chat.
  const parked = () => gateQueue(reduceAll(initialState, [...events, live2]).pendingPermissions, []);

  it("gives a live gate a notice, not a window, while the Lab is on screen", () => {
    expect(parked()).toHaveLength(1);
    expect(gateSurface(parked(), true)).toBe("notice");
  });

  it("draws the window for the same gate on every other view", () => {
    expect(gateSurface(parked(), false)).toBe("window");
  });

  it("gives a fleet node's gate the same rule", () => {
    expect(gateSurface(gateQueue([], [fleetGate]), true)).toBe("notice");
    expect(gateSurface(gateQueue([], [fleetGate]), false)).toBe("window");
  });

  it("shows nothing anywhere while nothing is parked", () => {
    expect(gateSurface([], true)).toBe("none");
    expect(gateSurface([], false)).toBe("none");
  });
});
