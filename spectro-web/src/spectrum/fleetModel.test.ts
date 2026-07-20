import { describe, it, expect } from "vitest";
import { buildFleet, isFleetFrame, type FleetFrame, type FleetNode } from "./fleetModel";
import type { RunEvent } from "../events";

function node(id: string, connected = true): FleetNode {
  return { id, role: "worker", capabilities: ["read_file"], topic: "run." + id, connected, lastSeen: 1000 };
}

function delta(sender: string, text: string, ts: number): RunEvent {
  return { type: "text_delta", agentId: sender, text, ts };
}

function event(sender: string, epoch: number, sequence: number, payload: RunEvent): FleetFrame {
  return {
    type: "fleet_event",
    frame: {
      sender, epoch, contextId: "ctx", taskId: sender + "#task", sequence,
      parentId: null, topic: "run." + sender, ts: payload.ts, payload,
    },
  };
}

describe("buildFleet", () => {
  it("is empty for no frames", () => {
    const m = buildFleet([]);
    expect(m.roster).toEqual([]);
    expect(m.events).toEqual([]);
    expect(m.epochBySender).toEqual({});
  });

  it("takes the roster latest-wins, not accumulated", () => {
    const m = buildFleet([
      { type: "fleet_roster", nodes: [node("a")] },
      { type: "fleet_roster", nodes: [node("a"), node("b")] },
      { type: "fleet_roster", nodes: [node("a"), node("b", false)] },
    ]);
    expect(m.roster.map((n) => n.id)).toEqual(["a", "b"]);
    expect(m.roster[1].connected).toBe(false); // the last roster is the truth
  });

  it("accumulates fleet_event payloads in arrival order", () => {
    const m = buildFleet([
      event("a", 0, 0, delta("a", "a0", 10)),
      event("b", 0, 0, delta("b", "b0", 20)),
      event("a", 0, 1, delta("a", "a1", 30)),
    ]);
    expect(m.events.map((e) => (e as { text: string }).text)).toEqual(["a0", "b0", "a1"]);
  });

  it("tracks the latest epoch per sender — a restart shows, never merges silently", () => {
    const m = buildFleet([
      event("a", 0, 0, delta("a", "first life", 10)),
      event("b", 0, 0, delta("b", "b", 20)),
      event("a", 1, 0, delta("a", "second life", 30)), // node a restarted
    ]);
    expect(m.epochBySender).toEqual({ a: 1, b: 0 });
  });

  it("keeps the higher epoch even when an old-epoch frame arrives late", () => {
    const m = buildFleet([
      event("a", 2, 0, delta("a", "new", 30)),
      event("a", 1, 5, delta("a", "straggler from the old incarnation", 10)),
    ]);
    expect(m.epochBySender.a).toBe(2); // a late old-epoch frame does not lower it
    expect(m.events).toHaveLength(2); // but it is NOT dropped — both delivered
  });

  it("folds a mixed roster+event stream", () => {
    const m = buildFleet([
      { type: "fleet_roster", nodes: [node("a")] },
      event("a", 0, 0, delta("a", "hi", 10)),
      { type: "fleet_roster", nodes: [node("a"), node("b")] },
      event("b", 0, 0, delta("b", "yo", 20)),
    ]);
    expect(m.roster.map((n) => n.id)).toEqual(["a", "b"]);
    expect(m.events).toHaveLength(2);
    expect(m.epochBySender).toEqual({ a: 0, b: 0 });
  });
});

describe("isFleetFrame", () => {
  it("recognizes the two fleet frames", () => {
    expect(isFleetFrame({ type: "fleet_roster", nodes: [] })).toBe(true);
    expect(isFleetFrame({ type: "fleet_event", frame: {} })).toBe(true);
  });

  it("rejects RunEvents and junk — so it can split a mixed batch", () => {
    expect(isFleetFrame({ type: "text_delta", agentId: "a", text: "x", ts: 1 })).toBe(false);
    expect(isFleetFrame({ type: "run_start" })).toBe(false);
    expect(isFleetFrame(null)).toBe(false);
    expect(isFleetFrame({})).toBe(false);
  });
});
