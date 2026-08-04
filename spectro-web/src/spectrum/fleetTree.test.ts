import { describe, expect, it } from "vitest";
import { buildFleetTree } from "./fleetTree";
import type { FleetModel, FleetNode } from "./fleetModel";
import type { RunEvent } from "../events";

function node(id: string, role: string, extra: Partial<FleetNode> = {}): FleetNode {
  return { id, role, capabilities: [], topic: "ctx.events", connected: false, lastSeen: 0, ...extra };
}

function model(roster: FleetNode[], events: RunEvent[]): FleetModel {
  return { roster, events, epochBySender: {} };
}

describe("buildFleetTree", () => {
  it("nests a spawned agent under its parent, depth-stamped", () => {
    const rows = buildFleetTree(
      model(
        [node("main", "root"), node("w1", "worker")],
        [{ type: "agent_spawn", agentId: "w1", parentId: "main", task: "t", ts: 2 }],
      ),
    );
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["main", 0],
      ["w1", 1],
    ]);
  });

  it("keeps parents before children through several levels", () => {
    const rows = buildFleetTree(
      model(
        [node("main", "root"), node("a", "worker"), node("b", "worker")],
        [
          { type: "agent_spawn", agentId: "a", parentId: "main", task: "t", ts: 2 },
          { type: "agent_spawn", agentId: "b", parentId: "a", task: "t", ts: 3 },
        ],
      ),
    );
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["main", 0],
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("marks the last child of a group so the rail can draw the elbow", () => {
    const rows = buildFleetTree(
      model(
        [node("main", "root"), node("a", "worker"), node("b", "worker")],
        [
          { type: "agent_spawn", agentId: "a", parentId: "main", task: "t", ts: 2 },
          { type: "agent_spawn", agentId: "b", parentId: "main", task: "t", ts: 3 },
        ],
      ),
    );
    expect(rows.find((r) => r.id === "a")!.last).toBe(false);
    expect(rows.find((r) => r.id === "b")!.last).toBe(true);
    expect(rows.find((r) => r.id === "main")!.last).toBe(true);
  });

  it("survives a spawn cycle instead of recursing forever", () => {
    // Two nodes each claiming the other as parent: neither can be a root, so
    // the fold must break in and still list both exactly once.
    const rows = buildFleetTree(
      model(
        [node("a", "worker"), node("b", "worker")],
        [
          { type: "agent_spawn", agentId: "a", parentId: "b", task: "t", ts: 1 },
          { type: "agent_spawn", agentId: "b", parentId: "a", task: "t", ts: 2 },
        ],
      ),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(rows).toHaveLength(2);
  });

  it("treats a parent that never joined the fleet as a root", () => {
    // The card was evicted from the ring; the child must not vanish with it.
    const rows = buildFleetTree(
      model([node("w1", "worker")], [{ type: "run_start", runId: "r", agentId: "w1", prompt: "p", ts: 1 }]),
    );
    expect(rows.map((r) => [r.id, r.depth])).toEqual([["w1", 0]]);
  });

  it("orders siblings by first act, then id", () => {
    const rows = buildFleetTree(
      model(
        [node("main", "root"), node("late", "worker"), node("early", "worker"), node("never", "worker")],
        [
          { type: "agent_spawn", agentId: "late", parentId: "main", task: "t", ts: 1 },
          { type: "agent_spawn", agentId: "early", parentId: "main", task: "t", ts: 1 },
          { type: "agent_spawn", agentId: "never", parentId: "main", task: "t", ts: 1 },
          { type: "text_delta", agentId: "early", text: "x", ts: 10 },
          { type: "text_delta", agentId: "late", text: "x", ts: 20 },
        ],
      ),
    );
    expect(rows.slice(1).map((r) => r.id)).toEqual(["early", "late", "never"]);
  });

  it("is empty for an empty fleet", () => {
    expect(buildFleetTree({ roster: [], events: [], epochBySender: {} })).toEqual([]);
  });
});
