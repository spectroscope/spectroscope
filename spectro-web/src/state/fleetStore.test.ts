import { describe, it, expect, beforeEach } from "vitest";
import {
  fleetPushLive,
  hydrateFleet,
  fleetPending,
  __getFleet,
  __getFleets,
  __getFleetOf,
  __setTestHooks,
  __resetForTests,
} from "./fleetStore";
import { EMPTY_FLEET, type FleetFrame, type FleetModel, type FleetNode } from "../spectrum/fleetModel";
import type { RunEvent } from "../events";

function node(id: string, connected = true): FleetNode {
  return { id, role: "worker", capabilities: [], topic: "run." + id, connected, lastSeen: 1 };
}

function rosterFrame(...ids: string[]): FleetFrame {
  return { type: "fleet_roster", nodes: ids.map((id) => node(id)) };
}

function eventFrame(sender: string, epoch: number): FleetFrame {
  return {
    type: "fleet_event",
    frame: {
      sender, epoch, contextId: "c", taskId: "t", sequence: 0, parentId: null,
      topic: "run." + sender, ts: 1, payload: { type: "text_delta", agentId: sender, text: "x", ts: 1 },
    },
  };
}

function fakeResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("fleetStore", () => {
  beforeEach(() => __resetForTests());

  it("starts empty", () => {
    expect(__getFleet().roster).toEqual([]);
    expect(__getFleet().events).toEqual([]);
  });

  it("folds fleet frames from a live batch", () => {
    fleetPushLive([rosterFrame("a", "b") as unknown as RunEvent]);
    expect(__getFleet().roster.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("ignores non-fleet events and does not re-render for them", () => {
    fleetPushLive([rosterFrame("a") as unknown as RunEvent]);
    const before = __getFleet();
    fleetPushLive([{ type: "text_delta", agentId: "main", text: "hi", ts: 1 }]);
    // A batch with no fleet frames leaves the snapshot reference untouched, so
    // useSyncExternalStore does not fire a spurious render.
    expect(__getFleet()).toBe(before);
  });

  it("accumulates events and tracks epoch across batches", () => {
    fleetPushLive([eventFrame("a", 0) as unknown as RunEvent]);
    fleetPushLive([eventFrame("a", 1) as unknown as RunEvent]); // a restarted
    expect(__getFleet().events).toHaveLength(2);
    expect(__getFleet().epochBySender.a).toBe(1);
  });

  it("hydrates the roster from /api/fleet when the hub is enabled", async () => {
    __setTestHooks({ fetch: async () => fakeResponse({ enabled: true, nodes: [node("h1"), node("h2")] }) });
    await hydrateFleet();
    expect(__getFleet().roster.map((n) => n.id)).toEqual(["h1", "h2"]);
  });

  it("stays empty when the hub is disabled", async () => {
    __setTestHooks({ fetch: async () => fakeResponse({ enabled: false, nodes: [] }) });
    await hydrateFleet();
    expect(__getFleet().roster).toEqual([]);
  });

  it("lets a later live roster override the hydrated one (latest-wins)", async () => {
    __setTestHooks({ fetch: async () => fakeResponse({ enabled: true, nodes: [node("old")] }) });
    await hydrateFleet();
    fleetPushLive([rosterFrame("fresh") as unknown as RunEvent]);
    expect(__getFleet().roster.map((n) => n.id)).toEqual(["fresh"]);
  });

  it("never throws when the probe fails", async () => {
    __setTestHooks({ fetch: async () => { throw new Error("network down"); } });
    await hydrateFleet();
    expect(__getFleet().roster).toEqual([]);
  });
});

// --- multi-fleet keying (P0 spine): coexisting fleets stay separate ---

function ctxNode(id: string, ctx: string, connected = true): FleetNode {
  return { id, role: "worker", capabilities: [], topic: ctx + ".events", connected, lastSeen: 1 };
}

function ctxEvent(sender: string, ctx: string, sequence: number, payload: RunEvent): FleetFrame {
  return {
    type: "fleet_event",
    frame: {
      sender, epoch: 0, contextId: ctx, taskId: "t", sequence, parentId: null,
      topic: ctx + ".events", ts: payload.ts, payload,
    },
  };
}

const delta = (sender: string, text: string): RunEvent =>
  ({ type: "text_delta", agentId: sender, text, ts: 1 });
const gateRequest = (sender: string, callId: string, ts: number): RunEvent =>
  ({ type: "permission_request", agentId: sender, callId, name: "run_command", input: {}, ts });
const gateDecision = (callId: string, allowed: boolean, ts: number): RunEvent =>
  ({ type: "permission_decision", callId, allowed, ts });

describe("fleetStore multi-fleet keying", () => {
  beforeEach(() => __resetForTests());

  it("keeps coexisting fleets separate by contextId — events never bleed", () => {
    fleetPushLive([
      { type: "fleet_roster", nodes: [ctxNode("a", "ctxA"), ctxNode("b", "ctxB")] } as unknown as RunEvent,
      ctxEvent("a", "ctxA", 0, delta("a", "a0")) as unknown as RunEvent,
      ctxEvent("b", "ctxB", 0, delta("b", "b0")) as unknown as RunEvent,
    ]);
    expect(__getFleets().map((f) => f.contextId)).toEqual(["ctxA", "ctxB"]);
    expect(__getFleetOf("ctxA").roster.map((n) => n.id)).toEqual(["a"]);
    expect(__getFleetOf("ctxB").roster.map((n) => n.id)).toEqual(["b"]);
    expect(__getFleetOf("ctxA").events).toHaveLength(1);
    expect((__getFleetOf("ctxA").events[0] as { agentId: string }).agentId).toBe("a");
    expect((__getFleetOf("ctxB").events[0] as { agentId: string }).agentId).toBe("b");
  });

  it("summarizes agent/online counts and a pending gate per fleet", () => {
    fleetPushLive([
      { type: "fleet_roster", nodes: [ctxNode("a", "ctxA", true), ctxNode("b", "ctxA", false)] } as unknown as RunEvent,
      ctxEvent("a", "ctxA", 0, gateRequest("a", "c1", 2)) as unknown as RunEvent,
    ]);
    const summary = __getFleets().find((f) => f.contextId === "ctxA")!;
    expect(summary.agentCount).toBe(2);
    expect(summary.onlineCount).toBe(1);
    expect(summary.pendingGate).toBe(true);
    expect(summary.lastActivity).toBe(2);
  });

  it("clears the gate flag once a decision arrives", () => {
    fleetPushLive([
      ctxEvent("a", "ctxA", 0, gateRequest("a", "c1", 1)) as unknown as RunEvent,
      ctxEvent("a", "ctxA", 1, gateDecision("c1", true, 2)) as unknown as RunEvent,
    ]);
    expect(__getFleets().find((f) => f.contextId === "ctxA")!.pendingGate).toBe(false);
  });

  it("the merged view still sees all fleets (back-compat)", () => {
    fleetPushLive([
      ctxEvent("a", "ctxA", 0, delta("a", "a0")) as unknown as RunEvent,
      ctxEvent("b", "ctxB", 0, delta("b", "b0")) as unknown as RunEvent,
    ]);
    expect(__getFleet().events).toHaveLength(2);
  });

  it("a fleet's model ref stays stable when only OTHER fleets change", () => {
    fleetPushLive([ctxEvent("a", "ctxA", 0, delta("a", "a0")) as unknown as RunEvent]);
    const before = __getFleetOf("ctxA");
    fleetPushLive([ctxEvent("b", "ctxB", 0, delta("b", "b0")) as unknown as RunEvent]);
    // ctxA did not change, so its model reference is reused (no spurious render).
    expect(__getFleetOf("ctxA")).toBe(before);
  });
});

describe("fleetPending", () => {
  function model(events: RunEvent[]): FleetModel {
    return { roster: [], events, epochBySender: {} };
  }

  it("returns undecided permission requests with their payload, dropping decided ones", () => {
    // Block 4: the entered fleet's gate surface. Same request-minus-decision-by-
    // callId fold as the sidebar's pendingGate flag, but KEEPING the payload so
    // an operator can answer it (agentId names the node the answer POSTs to).
    const pending = fleetPending(
      model([
        { type: "permission_request", agentId: "node-a", callId: "c1", name: "write_file", input: { path: "a.txt" }, ts: 1 },
        { type: "permission_request", agentId: "node-b", callId: "c2", name: "run_command", input: { cmd: "ls" }, ts: 2 },
        { type: "permission_decision", callId: "c1", allowed: true, ts: 3 },
      ]),
    );
    expect(pending).toEqual([
      { callId: "c2", agentId: "node-b", name: "run_command", input: { cmd: "ls" } },
    ]);
  });

  it("keeps the parked order — first-parked first (the queue the GateBar shows)", () => {
    const pending = fleetPending(
      model([
        { type: "permission_request", agentId: "node-a", callId: "first", name: "t", input: {}, ts: 1 },
        { type: "permission_request", agentId: "node-a", callId: "second", name: "t", input: {}, ts: 2 },
      ]),
    );
    expect(pending.map((p) => p.callId)).toEqual(["first", "second"]);
  });

  it("is empty with no requests, or when every request is decided", () => {
    expect(fleetPending(EMPTY_FLEET)).toEqual([]);
    expect(
      fleetPending(
        model([
          { type: "permission_request", agentId: "node-a", callId: "c1", name: "t", input: {}, ts: 1 },
          { type: "permission_decision", callId: "c1", allowed: false, ts: 2 },
        ]),
      ),
    ).toEqual([]);
  });
});
