import { describe, expect, it } from "vitest";
import { buildFleetLedger } from "./fleetLedger";
import type { FleetModel, FleetNode } from "./fleetModel";
import type { RunEvent } from "../events";

function node(id: string, role: string, extra: Partial<FleetNode> = {}): FleetNode {
  return {
    id,
    role,
    capabilities: [],
    topic: "ctx.events",
    connected: false,
    lastSeen: 0,
    ...extra,
  };
}

function model(roster: FleetNode[], events: RunEvent[]): FleetModel {
  return { roster, events, frames: [], epochBySender: {} };
}

describe("buildFleetLedger", () => {
  it("gives every roster member a row, ordered by first act then id", () => {
    const ledger = buildFleetLedger(
      model(
        [node("worker-2", "worker"), node("worker-1", "worker"), node("main", "root")],
        [
          { type: "run_start", runId: "r", agentId: "main", prompt: "p", ts: 100 },
          { type: "run_start", runId: "r", agentId: "worker-1", prompt: "p", ts: 200 },
        ],
      ),
    );
    // main acted first, worker-1 second, worker-2 never acted (sorts last, by id)
    expect(ledger.rows.map((r) => r.id)).toEqual(["main", "worker-1", "worker-2"]);
  });

  it("sums a node's tokens, including the two cache counters", () => {
    const ledger = buildFleetLedger(
      model(
        [node("main", "root")],
        [
          { type: "usage", agentId: "main", inputTokens: 10, outputTokens: 3, ts: 1 },
          {
            type: "usage",
            agentId: "main",
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 40,
            cacheCreationTokens: 7,
            ts: 2,
          },
        ],
      ),
    );
    const row = ledger.rows[0];
    expect(row.inTokens).toBe(15);
    expect(row.outTokens).toBe(5);
    expect(row.cacheReadTokens).toBe(40);
    expect(row.cacheCreationTokens).toBe(7);
  });

  it("takes gate wait from the MEASURED gateWaitMs, never from a ts delta", () => {
    // The request sits 9000 ms before the decision on the wall clock, but the
    // server measured 5000: the parked time is the measurement, and the rest of
    // that window is the tool actually running. A ts-delta reconstruction would
    // report 9000 and be wrong.
    const ledger = buildFleetLedger(
      model(
        [node("main", "root")],
        [
          { type: "permission_request", agentId: "main", callId: "c1", name: "write", input: {}, ts: 1000 },
          { type: "permission_decision", callId: "c1", allowed: true, ts: 10000 },
          {
            type: "tool_result",
            agentId: "main",
            callId: "c1",
            output: "ok",
            isError: false,
            durationMs: 40,
            gateWaitMs: 5000,
            ts: 10040,
          },
        ],
      ),
    );
    const row = ledger.rows[0];
    expect(row.gateWaitMs).toBe(5000);
    expect(row.gates).toBe(1);
    expect(row.gatesPending).toBe(0);
    expect(row.gateWaitMeasured).toBe(true);
  });

  it("says so when a gate happened but no node reported a measurement", () => {
    // A pre-card-111 node, or one that died before the result: the count is
    // honest, the milliseconds are not claimed.
    const ledger = buildFleetLedger(
      model(
        [node("main", "root")],
        [
          { type: "permission_request", agentId: "main", callId: "c1", name: "write", input: {}, ts: 1000 },
          { type: "permission_decision", callId: "c1", allowed: true, ts: 10000 },
          {
            type: "tool_result",
            agentId: "main",
            callId: "c1",
            output: "ok",
            isError: false,
            durationMs: 40,
            ts: 10040,
          },
        ],
      ),
    );
    expect(ledger.rows[0].gateWaitMs).toBe(0);
    expect(ledger.rows[0].gateWaitMeasured).toBe(false);
  });

  it("does not call the wait a floor when the call was never gated", () => {
    // PIN: gateWaitMeasured must flip only for a call that actually parked.
    // An ordinary tool result carries no gateWaitMs by design (the server omits
    // it), and reading that absence as a missing measurement would mark every
    // fleet that ever ran a tool as under-reported.
    const ledger = buildFleetLedger(
      model(
        [node("main", "root")],
        [
          {
            type: "tool_result",
            agentId: "main",
            callId: "ungated",
            output: "ok",
            isError: false,
            durationMs: 12,
            ts: 1,
          },
        ],
      ),
    );
    expect(ledger.rows[0].gateWaitMeasured).toBe(true);
    expect(ledger.total.gateWaitMeasured).toBe(true);
  });

  it("does not blame one agent for another agent's unmeasured gate", () => {
    // PIN: callIds are unique per agent in practice, but the attribution must
    // come from the agent that ASKED, not from whoever reported a result.
    const ledger = buildFleetLedger(
      model(
        [node("a", "worker"), node("b", "worker")],
        [
          { type: "permission_request", agentId: "a", callId: "c1", name: "write", input: {}, ts: 1 },
          {
            type: "tool_result",
            agentId: "b",
            callId: "c1",
            output: "ok",
            isError: false,
            durationMs: 5,
            ts: 2,
          },
        ],
      ),
    );
    expect(ledger.rows.find((r) => r.id === "b")!.gateWaitMeasured).toBe(true);
  });

  it("counts an undecided request as a pending gate", () => {
    const ledger = buildFleetLedger(
      model(
        [node("main", "root")],
        [{ type: "permission_request", agentId: "main", callId: "c1", name: "write", input: {}, ts: 1 }],
      ),
    );
    expect(ledger.rows[0].gates).toBe(1);
    expect(ledger.rows[0].gatesPending).toBe(1);
    expect(ledger.total.gatesPending).toBe(1);
  });

  it("splits tool time from tool errors and from error events", () => {
    const ledger = buildFleetLedger(
      model(
        [node("main", "root")],
        [
          {
            type: "tool_result",
            agentId: "main",
            callId: "a",
            output: "ok",
            isError: false,
            durationMs: 120,
            ts: 5,
          },
          {
            type: "tool_result",
            agentId: "main",
            callId: "b",
            output: "ERROR: nope",
            isError: true,
            durationMs: 30,
            ts: 6,
          },
          { type: "error", agentId: "main", message: "boom", ts: 7 },
        ],
      ),
    );
    const row = ledger.rows[0];
    expect(row.toolCalls).toBe(2);
    expect(row.toolMs).toBe(150);
    expect(row.toolErrors).toBe(1);
    expect(row.errors).toBe(1);
  });

  it("carries the node's trigger, the field the web used to drop", () => {
    const ledger = buildFleetLedger(
      model([node("watcher", "worker", { trigger: "watch:/drop + every:5m" })], []),
    );
    expect(ledger.rows[0].trigger).toBe("watch:/drop + every:5m");
    expect(buildFleetLedger(model([node("main", "root")], [])).rows[0].trigger).toBeNull();
  });

  it("rolls up per role, one entry per role, agents counted", () => {
    const ledger = buildFleetLedger(
      model(
        [node("w1", "worker"), node("w2", "worker"), node("main", "root")],
        [
          { type: "usage", agentId: "w1", inputTokens: 10, outputTokens: 1, ts: 1 },
          { type: "usage", agentId: "w2", inputTokens: 20, outputTokens: 2, ts: 2 },
          { type: "usage", agentId: "main", inputTokens: 5, outputTokens: 5, ts: 3 },
        ],
      ),
    );
    const worker = ledger.roles.find((r) => r.role === "worker");
    expect(worker).toBeDefined();
    expect(worker!.agents).toBe(2);
    expect(worker!.inTokens).toBe(30);
    expect(worker!.outTokens).toBe(3);
    expect(ledger.roles.map((r) => r.role).sort()).toEqual(["root", "worker"]);
  });

  it("separates fleet WALL CLOCK from summed agent time — that ratio is the parallelism", () => {
    // Two agents each busy for 100 ms, overlapping: the fleet took 150 ms of
    // wall clock while 200 ms of agent time was spent. Summing the spans and
    // calling it "the fleet took" would be the lie this row exists to prevent.
    const ledger = buildFleetLedger(
      model(
        [node("a", "worker"), node("b", "worker")],
        [
          { type: "run_start", runId: "r", agentId: "a", prompt: "p", ts: 1000 },
          { type: "run_end", runId: "r", stopReason: "done", ts: 1100 },
          { type: "text_delta", agentId: "a", text: "x", ts: 1100 },
          { type: "run_start", runId: "r2", agentId: "b", prompt: "p", ts: 1050 },
          { type: "text_delta", agentId: "b", text: "x", ts: 1150 },
        ],
      ),
    );
    expect(ledger.total.spanMs).toBe(150);
    expect(ledger.total.agentMs).toBe(200);
    expect(ledger.total.agents).toBe(2);
  });

  it("counts online nodes and totals the fleet", () => {
    const ledger = buildFleetLedger(
      model(
        [node("a", "worker", { connected: true }), node("b", "worker")],
        [
          { type: "usage", agentId: "a", inputTokens: 10, outputTokens: 1, ts: 1 },
          { type: "usage", agentId: "b", inputTokens: 10, outputTokens: 1, ts: 2 },
        ],
      ),
    );
    expect(ledger.total.online).toBe(1);
    expect(ledger.total.inTokens).toBe(20);
    expect(ledger.total.outTokens).toBe(2);
  });

  it("gives an agent that only appears in the events a row too", () => {
    // A node whose card never arrived (or was evicted) still spent tokens.
    const ledger = buildFleetLedger(
      model([], [{ type: "usage", agentId: "ghost", inputTokens: 7, outputTokens: 1, ts: 1 }]),
    );
    expect(ledger.rows.map((r) => r.id)).toEqual(["ghost"]);
    expect(ledger.total.inTokens).toBe(7);
  });

  it("is empty and finite for an empty fleet", () => {
    const ledger = buildFleetLedger({ roster: [], events: [], frames: [], epochBySender: {} });
    expect(ledger.rows).toEqual([]);
    expect(ledger.roles).toEqual([]);
    expect(ledger.total.spanMs).toBe(0);
    expect(ledger.total.agentMs).toBe(0);
    expect(ledger.total.agents).toBe(0);
  });
});
