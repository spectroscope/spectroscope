import { describe, it, expect, beforeEach } from "vitest";
import {
  fleetPushLive,
  fleetLoadScenario,
  hydrateFleet,
  knownFleet,
  removeFleet,
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
      sender,
      epoch,
      contextId: "c",
      taskId: "t",
      sequence: 0,
      parentId: null,
      topic: "run." + sender,
      ts: 1,
      payload: { type: "text_delta", agentId: sender, text: "x", ts: 1 },
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
    __setTestHooks({
      fetch: async () => {
        throw new Error("network down");
      },
    });
    await hydrateFleet();
    expect(__getFleet().roster).toEqual([]);
  });

  it("hydrates each node's ring replay too — a parked gate is visible to a fresh browser", async () => {
    // The roster alone cannot show a gate parked BEFORE this browser opened;
    // the aggregator holds the ring, so hydration pulls /api/fleet/{node}/events
    // per node and folds the frames like live ones.
    const gate: RunEvent = {
      type: "permission_request",
      agentId: "security-1",
      callId: "g1",
      name: "write_file",
      input: {},
      ts: 5,
    };
    __setTestHooks({
      fetch: async (url) => {
        const path = String(url);
        if (path.endsWith("/api/fleet")) {
          return fakeResponse({ enabled: true, nodes: [node("security-1")] });
        }
        if (path.endsWith("/api/fleet/security-1/events")) {
          return fakeResponse({
            node: "security-1",
            events: [
              {
                sender: "security-1",
                epoch: 7,
                contextId: "pr-42",
                taskId: "t",
                sequence: 3,
                parentId: null,
                topic: "run.security-1",
                ts: 5,
                payload: gate,
              },
            ],
          });
        }
        throw new Error("unexpected fetch " + path);
      },
    });
    await hydrateFleet();
    expect(__getFleet().events).toEqual([gate]);
    expect(__getFleets().some((f) => f.pendingGate)).toBe(true);
  });

  it("drops a live frame the hydration already delivered (same sender/epoch/sequence)", async () => {
    const frame = eventFrame("a", 2);
    __setTestHooks({
      fetch: async (url) => {
        const path = String(url);
        if (path.endsWith("/api/fleet")) {
          return fakeResponse({ enabled: true, nodes: [node("a")] });
        }
        return fakeResponse({ node: "a", events: [(frame as { frame: unknown }).frame] });
      },
    });
    await hydrateFleet();
    fleetPushLive([frame as unknown as RunEvent]); // the socket redelivers it
    expect(__getFleet().events).toHaveLength(1);
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
      sender,
      epoch: 0,
      contextId: ctx,
      taskId: "t",
      sequence,
      parentId: null,
      topic: ctx + ".events",
      ts: payload.ts,
      payload,
    },
  };
}

const delta = (sender: string, text: string): RunEvent => ({
  type: "text_delta",
  agentId: sender,
  text,
  ts: 1,
});
const gateRequest = (sender: string, callId: string, ts: number): RunEvent => ({
  type: "permission_request",
  agentId: sender,
  callId,
  name: "run_command",
  input: {},
  ts,
});
const gateDecision = (callId: string, allowed: boolean, ts: number): RunEvent => ({
  type: "permission_decision",
  callId,
  allowed,
  ts,
});

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
      {
        type: "fleet_roster",
        nodes: [ctxNode("a", "ctxA", true), ctxNode("b", "ctxA", false)],
      } as unknown as RunEvent,
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

  it("knownFleet answers by contextId — the deep-link guard's roster check", () => {
    // Card 131: #/fleet/{id} in a fresh tab hydrates first, then asks this.
    expect(knownFleet("ctxA")).toBe(false);
    fleetPushLive([ctxEvent("a", "ctxA", 0, delta("a", "a0")) as unknown as RunEvent]);
    expect(knownFleet("ctxA")).toBe(true);
    expect(knownFleet("ghost")).toBe(false);
  });
});

describe("fleetPending", () => {
  function model(events: RunEvent[]): FleetModel {
    return { roster: [], events, frames: [], epochBySender: {} };
  }

  it("returns undecided permission requests with their payload, dropping decided ones", () => {
    // Block 4: the entered fleet's gate surface. Same request-minus-decision-by-
    // callId fold as the sidebar's pendingGate flag, but KEEPING the payload so
    // an operator can answer it (agentId names the node the answer POSTs to).
    const pending = fleetPending(
      model([
        {
          type: "permission_request",
          agentId: "node-a",
          callId: "c1",
          name: "write_file",
          input: { path: "a.txt" },
          ts: 1,
        },
        {
          type: "permission_request",
          agentId: "node-b",
          callId: "c2",
          name: "run_command",
          input: { cmd: "ls" },
          ts: 2,
        },
        { type: "permission_decision", callId: "c1", allowed: true, ts: 3 },
      ]),
    );
    expect(pending).toEqual([{ callId: "c2", agentId: "node-b", name: "run_command", input: { cmd: "ls" } }]);
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

  describe("fleetLoadScenario", () => {
    const evs: RunEvent[] = [
      { type: "run_start", runId: "s-main", agentId: "main", prompt: "go", ts: 1 },
      { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "a", ts: 2 },
      { type: "agent_spawn", agentId: "worker-2", parentId: "main", task: "b", ts: 3 },
      { type: "text_delta", agentId: "worker-1", text: "hi", ts: 4 },
    ];

    it("folds a compiled scenario into a fleet model under its contextId", () => {
      fleetLoadScenario("scenario:demo", evs);
      const fleet = __getFleetOf("scenario:demo");
      expect(fleet.events).toHaveLength(evs.length);
      // roster derived from the agents; roles from the ids (worker-N → worker).
      const byId = new Map(fleet.roster.map((n) => [n.id, n]));
      expect(byId.get("main")?.role).toBe("root");
      expect(byId.get("worker-1")?.role).toBe("worker");
      expect(byId.get("worker-2")?.role).toBe("worker");
      // it is a replay, not a live hub — nothing connected.
      expect(fleet.roster.every((n) => !n.connected)).toBe(true);
    });

    it("shows up in the fleet summaries list", () => {
      fleetLoadScenario("scenario:demo", evs);
      expect(__getFleets().some((s) => s.contextId === "scenario:demo")).toBe(true);
    });

    it("is idempotent — re-loading replaces, never doubles, the frames", () => {
      fleetLoadScenario("scenario:demo", evs);
      fleetLoadScenario("scenario:demo", evs);
      expect(__getFleetOf("scenario:demo").events).toHaveLength(evs.length);
    });

    it("coexists with a live fleet under a different contextId", () => {
      fleetPushLive([eventFrame("node-a", 0)] as unknown as RunEvent[]);
      fleetLoadScenario("scenario:demo", evs);
      expect(__getFleetOf("c").events.length).toBeGreaterThan(0); // the live one survives
      expect(__getFleetOf("scenario:demo").events).toHaveLength(evs.length);
    });
  });
});

describe("removeFleet — dropping a finished fleet from the list (owner)", () => {
  beforeEach(() => __resetForTests());

  it("removes the context's frames and summaries; other fleets stay", () => {
    fleetPushLive([
      {
        type: "fleet_event",
        frame: {
          sender: "a",
          epoch: 0,
          contextId: "done-fleet",
          taskId: "t",
          sequence: 0,
          parentId: null,
          topic: "done-fleet.events",
          ts: 1,
          payload: { type: "text_delta", agentId: "a", text: "x", ts: 1 },
        },
      } as unknown as RunEvent,
      {
        type: "fleet_event",
        frame: {
          sender: "b",
          epoch: 0,
          contextId: "other",
          taskId: "t",
          sequence: 0,
          parentId: null,
          topic: "other.events",
          ts: 1,
          payload: { type: "text_delta", agentId: "b", text: "y", ts: 1 },
        },
      } as unknown as RunEvent,
    ]);
    expect(
      __getFleets()
        .map((f) => f.contextId)
        .sort(),
    ).toEqual(["done-fleet", "other"]);
    removeFleet("done-fleet");
    expect(__getFleets().map((f) => f.contextId)).toEqual(["other"]);
    // Its envelope identities are forgotten too — a re-run of the same fleet
    // (same context, same sequences) folds fresh instead of being deduped away.
    fleetPushLive([
      {
        type: "fleet_event",
        frame: {
          sender: "a",
          epoch: 0,
          contextId: "done-fleet",
          taskId: "t",
          sequence: 0,
          parentId: null,
          topic: "done-fleet.events",
          ts: 2,
          payload: { type: "text_delta", agentId: "a", text: "again", ts: 2 },
        },
      } as unknown as RunEvent,
    ]);
    expect(
      __getFleets()
        .map((f) => f.contextId)
        .sort(),
    ).toEqual(["done-fleet", "other"]);
  });
});
