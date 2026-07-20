import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildGraph, laneShifts } from "./buildGraph";

describe("buildGraph", () => {
  it("simple run: user -> turn -> tool -> turn -> answer", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "a0", prompt: "Read the README", ts: 1 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 2 },
      { type: "text_delta", agentId: "a0", text: "I am reading ", ts: 3 },
      { type: "text_delta", agentId: "a0", text: "the file.", ts: 4 },
      { type: "tool_call", agentId: "a0", callId: "c1", name: "read_file", input: { path: "README.md" }, ts: 5 },
      { type: "compaction", agentId: "a0", removedTurns: 2, summaryChars: 900, ts: 6 }, // must create no node
      { type: "tool_result", agentId: "a0", callId: "c1", output: "# spectroscope", isError: false, durationMs: 120, ts: 7 },
      { type: "turn_start", agentId: "a0", turn: 2, ts: 8 },
      { type: "text_delta", agentId: "a0", text: "The README starts with # spectroscope.", ts: 9 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 10 },
    ];
    const { nodes, edges } = buildGraph(events);
    expect(nodes.map((n) => n.id)).toEqual(["r1", "r1:a0:turn:1", "c1", "r1:a0:turn:2", "r1:answer"]);
    expect(nodes.map((n) => n.kind)).toEqual(["user", "turn", "tool", "turn", "answer"]);
    expect(nodes.find((n) => n.id === "r1:a0:turn:1")?.detail.text).toBe("I am reading the file.");
    const tool = nodes.find((n) => n.id === "c1")!;
    expect(tool.status).toBe("ok");
    expect(tool.durationMs).toBe(120);
    expect(nodes.find((n) => n.id === "r1:answer")?.detail.text).toContain("# spectroscope");
    expect(nodes.every((n) => !n.running)).toBe(true);
    expect(edges.map((e) => e.id)).toEqual([
      "r1->r1:a0:turn:1", "r1:a0:turn:1->c1", "c1->r1:a0:turn:2", "r1:a0:turn:2->r1:answer",
    ]);
  });

  it("parallel tool fan-out: two calls from one turn, status per result", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r2", agentId: "a0", prompt: "Check two files", ts: 1 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 2 },
      { type: "tool_call", agentId: "a0", callId: "c1", name: "read_file", input: { path: "a.txt" }, ts: 3 },
      { type: "tool_call", agentId: "a0", callId: "c2", name: "read_file", input: { path: "b.txt" }, ts: 4 },
      { type: "tool_result", agentId: "a0", callId: "c2", output: "ERROR: b.txt not found", isError: true, durationMs: 15, ts: 5 },
      { type: "tool_result", agentId: "a0", callId: "c1", output: "Contents of A", isError: false, durationMs: 90, ts: 6 },
      { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 7 },
    ];
    // Intermediate state before the results: both tools pending and running
    const mid = buildGraph(events.slice(0, 4)).nodes.filter((n) => n.kind === "tool");
    expect(mid.map((n) => n.status)).toEqual(["pending", "pending"]);
    expect(mid.every((n) => n.running)).toBe(true);
    const { nodes, edges } = buildGraph(events);
    const ids = edges.map((e) => e.id);
    expect(ids).toContain("r2:a0:turn:1->c1");   // fan out
    expect(ids).toContain("r2:a0:turn:1->c2");
    expect(ids).toContain("c1->r2:answer");      // fan back in
    expect(ids).toContain("c2->r2:answer");
    expect(nodes.find((n) => n.id === "c1")?.status).toBe("ok");
    expect(nodes.find((n) => n.id === "c2")?.status).toBe("error");
  });

  it("subagent tree: child events hang under the subagent node", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r3", agentId: "a0", prompt: "Investigate the repo", ts: 1 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 2 },
      { type: "agent_spawn", agentId: "a1", parentId: "a0", task: "Count the markdown files", ts: 3 },
      { type: "run_start", runId: "r3s", agentId: "a1", parentId: "a0", prompt: "Count the markdown files", ts: 4 },
      { type: "turn_start", agentId: "a1", turn: 1, ts: 5 },
      { type: "tool_call", agentId: "a1", callId: "c9", name: "list_dir", input: { path: "." }, ts: 6 },
      { type: "tool_result", agentId: "a1", callId: "c9", output: "12 files", isError: false, durationMs: 40, ts: 7 },
      { type: "turn_start", agentId: "a1", turn: 2, ts: 8 },
      { type: "text_delta", agentId: "a1", text: "There are 12 markdown files.", ts: 9 },
      { type: "usage", agentId: "a1", inputTokens: 500, outputTokens: 60, ts: 10 },
      { type: "run_end", runId: "r3s", stopReason: "end_turn", ts: 11 },
      { type: "turn_start", agentId: "a0", turn: 2, ts: 12 },
      { type: "text_delta", agentId: "a0", text: "The subagent found 12 files.", ts: 13 },
      { type: "run_end", runId: "r3", stopReason: "end_turn", ts: 14 },
    ];
    const { nodes, edges } = buildGraph(events);
    const sub = nodes.find((n) => n.id === "a1")!;
    expect(sub.kind).toBe("subagent");
    expect(sub.detail.task).toBe("Count the markdown files");
    expect(sub.detail.inputTokens).toBe(500);
    expect(sub.running).toBe(false); // the child's run_end stops the node
    expect(edges.map((e) => e.id)).toEqual([
      "r3->r3:a0:turn:1",
      "r3:a0:turn:1->a1",     // spawn hangs off the parent turn
      "a1->r3s:a1:turn:1",    // the child turn hangs off the subagent node, NOT off a0
      "r3s:a1:turn:1->c9",
      "c9->r3s:a1:turn:2",
      "r3s:a1:turn:2->r3:a0:turn:2", // the finished child chain flows BACK into the parent
      "r3:a0:turn:2->r3:answer",
    ]);
    // The old dangling shape is gone: no direct subagent -> parent-resume edge.
    expect(edges.map((e) => e.id)).not.toContain("a1->r3:a0:turn:2");
  });

  it("fan-out children all converge into the answer (the graph closes at the bottom)", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r10", agentId: "a0", prompt: "Review in parallel", ts: 1 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 2 },
      { type: "agent_spawn", agentId: "bugs", parentId: "a0", task: "find bugs", ts: 3 },
      { type: "agent_spawn", agentId: "perf", parentId: "a0", task: "check perf", ts: 4 },
      { type: "run_start", runId: "r10b", agentId: "bugs", parentId: "a0", prompt: "find bugs", ts: 5 },
      { type: "run_start", runId: "r10p", agentId: "perf", parentId: "a0", prompt: "check perf", ts: 6 },
      { type: "turn_start", agentId: "bugs", turn: 1, ts: 7 },
      { type: "turn_start", agentId: "perf", turn: 1, ts: 8 },
      { type: "text_delta", agentId: "bugs", text: "## Bugs", ts: 9 },
      { type: "text_delta", agentId: "perf", text: "## Perf", ts: 10 },
      { type: "run_end", runId: "r10b", stopReason: "end_turn", ts: 11 },
      { type: "run_end", runId: "r10p", stopReason: "end_turn", ts: 12 },
      { type: "turn_start", agentId: "a0", turn: 2, ts: 13 },
      { type: "text_delta", agentId: "a0", text: "Summary.", ts: 14 },
      { type: "run_end", runId: "r10", stopReason: "end_turn", ts: 15 },
    ];
    const { edges } = buildGraph(events);
    const ids = edges.map((e) => e.id);
    // Both child chains rejoin the parent's next turn ...
    expect(ids).toContain("r10b:bugs:turn:1->r10:a0:turn:2");
    expect(ids).toContain("r10p:perf:turn:1->r10:a0:turn:2");
    // ... not the subagent nodes directly.
    expect(ids).not.toContain("bugs->r10:a0:turn:2");
    expect(ids).not.toContain("perf->r10:a0:turn:2");
    // And the run still closes into the answer node at the bottom.
    expect(ids).toContain("r10:a0:turn:2->r10:answer");
  });

  it("laneShifts: sequentially stacked subagent subtrees move into their own lanes", () => {
    // Two children whose subtrees dagre put into the SAME x-band (sequential
    // spawns), main spine to the left: the second subtree shifts right.
    const nodes = [
      { agentId: "main", kind: "user" as const, x: 100 },
      { agentId: "main", kind: "turn" as const, x: 100 },
      { agentId: "w1", kind: "subagent" as const, x: 400 },
      { agentId: "w1", kind: "turn" as const, x: 400 },
      { agentId: "main", kind: "turn" as const, x: 100 },
      { agentId: "w2", kind: "subagent" as const, x: 400 },
      { agentId: "w2", kind: "turn" as const, x: 420 },
      { agentId: "main", kind: "answer" as const, x: 100 },
    ];
    const shifts = laneShifts(nodes, 220, 48);
    expect(shifts.has("w1")).toBe(false); // first lane stays where dagre put it
    const dx = shifts.get("w2");
    expect(dx).toBeDefined();
    // w2's band starts at 400; w1's band ends at 400+220 → shifted past it + gap.
    expect(400 + (dx ?? 0)).toBeGreaterThanOrEqual(400 + 220 + 48);
  });

  it("laneShifts: truly parallel branches that dagre already spread stay put", () => {
    const nodes = [
      { agentId: "main", kind: "turn" as const, x: 300 },
      { agentId: "bugs", kind: "subagent" as const, x: 40 },
      { agentId: "bugs", kind: "turn" as const, x: 40 },
      { agentId: "perf", kind: "subagent" as const, x: 560 },
      { agentId: "perf", kind: "turn" as const, x: 560 },
    ];
    expect(laneShifts(nodes, 220, 48).size).toBe(0);
  });

  it("a child ending right before run_end joins the answer directly", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r11", agentId: "a0", prompt: "Delegate then stop", ts: 1 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 2 },
      { type: "agent_spawn", agentId: "w1", parentId: "a0", task: "do it", ts: 3 },
      { type: "run_start", runId: "r11w", agentId: "w1", parentId: "a0", prompt: "do it", ts: 4 },
      { type: "turn_start", agentId: "w1", turn: 1, ts: 5 },
      { type: "text_delta", agentId: "w1", text: "done", ts: 6 },
      { type: "run_end", runId: "r11w", stopReason: "end_turn", ts: 7 },
      { type: "run_end", runId: "r11", stopReason: "end_turn", ts: 8 },
    ];
    const { edges } = buildGraph(events);
    expect(edges.map((e) => e.id)).toContain("r11w:w1:turn:1->r11:answer");
  });

  it("carries timing, previews, tokens and the raw events on each node", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r9", agentId: "a0", prompt: "Inspect the build file", ts: 1000 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 1500 },
      { type: "text_delta", agentId: "a0", text: "Reading ", ts: 1600 },
      { type: "text_delta", agentId: "a0", text: "the build file now.", ts: 1700 },
      { type: "tool_call", agentId: "a0", callId: "c1", name: "read_file", input: { path: "build.gradle.kts" }, ts: 2000 },
      { type: "permission_request", agentId: "a0", callId: "c1", name: "read_file", input: { path: "build.gradle.kts" }, ts: 2050 },
      { type: "permission_decision", callId: "c1", allowed: true, ts: 2100 },
      { type: "tool_result", agentId: "a0", callId: "c1", output: "plugins { }", isError: false, durationMs: 400, ts: 2500 },
      { type: "turn_start", agentId: "a0", turn: 2, ts: 2600 },
      { type: "text_delta", agentId: "a0", text: "The build file declares no plugins.", ts: 2700 },
      { type: "usage", agentId: "a0", inputTokens: 120, outputTokens: 30, ts: 2800 },
      { type: "run_end", runId: "r9", stopReason: "end_turn", ts: 3310 },
    ];
    const { nodes } = buildGraph(events);

    const user = nodes.find((n) => n.kind === "user")!;
    expect(user.startTs).toBe(1000);
    expect(user.relMs).toBe(0); // the prompt IS the t+ origin
    expect(user.events).toEqual([events[0]]);

    const turn1 = nodes.find((n) => n.id === "r9:a0:turn:1")!;
    expect(turn1.relMs).toBe(500);
    expect(turn1.durationMs).toBe(200); // last delta (1700) - turn_start (1500)
    expect(turn1.preview).toBe("Reading the build file now.");
    expect(turn1.events.map((e) => e.type)).toEqual(["turn_start", "text_delta", "text_delta"]);

    const turn2 = nodes.find((n) => n.id === "r9:a0:turn:2")!;
    expect(turn2.tokens).toEqual({ input: 120, output: 30 }); // usage lands on the active turn

    const tool = nodes.find((n) => n.id === "c1")!;
    expect(tool.relMs).toBe(1000);
    expect(tool.preview).toBe('{"path":"build.gradle.kts"}');
    // The full approval story is part of the tool node's evidence.
    expect(tool.events.map((e) => e.type)).toEqual([
      "tool_call", "permission_request", "permission_decision", "tool_result",
    ]);

    const answer = nodes.find((n) => n.kind === "answer")!;
    expect(answer.relMs).toBe(2310);
    expect(answer.preview).toBe("The build file declares no plugins.");
    expect(answer.events.map((e) => e.type)).toEqual(["text_delta", "run_end"]);
  });

  it("caps the stored turn deltas at 50 and counts the overflow", () => {
    const deltas: RunEvent[] = Array.from({ length: 60 }, (_, i) =>
      ({ type: "text_delta", agentId: "a0", text: "x", ts: 20 + i }) as RunEvent,
    );
    const events: RunEvent[] = [
      { type: "run_start", runId: "r8", agentId: "a0", prompt: "chatty", ts: 1 },
      { type: "turn_start", agentId: "a0", turn: 1, ts: 10 },
      ...deltas,
      { type: "run_end", runId: "r8", stopReason: "end_turn", ts: 100 },
    ];
    const { nodes } = buildGraph(events);

    const turn = nodes.find((n) => n.kind === "turn")!;
    expect(turn.events.filter((e) => e.type === "text_delta")).toHaveLength(50);
    expect(turn.droppedEvents).toBe(10);
    expect(turn.detail.text).toHaveLength(60); // the aggregated text is NOT capped
    expect(turn.durationMs).toBe(69); // last delta (79) - turn_start (10)

    const answer = nodes.find((n) => n.kind === "answer")!;
    expect(answer.events).toHaveLength(51); // 50 deltas + run_end
    expect(answer.droppedEvents).toBe(10);
  });

  it("restarts the t+ clock on every prompt of the session", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r6", agentId: "main", prompt: "First", ts: 1000 },
      { type: "turn_start", agentId: "main", turn: 1, ts: 1200 },
      { type: "run_end", runId: "r6", stopReason: "end_turn", ts: 1500 },
      { type: "run_start", runId: "r7", agentId: "main", prompt: "Second", ts: 60000 },
      { type: "turn_start", agentId: "main", turn: 1, ts: 60300 },
      { type: "run_end", runId: "r7", stopReason: "end_turn", ts: 61000 },
    ];
    const { nodes } = buildGraph(events);
    expect(nodes.find((n) => n.id === "r6:main:turn:1")?.relMs).toBe(200);
    expect(nodes.find((n) => n.id === "r7:main:turn:1")?.relMs).toBe(300); // not 59300
    expect(nodes.find((n) => n.id === "r7")?.relMs).toBe(0);
  });

  it("two prompts in one session: two user nodes, no duplicate ids", () => {
    // agentId stays stable per agent instance ("main"); the turn counter restarts
    // at 1 in every run() — that is exactly what the runId namespace is for.
    const events: RunEvent[] = [
      { type: "run_start", runId: "r4", agentId: "main", prompt: "First prompt", ts: 1 },
      { type: "turn_start", agentId: "main", turn: 1, ts: 2 },
      { type: "text_delta", agentId: "main", text: "First answer.", ts: 3 },
      { type: "run_end", runId: "r4", stopReason: "end_turn", ts: 4 },
      { type: "run_start", runId: "r5", agentId: "main", prompt: "Second prompt", ts: 5 },
      { type: "turn_start", agentId: "main", turn: 1, ts: 6 }, // turn 1 again!
      { type: "text_delta", agentId: "main", text: "Second answer.", ts: 7 },
      { type: "run_end", runId: "r5", stopReason: "end_turn", ts: 8 },
    ];
    const { nodes, edges } = buildGraph(events);
    expect(nodes.filter((n) => n.kind === "user").map((n) => n.id)).toEqual(["r4", "r5"]);
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate node ids
    expect(ids).toContain("r4:main:turn:1");
    expect(ids).toContain("r5:main:turn:1");
    expect(edges.map((e) => e.id)).toContain("r4:answer->r5"); // second prompt hangs off the first answer
  });
});
