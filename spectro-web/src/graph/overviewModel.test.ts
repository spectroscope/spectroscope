// The flow-overview model: fold the FULL event stream into a BPMN-like
// activity flow — sequential activities on the always-present main spine,
// subagent waves as parallel blocks (branch columns that join back).
// Invariant: the top-level nodes PARTITION the event indices [0..N) — every
// index belongs to exactly one node, so cursor→activity is a range lookup.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildOverview, activityAt, type OverviewNode } from "./overviewModel";

type Parallel = Extract<OverviewNode, { t: "parallel" }>;

/** A realistic session: prompt → think/say → build_plan wave with one worker
 *  (gated write inside the child) → wrapper result → final answer → end. */
function spawnSession(): RunEvent[] {
  return [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "Plan the version flag, then implement it step by step", ts: 1 },
    { type: "turn_start", agentId: "main", turn: 1, ts: 2 },
    { type: "thinking_delta", agentId: "main", text: "I should delegate the plan.", ts: 3 },
    { type: "text_delta", agentId: "main", text: "Delegating to a planner.", ts: 4 },
    { type: "tool_call", agentId: "main", callId: "c1", name: "build_plan", input: { task: "Plan the flag" }, ts: 5 },
    { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "Plan the flag", ts: 6 },
    { type: "agent_message", from: "main", to: "worker-1", role: "task", state: "submitted", text: "Plan the flag", label: "plan", ts: 7 },
    { type: "run_start", runId: "rc", agentId: "worker-1", parentId: "main", prompt: "Plan the flag", ts: 8 },
    { type: "turn_start", agentId: "worker-1", turn: 1, ts: 9 },
    { type: "thinking_delta", agentId: "worker-1", text: "Sketching the plan.", ts: 10 },
    { type: "tool_call", agentId: "worker-1", callId: "k1", name: "write_file", input: { path: "docs/plan.md", content: "…" }, ts: 11 },
    { type: "permission_request", agentId: "worker-1", callId: "k1", name: "write_file", input: { path: "docs/plan.md" }, ts: 12 },
    { type: "permission_decision", callId: "k1", allowed: true, ts: 13 },
    { type: "tool_result", agentId: "worker-1", callId: "k1", output: "Wrote: docs/plan.md", isError: false, durationMs: 5, ts: 14 },
    { type: "text_delta", agentId: "worker-1", text: "Plan written.", ts: 15 },
    { type: "run_end", runId: "rc", stopReason: "end_turn", ts: 16 },
    { type: "tool_result", agentId: "main", callId: "c1", output: "Plan written.", isError: false, durationMs: 900, ts: 17 },
    { type: "turn_start", agentId: "main", turn: 2, ts: 18 },
    { type: "text_delta", agentId: "main", text: "The plan is ready.", ts: 19 },
    { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 20 },
  ];
}

function coverage(nodes: OverviewNode[]): Array<[number, number]> {
  return nodes.map((nd) => (nd.t === "activity" ? [nd.a.from, nd.a.to] : [nd.from, nd.to]));
}

describe("buildOverview", () => {
  it("starts with the user prompt and ends with an end marker", () => {
    const nodes = buildOverview(spawnSession());
    expect(nodes[0]).toMatchObject({ t: "activity", a: { kind: "user" } });
    expect(nodes[nodes.length - 1]).toMatchObject({ t: "activity", a: { kind: "end" } });
  });

  it("top-level nodes partition the event indices without gaps or overlaps", () => {
    const ev = spawnSession();
    const ranges = coverage(buildOverview(ev));
    let next = 0;
    for (const [from, to] of ranges) {
      expect(from, `gap before ${from}`).toBe(next);
      expect(to, "inverted range").toBeGreaterThanOrEqual(from);
      next = to + 1;
    }
    expect(next, "tail covered").toBe(ev.length);
  });

  it("a spawn wave becomes a parallel block with side-by-side branch content", () => {
    const nodes = buildOverview(spawnSession());
    const block = nodes.find((nd): nd is Parallel => nd.t === "parallel");
    expect(block).toBeTruthy();
    expect(block!.label).toBe("build_plan");
    expect(block!.branches.map((b) => b.agentId)).toEqual(["worker-1"]);
    expect(block!.branches[0].label).toBe("plan"); // from the A2A task message
    const kinds = block!.branches[0].activities.map((a) => a.kind);
    expect(kinds).toEqual(["think", "tool", "say"]);
    const write = block!.branches[0].activities[1];
    expect(write.label).toBe("write plan.md");
    expect(write.gate).toBe("allowed");
    expect(write.isError).toBeFalsy();
  });

  it("the wrapper result closes the block; the answer lands back on the spine", () => {
    const ev = spawnSession();
    const nodes = buildOverview(ev);
    const block = nodes.find((nd): nd is Parallel => nd.t === "parallel")!;
    const wrapperResult = ev.findIndex((e) => e.type === "tool_result" && e.callId === "c1");
    // The block swallows the whole wave up to (at least) the wrapper's result;
    // trailing book-keeping (the next turn_start) may stretch it by one — the
    // partition invariant demands every index has a home.
    expect(block.from).toBe(ev.findIndex((e) => e.type === "tool_call"));
    expect(block.to).toBeGreaterThanOrEqual(wrapperResult);
    const after = nodes.slice(nodes.indexOf(block) + 1);
    expect(after.some((nd) => nd.t === "activity" && nd.a.kind === "say")).toBe(true);
  });

  it("a denied gate reddens the tool activity on the main spine", () => {
    const ev: RunEvent[] = [
      { type: "run_start", runId: "r2", agentId: "main", prompt: "Delete it", ts: 1 },
      { type: "tool_call", agentId: "main", callId: "c9", name: "run_command", input: { command: "rm -rf build" }, ts: 2 },
      { type: "permission_request", agentId: "main", callId: "c9", name: "run_command", input: { command: "rm -rf build" }, ts: 3 },
      { type: "permission_decision", callId: "c9", allowed: false, ts: 4 },
      { type: "tool_result", agentId: "main", callId: "c9", output: "denied", isError: true, durationMs: 0, ts: 5 },
      { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 6 },
    ];
    const nodes = buildOverview(ev);
    const acts = nodes.filter((nd): nd is Extract<OverviewNode, { t: "activity" }> => nd.t === "activity").map((nd) => nd.a);
    const rm = acts.find((a) => a.kind === "tool");
    expect(rm).toMatchObject({ gate: "denied", isError: true });
    expect(rm!.label).toBe("$ rm -rf build");
  });
});

describe("token streaming", () => {
  it("an activity's label grows across deltas instead of freezing on token one", () => {
    const ev: RunEvent[] = [
      { type: "run_start", runId: "r3", agentId: "main", prompt: "Hi", ts: 1 },
      { type: "text_delta", agentId: "main", text: "The ", ts: 2 },
      { type: "text_delta", agentId: "main", text: "flag ", ts: 3 },
      { type: "text_delta", agentId: "main", text: "is ready.", ts: 4 },
      { type: "run_end", runId: "r3", stopReason: "end_turn", ts: 5 },
    ];
    const nodes = buildOverview(ev);
    const say = nodes.find((nd): nd is Extract<OverviewNode, { t: "activity" }> =>
      nd.t === "activity" && nd.a.kind === "say")!;
    expect(say.a.label).toBe("The flag is ready.");
    expect(say.a.from).toBe(1);
    expect(say.a.to).toBe(3);
  });
});

describe("activityAt", () => {
  it("maps every cursor position to a node (and n=0 to null)", () => {
    const ev = spawnSession();
    const nodes = buildOverview(ev);
    expect(activityAt(nodes, 0)).toBeNull();
    for (let n = 1; n <= ev.length; n++) {
      expect(activityAt(nodes, n), `n=${n}`).toBeTruthy();
    }
  });

  it("inside a parallel block, a child event maps to that branch's activity", () => {
    const ev = spawnSession();
    const nodes = buildOverview(ev);
    const block = nodes.find((nd): nd is Parallel => nd.t === "parallel")!;
    const childWrite = ev.findIndex((e) => e.type === "tool_call" && e.agentId === "worker-1");
    const hit = activityAt(nodes, childWrite + 1)!;
    expect(block.branches[0].activities.some((a) => a.id === hit)).toBe(true);
  });
});
