import { describe, it, expect } from "vitest";
import { countWork, foldWork, groupWaves, readReceipt } from "./work";
import type { WorkItem } from "./work";
import type { RunEvent } from "../events";

/** A fan-out of `n` workers under main, each with a usage and a tool call. */
function fanOut(n: number, gap = 0): RunEvent[] {
  const out: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "review this", ts: 1000 },
  ];
  for (let i = 1; i <= n; i++) {
    const id = `worker-${i}`;
    const t = 2000 + (i - 1) * gap;
    out.push({ type: "agent_spawn", agentId: id, parentId: "main", task: `lens ${i}`, ts: t });
    out.push({
      type: "agent_message",
      from: "main",
      to: id,
      role: "task",
      state: "submitted",
      text: `lens ${i}`,
      label: "reviewer",
      ts: t,
    });
    out.push({ type: "run_start", runId: `r-${id}`, agentId: id, parentId: "main", prompt: "go", ts: t + 1 });
    out.push({ type: "tool_call", agentId: id, callId: `c${i}`, name: "read_file", input: {}, ts: t + 2 });
    out.push({
      type: "tool_result",
      agentId: id,
      callId: `c${i}`,
      output: "ok",
      isError: false,
      durationMs: 5,
      ts: t + 3,
    });
    out.push({ type: "usage", agentId: id, inputTokens: 100 * i, outputTokens: 10 * i, ts: t + 4 });
    out.push({
      type: "agent_message",
      from: id,
      to: "main",
      role: "result",
      state: "completed",
      text: "done",
      ts: t + 5,
    });
  }
  return out;
}

const byId = (items: WorkItem[], id: string): WorkItem => {
  const found = items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no work item ${id}`);
  return found;
};

describe("foldWork", () => {
  it("an empty stream folds to nothing", () => {
    expect(foldWork([])).toEqual([]);
  });

  it("a session with no concurrent work folds to nothing — main is the left column", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
      { type: "text_delta", agentId: "main", text: "hello", ts: 2 },
      { type: "usage", agentId: "main", inputTokens: 9, outputTokens: 3, ts: 3 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 4 },
    ];
    expect(foldWork(events)).toEqual([]);
  });

  it("one item per spawned subagent, with label as name and task as intent", () => {
    const items = foldWork(fanOut(3));
    expect(items.map((i) => i.id)).toEqual(["worker-1", "worker-2", "worker-3"]);
    const w1 = byId(items, "worker-1");
    expect(w1.kind).toBe("spawn");
    expect(w1.parentId).toBe("main");
    expect(w1.name).toBe("reviewer");
    expect(w1.intent).toBe("lens 1");
    expect(w1.state).toBe("completed");
  });

  it("counts tokens and tool calls per agent, never across them", () => {
    const items = foldWork(fanOut(3));
    expect(byId(items, "worker-2").inTokens).toBe(200);
    expect(byId(items, "worker-2").outTokens).toBe(20);
    expect(byId(items, "worker-2").toolCalls).toBe(1);
  });

  it("stamps the span from the item's own frames", () => {
    const items = foldWork(fanOut(1));
    const w = byId(items, "worker-1");
    expect(w.firstTs).toBe(2000);
    expect(w.lastTs).toBe(2005);
  });

  it("every counter carries the frame that produced it", () => {
    const items = foldWork(fanOut(2));
    for (const item of items) {
      expect(item.evidence.start).not.toBeNull();
      expect(item.evidence.end).not.toBeNull();
      if (item.inTokens > 0) expect(item.evidence.tokens?.type).toBe("usage");
      if (item.toolCalls > 0) expect(item.evidence.firstCall?.type).toBe("tool_call");
      if (item.gatesDenied > 0) expect(item.evidence.denial?.type).toBe("permission_decision");
    }
  });

  it("joins a permission_decision back to the request that names the agent", () => {
    const events: RunEvent[] = [
      ...fanOut(1),
      {
        type: "permission_request",
        agentId: "worker-1",
        callId: "g1",
        name: "write_file",
        input: {},
        ts: 3000,
      },
      { type: "permission_decision", callId: "g1", allowed: false, ts: 3001 },
      {
        type: "permission_request",
        agentId: "worker-1",
        callId: "g2",
        name: "write_file",
        input: {},
        ts: 3002,
      },
      { type: "permission_decision", callId: "g2", allowed: true, ts: 3003 },
    ];
    const w = byId(foldWork(events), "worker-1");
    expect(w.gatesAsked).toBe(2);
    expect(w.gatesDenied).toBe(1);
    expect(w.gatePending).toBe(false);
  });

  it("a decision with no matching request counts nowhere and does not throw", () => {
    const events: RunEvent[] = [
      ...fanOut(1),
      { type: "permission_decision", callId: "stray", allowed: false, ts: 3000 },
    ];
    const w = byId(foldWork(events), "worker-1");
    expect(w.gatesDenied).toBe(0);
  });

  it("an undecided request leaves the gate pending — the loudest row in the panel", () => {
    const events: RunEvent[] = [
      ...fanOut(1),
      {
        type: "permission_request",
        agentId: "worker-1",
        callId: "g1",
        name: "write_file",
        input: {},
        ts: 3000,
      },
    ];
    expect(byId(foldWork(events), "worker-1").gatePending).toBe(true);
  });

  it("a failed result marks the lane failed and a later status cannot reopen it", () => {
    const events: RunEvent[] = [
      ...fanOut(1),
      {
        type: "agent_message",
        from: "worker-1",
        to: "main",
        role: "status",
        state: "working",
        text: "late line",
        ts: 9000,
      },
    ];
    expect(byId(foldWork(events), "worker-1").state).toBe("completed");
  });

  it("nests a grandchild under the child that spawned it", () => {
    const events: RunEvent[] = [
      ...fanOut(1),
      { type: "agent_spawn", agentId: "sub-a", parentId: "worker-1", task: "deeper", ts: 2500 },
    ];
    const items = foldWork(events);
    expect(items).toHaveLength(1);
    expect(items[0].children.map((c) => c.id)).toEqual(["sub-a"]);
    expect(countWork(items)).toBe(2);
  });

  it("ignores unknown event types instead of throwing", () => {
    const events = [
      ...fanOut(1),
      { type: "something_new", agentId: "worker-1", ts: 5000 } as unknown as RunEvent,
    ];
    expect(() => foldWork(events)).not.toThrow();
    expect(foldWork(events)).toHaveLength(1);
  });
});

describe("foldWork · triggered runs (card 72)", () => {
  it("a run_start carrying a trigger becomes a work item named by what woke it", () => {
    const events: RunEvent[] = [
      {
        type: "run_start",
        runId: "r-fs-4",
        agentId: "node-a",
        prompt: "handle /drop/new.txt",
        trigger: "fs #4 watch:/drop",
        model: "claude-sonnet-5",
        ts: 100,
      },
      { type: "usage", agentId: "node-a", inputTokens: 40, outputTokens: 8, ts: 200 },
      { type: "run_end", runId: "r-fs-4", stopReason: "end_turn", ts: 300 },
    ];
    const items = foldWork(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("trigger");
    expect(items[0].name).toBe("fs #4 watch:/drop");
    expect(items[0].intent).toBe("handle /drop/new.txt");
    expect(items[0].state).toBe("completed");
    expect(items[0].inTokens).toBe(40);
    expect(items[0].model).toBe("claude-sonnet-5");
  });

  it("a plain run_start is not a triggered run — an absent trigger is not an old server", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2 },
    ];
    expect(foldWork(events)).toEqual([]);
  });
});

describe("readReceipt", () => {
  it("reads a workflow launch and its settlement", () => {
    const output = [
      "Workflow launched in background. Task ID: w1mmlxz13",
      "Summary: Deep-read the simulator engine seams",
      "Transcript dir: /tmp/subagents/workflows/wf_eaffae95-a46",
      "",
      "--- task w1mmlxz13 · completed ---",
      "usage: agent_count=24 agents_done=15 agents_error=9 tool_uses=368 duration_ms=613990",
    ].join("\n");
    const r = readReceipt(output);
    expect(r?.taskId).toBe("w1mmlxz13");
    expect(r?.intent).toBe("Deep-read the simulator engine seams");
    expect(r?.status).toBe("completed");
    expect(r?.opaque.agents).toBe(24);
    expect(r?.opaque.agentsError).toBe(9);
    expect(r?.opaque.toolUses).toBe(368);
    expect(r?.opaque.durationMs).toBe(613990);
  });

  it("a launch that never reported back has no status and no counts", () => {
    const output = [
      "Workflow launched in background. Task ID: wstill123",
      "Summary: A workflow that never reported back",
      "",
      "--- task wstill123 · no result by the end of the transcript ---",
    ].join("\n");
    const r = readReceipt(output);
    expect(r?.status).toBeNull();
    expect(r?.opaque.agents).toBeNull();
  });

  it("an output that merely quotes a task id further down is not a launch", () => {
    expect(readReceipt("$ ls\nWorkflow launched in background. Task ID: w1")).toBeNull();
  });

  it("a plain tool output is not a launch", () => {
    expect(readReceipt("42 files")).toBeNull();
  });
});

describe("foldWork · launched background tasks", () => {
  const launch = (settlement: string): RunEvent[] => [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "recon", ts: 1000 },
    { type: "tool_call", agentId: "main", callId: "toolu_A", name: "Workflow", input: {}, ts: 1100 },
    {
      type: "tool_result",
      agentId: "main",
      callId: "toolu_A",
      output: "Workflow launched in background. Task ID: w82qt1zg0\nSummary: Recon the seams",
      isError: false,
      durationMs: 0,
      ts: 1132,
    },
    {
      type: "tool_result",
      agentId: "main",
      callId: "toolu_A",
      output: settlement,
      isError: false,
      durationMs: 600000,
      ts: 601132,
    },
  ];

  it("a launched task is a work item spanning launch to settlement", () => {
    const items = foldWork(
      launch(
        "Workflow launched in background. Task ID: w82qt1zg0\nSummary: Recon the seams\n\n--- task w82qt1zg0 · completed ---\nusage: agent_count=24 tool_uses=368",
      ),
    );
    expect(items).toHaveLength(1);
    const w = items[0];
    expect(w.kind).toBe("launched");
    expect(w.id).toBe("w82qt1zg0");
    expect(w.name).toBe("Workflow");
    expect(w.intent).toBe("Recon the seams");
    expect(w.state).toBe("completed");
    expect(w.firstTs).toBe(1100);
    expect(w.lastTs).toBe(601132);
    expect(w.parentId).toBe("main");
  });

  it("the counts it reports are quoted as opaque, and it has no agent rows", () => {
    const items = foldWork(
      launch(
        "Workflow launched in background. Task ID: w82qt1zg0\nSummary: Recon\n\n--- task w82qt1zg0 · completed ---\nusage: agent_count=24 agents_done=15 tool_uses=368",
      ),
    );
    expect(items[0].opaque?.agents).toBe(24);
    expect(items[0].children).toEqual([]);
    // The claim the panel must never fake: 24 agents were reported and not one
    // of them is in this stream.
    expect(countWork(items)).toBe(1);
  });

  it("a task that never settled stays working", () => {
    const items = foldWork(
      launch(
        "Workflow launched in background. Task ID: w82qt1zg0\nSummary: Recon\n\n--- task w82qt1zg0 · no result by the end of the transcript ---",
      ),
    );
    expect(items[0].state).toBe("working");
  });

  it("an ordinary tool call is not a work item", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "x", ts: 1 },
      { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: {}, ts: 2 },
      {
        type: "tool_result",
        agentId: "main",
        callId: "c1",
        output: "contents",
        isError: false,
        durationMs: 3,
        ts: 3,
      },
    ];
    expect(foldWork(events)).toEqual([]);
  });
});

describe("groupWaves", () => {
  it("overlapping siblings are one wave", () => {
    const waves = groupWaves(foldWork(fanOut(3)));
    expect(waves).toHaveLength(1);
    expect(waves[0].items).toHaveLength(3);
  });

  it("siblings that do not overlap are separate waves", () => {
    const waves = groupWaves(foldWork(fanOut(3, 10_000)));
    expect(waves).toHaveLength(3);
    expect(waves.map((w) => w.items.length)).toEqual([1, 1, 1]);
  });

  it("no items, no waves", () => {
    expect(groupWaves([])).toEqual([]);
  });
});

// Card 177: the run id is the docking point between a row on screen and the
// agent transcripts sitting beside the file.
describe("the run a launch names", () => {
  const receipt = (extra: string): string => `Workflow launched in background. Task ID: wh7szjffr\n${extra}`;

  it("reads the Run ID a Workflow receipt prints", () => {
    const r = readReceipt(receipt("Summary: check the thing\nRun ID: wf_a50345ce-eb8\n"));
    expect(r?.runId).toBe("wf_a50345ce-eb8");
  });

  it("finds it wherever in the receipt it stands", () => {
    // Unlike the task id, the run id is not on the first line — it arrives
    // several lines down, under the transcript dir.
    const r = readReceipt(
      receipt(
        "Transcript dir: /Users/x/.claude/projects/p/s/subagents/workflows/wf_9b45e5d8-8de\n" +
          "Run ID: wf_9b45e5d8-8de\nTo resume: …\n",
      ),
    );
    expect(r?.runId).toBe("wf_9b45e5d8-8de");
  });

  it("stays null for a receipt that names no run", () => {
    // A Monitor launch is a receipt without one, and every older transcript is
    // too. Null means "this row has nothing to dock to", not "no agents".
    expect(readReceipt("Monitor started (task bngwbqf6s, timeout 2100000ms)")?.runId).toBeNull();
    expect(readReceipt(receipt("Summary: no run here\n"))?.runId).toBeNull();
  });

  it("is not fooled by a run id that is not one", () => {
    expect(readReceipt(receipt("Run ID: not-a-workflow-id\n"))?.runId).toBeNull();
  });
});
