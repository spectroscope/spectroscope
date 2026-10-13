import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { read } from "../testkit/source";
import {
  currentEntry,
  foldRun,
  isUnfinished,
  nodeStatuses,
  runOutcome,
  runningChatEntryKey,
  type RunTrack,
} from "./runView";

const R = "abcdefabcdef";
let ts = 0;
const ev = (e: Record<string, unknown>): RunEvent => ({ ts: ++ts, ...e }) as unknown as RunEvent;
const step = (phase: string, node: string, more: Record<string, unknown> = {}): RunEvent =>
  ev({
    type: "run_step",
    agentId: "playbook",
    runId: R,
    runKind: "playbook",
    phase,
    node,
    name: node,
    kind: "step",
    entry: 1,
    ...more,
  });
const fold = (events: RunEvent[]): RunTrack[] => events.reduce(foldRun, [] as RunTrack[]);
const start = ev({
  type: "run_step",
  agentId: "playbook",
  runId: R,
  runKind: "playbook",
  phase: "run_start",
  name: "spectro",
  task: "baue Frogger",
  nodes: [
    { id: "brainstorm", name: "Brainstorm", kind: "step" },
    { id: "spec_ok", name: "Spec ok", kind: "decision" },
    { id: "build", name: "Build", kind: "step" },
  ],
});

describe("the run fold (card 586)", () => {
  it("opens a run and an entry, closes it with its output and documents", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", {
        performer: "chat",
        provider: "anthropic",
        model: "claude-opus-5-5",
        input: "Playbook spectro, step Brainstorm",
      }),
      step("step_end", "brainstorm", {
        status: "done",
        durationMs: 1200,
        output: "spec written",
        documents: [{ doc: "spec", path: ".superpowers/spec.md", change: "created" }],
      }),
    ]);
    expect(runs).toHaveLength(1);
    const e = runs[0].entries[0];
    expect(e.key).toBe(`${R}:brainstorm:1`);
    expect(e.status).toBe("done");
    expect(e.output).toBe("spec written");
    expect(e.documents[0].path).toBe(".superpowers/spec.md");
    expect(e.agents).toEqual(["main"]);
  });

  it("joins the file writes of a chat step and keeps created when the file is changed again", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({
        type: "tool_call",
        agentId: "main",
        callId: "c1",
        name: "write_file",
        input: { path: "a.md", content: "x" },
      }),
      ev({
        type: "tool_result",
        agentId: "main",
        callId: "c1",
        output: "Wrote: a.md",
        isError: false,
        fileChange: "created",
      }),
      ev({
        type: "tool_call",
        agentId: "main",
        callId: "c2",
        name: "edit_file",
        input: { path: "a.md", old_string: "x", new_string: "y" },
      }),
      ev({
        type: "tool_result",
        agentId: "main",
        callId: "c2",
        output: "Edited: a.md",
        isError: false,
        fileChange: "changed",
      }),
      ev({
        type: "tool_call",
        agentId: "main",
        callId: "c3",
        name: "write_file",
        input: { path: "denied.md", content: "x" },
      }),
      ev({ type: "tool_result", agentId: "main", callId: "c3", output: "denied", isError: true }),
      ev({
        type: "tool_call",
        agentId: "main",
        callId: "c4",
        name: "run_command",
        input: { command: "touch b" },
      }),
    ]);
    const e = runs[0].entries[0];
    expect(e.files).toEqual([{ path: "a.md", change: "created" }]);
    expect(e.shellCalls).toBe(1);
  });

  it("gives a child step its child and the child's descendants", () => {
    const runs = fold([
      start,
      step("step_start", "build", { performer: "child", role: "worker" }),
      ev({
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        state: "submitted",
        text: "t",
        label: "playbook:build",
      }),
      ev({ type: "agent_spawn", agentId: "explore-1", parentId: "worker-1", task: "look" }),
      ev({
        type: "tool_call",
        agentId: "explore-1",
        callId: "c9",
        name: "write_file",
        input: { path: "deep.md", content: "x" },
      }),
      ev({
        type: "tool_result",
        agentId: "explore-1",
        callId: "c9",
        output: "Wrote",
        isError: false,
        fileChange: "created",
      }),
    ]);
    const e = runs[0].entries[0];
    expect(e.agents).toEqual(["worker-1", "explore-1"]);
    expect(e.files.map((f) => f.path)).toEqual(["deep.md"]);
  });

  it("shows the live line, then waiting while the run asks, then running again", () => {
    let runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "text_delta", agentId: "main", text: "first line\nsecond li" }),
    ]);
    expect(runs[0].entries[0].liveLine).toBe("second li");
    runs = [ev({ type: "question_asked", agentId: "main", callId: `pb-${R}-1`, questions: [] })].reduce(
      foldRun,
      runs,
    );
    expect(runs[0].entries[0].status).toBe("waiting");
    runs = [ev({ type: "question_answered", callId: `pb-${R}-1`, answers: [] })].reduce(foldRun, runs);
    expect(runs[0].entries[0].status).toBe("running");
  });

  it("marks loops as entries, the never entered nodes skipped at the end, and stops a still running entry", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_end", "brainstorm", { status: "done" }),
      step("step_start", "spec_ok", { kind: "decision", maxRounds: 2, round: 1 }),
      ev({
        type: "run_step",
        agentId: "playbook",
        runId: R,
        runKind: "playbook",
        phase: "run_end",
        stopReason: "aborted",
      }),
    ]);
    const statuses = nodeStatuses(runs[0]);
    expect(statuses.brainstorm).toBe("done");
    expect(statuses.spec_ok).toBe("stopped");
    expect(statuses.build).toBe("skipped");
  });

  it("keeps two runs apart, the latest current", () => {
    const other = "bbbbbbbbbbbb";
    const runs = fold([
      start,
      ev({
        type: "run_step",
        agentId: "playbook",
        runId: R,
        runKind: "playbook",
        phase: "run_end",
        stopReason: "done",
      }),
      ev({
        type: "run_step",
        agentId: "playbook",
        runId: other,
        runKind: "workflow",
        phase: "run_start",
        name: "fanout-review",
        nodes: [],
      }),
      ev({
        type: "run_step",
        agentId: "playbook",
        runId: other,
        runKind: "workflow",
        phase: "step_start",
        node: "diff",
        name: "diff",
        kind: "prompt",
        entry: 1,
        performer: "chat",
      }),
    ]);
    expect(runs.map((r) => r.runId)).toEqual([R, other]);
    expect(currentEntry(runs[1])?.key).toBe(`${other}:diff:1`);
    expect(runningChatEntryKey(runs)).toBe(`${other}:diff:1`);
  });

  it("says a stored run without an end is unfinished only when the session is not live", () => {
    const runs = fold([start, step("step_start", "brainstorm", { performer: "chat" })]);
    expect(isUnfinished(runs[0], false)).toBe(true);
    expect(isUnfinished(runs[0], true)).toBe(false);
  });

  it("returns the same array for an event that touches no run", () => {
    const runs: RunTrack[] = [];
    expect(foldRun(runs, ev({ type: "text_delta", agentId: "main", text: "x" }))).toBe(runs);
  });
});

// The fold's further rules, and what the server sends as measured in tasks 3
// to 5 of the card, where it differs from the plan.

const runEnd = (more: Record<string, unknown> = {}): RunEvent =>
  ev({ type: "run_step", agentId: "playbook", runId: R, runKind: "playbook", phase: "run_end", ...more });
const asked = (callId: string): RunEvent =>
  ev({ type: "question_asked", agentId: "main", callId, questions: [] });
const answered = (callId: string, cancelled = false): RunEvent =>
  ev({ type: "question_answered", callId, answers: cancelled ? [] : ["retry"], cancelled });
/** A file tool's call and its result; no change word when `change` is undefined. */
const wrote = (agentId: string, callId: string, path: string, change?: string): RunEvent[] => [
  ev({ type: "tool_call", agentId, callId, name: "write_file", input: { path, content: "x" } }),
  ev({
    type: "tool_result",
    agentId,
    callId,
    output: "Wrote",
    isError: false,
    ...(change === undefined ? {} : { fileChange: change }),
  }),
];

describe("the joins of a running entry (card 586)", () => {
  it("joins nothing into an entry that has ended", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ...wrote("main", "c1", "a.md", "created"),
      ev({ type: "text_delta", agentId: "main", text: "while it runs" }),
      step("step_end", "brainstorm", { status: "done" }),
      ...wrote("main", "c2", "b.md", "created"),
      ev({ type: "text_delta", agentId: "main", text: "\nafter its end" }),
      ev({ type: "tool_call", agentId: "main", callId: "c3", name: "run_command", input: { command: "ls" } }),
    ]);
    const e = runs[0].entries[0];
    expect(e.files).toEqual([{ path: "a.md", change: "created" }]);
    expect(e.liveLine).toBe("while it runs");
    expect(e.shellCalls).toBe(0);
  });

  it("joins no agent outside the entry", () => {
    const runs = fold([
      start,
      step("step_start", "build", { performer: "child", role: "worker" }),
      ev({
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        state: "submitted",
        text: "t",
        label: "playbook:build",
      }),
      ...wrote("worker-1", "c1", "mine.md", "created"),
      ...wrote("explore-9", "c2", "theirs.md", "created"),
      ev({ type: "agent_spawn", agentId: "explore-9", parentId: "main", task: "elsewhere" }),
      ev({ type: "text_delta", agentId: "worker-1", text: "mine" }),
      ev({ type: "text_delta", agentId: "explore-9", text: "\ntheirs" }),
      ev({ type: "tool_call", agentId: "worker-1", callId: "c3", name: "Bash", input: { command: "ls" } }),
      ev({ type: "tool_call", agentId: "explore-9", callId: "c4", name: "Bash", input: { command: "ls" } }),
    ]);
    const e = runs[0].entries[0];
    expect(e.files).toEqual([{ path: "mine.md", change: "created" }]);
    expect(e.agents).toEqual(["worker-1"]);
    expect(e.liveLine).toBe("mine");
    expect(e.shellCalls).toBe(1);
  });

  it("reads an imported Write by its file_path, a result without a change word as unknown, and Bash as shell", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({
        type: "tool_call",
        agentId: "main",
        callId: "w1",
        name: "Write",
        input: { file_path: "/w/x.md", content: "x" },
      }),
      ev({ type: "tool_result", agentId: "main", callId: "w1", output: "ok", isError: false }),
      ev({ type: "tool_call", agentId: "main", callId: "w2", name: "Bash", input: { command: "ls" } }),
    ]);
    const e = runs[0].entries[0];
    expect(e.files).toEqual([{ path: "/w/x.md", change: "unknown" }]);
    expect(e.shellCalls).toBe(1);
  });

  it("takes the last change word of a file that was not created in the step", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ...wrote("main", "c1", "a.md", "changed"),
      ...wrote("main", "c2", "a.md", "unchanged"),
    ]);
    expect(runs[0].entries[0].files).toEqual([{ path: "a.md", change: "unchanged" }]);
  });

  it("lists a fan-out's helpers as its children while it runs, and the children its end names", () => {
    const W = "cccccccccccc";
    const line = (phase: string, more: Record<string, unknown> = {}): RunEvent =>
      ev({ type: "run_step", agentId: "playbook", runId: W, runKind: "workflow", phase, ...more });
    const fan = { node: "review", name: "review", kind: "fanout", entry: 1 };
    let runs = fold([
      line("run_start", { name: "fanout-review", nodes: [{ id: "review", name: "review", kind: "fanout" }] }),
      line("step_start", { ...fan, performer: "child" }),
      ev({
        type: "agent_message",
        from: "main",
        to: "explore-3",
        role: "task",
        state: "submitted",
        text: "sum up",
        label: "workflow:review",
      }),
      ev({ type: "agent_spawn", agentId: "explore-4", parentId: "explore-3", task: "look" }),
    ]);
    expect(runs[0].entries[0].agents).toEqual(["explore-3", "explore-4"]);
    expect(runs[0].entries[0].children).toEqual(["explore-4"]);
    runs = [
      line("step_end", { ...fan, status: "done", children: ["explore-1", "explore-2", "explore-3"] }),
    ].reduce(foldRun, runs);
    expect(runs[0].entries[0].children).toEqual(["explore-1", "explore-2", "explore-3"]);
  });

  it("follows the live line across deltas and keeps at most 2,000 characters", () => {
    let runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "text_delta", agentId: "main", text: " \n" }),
    ]);
    expect(runs[0].entries[0].liveLine).toBeNull();
    runs = [
      ev({ type: "text_delta", agentId: "main", text: "one\n" }),
      ev({ type: "text_delta", agentId: "main", text: "two" }),
    ].reduce(foldRun, runs);
    expect(runs[0].entries[0].liveLine).toBe("two");
    runs = [ev({ type: "text_delta", agentId: "main", text: "\n\n" })].reduce(foldRun, runs);
    expect(runs[0].entries[0].liveLine).toBe("two");
    runs = [ev({ type: "text_delta", agentId: "main", text: "x".repeat(2_500) })].reduce(foldRun, runs);
    expect(runs[0].entries[0].liveLine).toBe("x".repeat(2_000));
  });

  it("never starts the live line with half of a surrogate pair", () => {
    const pair = "\u{1F600}";
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "text_delta", agentId: "main", text: pair.repeat(1_000) + "x" }),
    ]);
    expect(runs[0].entries[0].liveLine).toBe(pair.repeat(999) + "x");
  });

  it("returns the same array for an event that changes nothing in a live run", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "tool_call", agentId: "main", callId: "c1", name: "write_file", input: { path: "a.md" } }),
    ]);
    for (const event of [
      ev({ type: "text_delta", agentId: "main", text: "" }),
      ev({ type: "text_delta", agentId: "explore-9", text: "not in the entry" }),
      ev({ type: "tool_call", agentId: "main", callId: "c1", name: "write_file", input: { path: "a.md" } }),
      ev({ type: "tool_call", agentId: "main", callId: "c2", name: "read_file", input: { path: "a.md" } }),
      ev({ type: "tool_result", agentId: "main", callId: "c2", output: "x", isError: false }),
      ev({ type: "agent_spawn", agentId: "explore-9", parentId: "worker-7", task: "t" }),
      ev({ type: "question_answered", callId: `pb-${R}-1`, answers: [], cancelled: true }),
    ]) {
      expect(foldRun(runs, event), event.type).toBe(runs);
    }
    expect(foldRun(runs, ev({ type: "text_delta", agentId: "main", text: "x" }))).not.toBe(runs);
  });
});

describe("the run's own fields as the server sends them (card 586)", () => {
  it("keeps a read without a path as a name beside a read with one", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", {
        performer: "chat",
        reads: [{ doc: "ticket" }, { doc: "spec", path: ".superpowers/spec.md" }],
      }),
    ]);
    expect(runs[0].entries[0].reads).toEqual([
      { doc: "ticket" },
      { doc: "spec", path: ".superpowers/spec.md" },
    ]);
  });

  it("takes a run without a task, and a step without a round, as null", () => {
    const runs = fold([
      ev({
        type: "run_step",
        agentId: "playbook",
        runId: R,
        runKind: "workflow",
        phase: "run_start",
        name: "review",
        nodes: [{ id: "diff", name: "diff", kind: "prompt" }],
      }),
      step("step_start", "diff", { runKind: "workflow", kind: "prompt", performer: "chat" }),
    ]);
    expect(runs[0]).toMatchObject({ kind: "workflow", name: "review", task: null });
    expect(runs[0].entries[0]).toMatchObject({ kind: "prompt", round: null, maxRounds: null, picked: false });
  });

  it("copies the fields of a step's start and end onto its entry", () => {
    const runs = fold([
      start,
      step("step_start", "build", {
        performer: "child",
        role: "worker",
        provider: "ollama",
        model: "qwen2.5:7b",
        picked: true,
        input: "Build it",
        inputChars: 9_000,
      }),
      step("step_end", "build", {
        status: "failed",
        durationMs: 4_200,
        childId: "worker-1",
        output: "half done",
        outputChars: 7_000,
        error: "build: the tests are red",
        documents: [
          { doc: "spec", path: "docs/spec.md", change: "created" },
          { doc: "notes", path: "docs/notes.md" },
        ],
      }),
    ]);
    const e = runs[0].entries[0];
    expect(e.documents).toEqual([
      { doc: "spec", path: "docs/spec.md", change: "created" },
      { doc: "notes", path: "docs/notes.md" },
    ]);
    expect(e).toMatchObject({
      name: "build",
      kind: "step",
      performer: "child",
      role: "worker",
      provider: "ollama",
      model: "qwen2.5:7b",
      picked: true,
      input: "Build it",
      inputChars: 9_000,
      status: "failed",
      durationMs: 4_200,
      output: "half done",
      outputChars: 7_000,
      error: "build: the tests are red",
      label: null,
      agents: ["worker-1"],
    });
    expect(e.endedTs).toBeGreaterThan(e.startedTs);
  });

  it("folds lines that carry only the fields every line has, and keeps a round only the start named", () => {
    const bare = (phase: string, more: Record<string, unknown> = {}): RunEvent =>
      ev({ type: "run_step", agentId: "playbook", runId: R, runKind: "playbook", phase, ...more });
    const runs = fold([
      bare("run_start", { nodes: [{ id: "x", kind: "step" }] }),
      bare("step_start"),
      bare("step_start", { node: "x", round: 2, maxRounds: 5 }),
      bare("step_end", { node: "x" }),
    ]);
    expect(runs[0]).toMatchObject({ name: "", task: null, nodes: [{ id: "x", name: "x", kind: "step" }] });
    expect(runs[0].entries.map((e) => e.key)).toEqual([`${R}:x:1`]);
    expect(runs[0].entries[0]).toMatchObject({
      name: "x",
      kind: "",
      entry: 1,
      status: "failed",
      performer: null,
      agents: [],
      round: 2,
      maxRounds: 5,
    });
  });

  it("adds the child its end names to the agents once", () => {
    const runs = fold([
      start,
      step("step_start", "build", { performer: "child", role: "worker" }),
      ev({
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        state: "submitted",
        text: "t",
        label: "playbook:build",
      }),
      step("step_end", "build", { status: "done", childId: "worker-1" }),
    ]);
    expect(runs[0].entries[0].agents).toEqual(["worker-1"]);
  });

  it("folds an exhausted decision as sent: round 3, ceiling 2, label exhausted", () => {
    const decision = { kind: "decision", entry: 3, round: 3, maxRounds: 2 };
    const runs = fold([
      start,
      step("step_start", "spec_ok", decision),
      step("step_end", "spec_ok", { ...decision, status: "done", label: "exhausted" }),
    ]);
    expect(runs[0].entries[0]).toMatchObject({
      key: `${R}:spec_ok:3`,
      status: "done",
      round: 3,
      maxRounds: 2,
      label: "exhausted",
    });
  });

  it("ignores a step_end without its step_start", () => {
    let runs = fold([start, step("step_start", "brainstorm", { performer: "chat" })]);
    runs = [step("step_end", "brainstorm", { entry: 2, status: "done" })].reduce(foldRun, runs);
    expect(runs[0].entries.map((e) => [e.key, e.status])).toEqual([[`${R}:brainstorm:1`, "running"]]);
    runs = [step("step_end", "brainstorm", { status: "done" })].reduce(foldRun, runs);
    expect(runs[0].entries.map((e) => [e.key, e.status])).toEqual([[`${R}:brainstorm:1`, "done"]]);
  });

  it("closes a still running entry at the time of the run's end", () => {
    const end = runEnd({ stopReason: "aborted", durationMs: 900 });
    const runs = fold([start, step("step_start", "brainstorm", { performer: "chat" }), end]);
    expect(runs[0].entries[0]).toMatchObject({ status: "stopped", endedTs: end.ts });
    expect(runs[0]).toMatchObject({ endedTs: end.ts, durationMs: 900, stopReason: "aborted" });
  });
});

describe("the run waits while a question of the run is open (card 586)", () => {
  it("waits as a run while a step's model question comes before its step_start, until the answer", () => {
    let runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_end", "brainstorm", { status: "done" }),
    ]);
    expect(runs[0].waitingOn).toBeNull();
    runs = [asked(`pb-${R}-1`)].reduce(foldRun, runs);
    expect(runs[0].waitingOn).toBe(`pb-${R}-1`);
    expect(runs[0].entries[0].status).toBe("done");
    runs = [answered(`pb-${R}-1`)].reduce(foldRun, runs);
    expect(runs[0].waitingOn).toBeNull();
  });

  it("stops waiting as a run when the next step starts", () => {
    let runs = fold([start, asked(`pb-${R}-1`)]);
    expect(runs[0].waitingOn).toBe(`pb-${R}-1`);
    runs = [step("step_start", "brainstorm", { performer: "chat" })].reduce(foldRun, runs);
    expect(runs[0].waitingOn).toBeNull();
    expect(runs[0].entries[0].status).toBe("running");
  });

  it("takes only the questions of its own run, and only the answer to the open one", () => {
    let runs = fold([start, asked("toolu_1"), asked("pb-bbbbbbbbbbbb-1")]);
    expect(runs[0].waitingOn).toBeNull();
    runs = [asked(`pb-${R}-2`), answered(`pb-${R}-1`)].reduce(foldRun, runs);
    expect(runs[0].waitingOn).toBe(`pb-${R}-2`);
  });

  it("keeps an entry running on a question that is not the run's", () => {
    let runs = fold([start, step("step_start", "brainstorm", { performer: "chat" }), asked("toolu_1")]);
    expect(runs[0].entries[0].status).toBe("running");
    runs = [asked(`pb-${R}-1`)].reduce(foldRun, runs);
    expect(runs[0].entries[0].status).toBe("waiting");
    expect(runs[0].waitingOn).toBeNull();
  });

  it("waits on nothing once the run has ended", () => {
    const runs = fold([start, asked(`pb-${R}-1`), runEnd({ stopReason: "model_unavailable" })]);
    expect(runs[0].waitingOn).toBeNull();
    expect(runs[0].stopReason).toBe("model_unavailable");
  });
});

describe("a run's outcome comes from its run_end alone (card 586)", () => {
  /** Every stop reason the runners know, read off the Java side: RunStop's constants and the workflow's exhausted. */
  const REASONS = (() => {
    const java = (rel: string): string =>
      read(`../../../spectro-core/src/main/java/dev/spectroscope/core/${rel}`, import.meta.url);
    const stops = [
      ...java("playbook/run/RunStop.java").matchAll(/static final String (\w+) = "([a-z_]+)"/g),
    ].map((m) => [m[1], m[2]]);
    const workflow = java("playbook/run/WorkflowRunner.java").match(
      /static final String EXHAUSTED = "([a-z_]+)"/,
    );
    if (workflow === null) throw new Error("WorkflowRunner.java no longer declares EXHAUSTED");
    return new Map([
      ...stops.map(([name, value]) => [name, value] as const),
      ["EXHAUSTED", workflow[1]] as const,
    ]);
  })();

  it("is running while no run_end has come", () => {
    expect(runOutcome(fold([start])[0])).toBe("running");
  });

  it("reads the runners' done as done and their aborted as stopped", () => {
    expect(REASONS.get("DONE")).toBe("done");
    expect(REASONS.get("ABORTED")).toBe("aborted");
    expect(runOutcome(fold([start, runEnd({ stopReason: "done" })])[0])).toBe("done");
    expect(runOutcome(fold([start, runEnd({ stopReason: "aborted" })])[0])).toBe("stopped");
  });

  it("reads every other reason the runners know as failed", () => {
    const others = [...REASONS].filter(([name]) => name !== "DONE" && name !== "ABORTED");
    expect(others.length).toBeGreaterThanOrEqual(10);
    for (const [name, reason] of others) {
      expect(runOutcome(fold([start, runEnd({ stopReason: reason })])[0]), name).toBe("failed");
    }
  });

  it("reads a run_end without a reason as failed", () => {
    expect(runOutcome(fold([start, runEnd()])[0])).toBe("failed");
  });

  it("says failed when a Stop during the model question closed the entry as stopped", () => {
    const runs = fold([
      start,
      asked(`pb-${R}-1`),
      answered(`pb-${R}-1`, true),
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_end", "brainstorm", { status: "stopped", error: "brainstorm: no model answers" }),
      runEnd({ stopReason: "model_unavailable" }),
    ]);
    expect(runs[0].entries[0].status).toBe("stopped");
    expect(runOutcome(runs[0])).toBe("failed");
  });
});

describe("the readers of a run (card 586)", () => {
  it("shows a node by its latest entry, and a node not yet entered as pending while the run lives", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_end", "brainstorm", { status: "done" }),
      step("step_start", "spec_ok", { kind: "decision", round: 1, maxRounds: 2 }),
      step("step_end", "spec_ok", {
        kind: "decision",
        status: "done",
        label: "changes",
        round: 1,
        maxRounds: 2,
      }),
      step("step_start", "brainstorm", { performer: "chat", entry: 2 }),
    ]);
    expect(nodeStatuses(runs[0])).toEqual({ brainstorm: "running", spec_ok: "done", build: "pending" });
    expect(runs[0].entries.map((e) => e.key)).toEqual([
      `${R}:brainstorm:1`,
      `${R}:spec_ok:1`,
      `${R}:brainstorm:2`,
    ]);
  });

  it("names the open entry current, else the last entry, else none", () => {
    expect(currentEntry(fold([start])[0])).toBeNull();
    const ended = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_end", "brainstorm", { status: "done" }),
    ]);
    expect(currentEntry(ended[0])?.key).toBe(`${R}:brainstorm:1`);
    const waiting = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_start", "spec_ok", { kind: "decision" }),
      step("step_end", "spec_ok", { kind: "decision", status: "done", label: "ok" }),
      asked(`pb-${R}-1`),
    ]);
    expect(waiting[0].entries[0].status).toBe("waiting");
    expect(currentEntry(waiting[0])?.key).toBe(`${R}:brainstorm:1`);
  });

  it("names the running chat entry of the last run only", () => {
    expect(runningChatEntryKey([])).toBeNull();
    expect(
      runningChatEntryKey(fold([start, step("step_start", "build", { performer: "child", role: "worker" })])),
    ).toBeNull();
    expect(runningChatEntryKey(fold([start, step("step_start", "brainstorm", { performer: "chat" })]))).toBe(
      `${R}:brainstorm:1`,
    );
  });
});

describe("the helpers of a fan-out and the live line per agent (card 586, task 7)", () => {
  const W = "dddddddddddd";
  const line = (phase: string, more: Record<string, unknown> = {}): RunEvent =>
    ev({ type: "run_step", agentId: "playbook", runId: W, runKind: "workflow", phase, ...more });
  const opened = (): RunEvent[] => [
    line("run_start", {
      name: "fanout-review",
      nodes: [
        { id: "draft", name: "draft", kind: "prompt" },
        { id: "review", name: "review", kind: "fanout" },
      ],
    }),
  ];
  const fan = { node: "review", name: "review", kind: "fanout", entry: 1 };
  const helperTask = (to: string): RunEvent =>
    ev({ type: "agent_message", from: "main", to, role: "task", state: "submitted", text: "look" });

  it("joins a helper the run spawns without a label into the open fan-out, before its end", () => {
    const runs = fold([
      ...opened(),
      line("step_start", { ...fan, performer: "child" }),
      ev({ type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "look" }),
      helperTask("explore-1"),
      ...wrote("explore-1", "c1", "notes.md", "created"),
      ev({ type: "text_delta", agentId: "explore-1", text: "reading the spec" }),
    ]);
    const e = runs[0].entries[0];
    expect(e.status).toBe("running");
    expect(e.agents).toEqual(["explore-1"]);
    expect(e.children).toEqual(["explore-1"]);
    expect(e.files).toEqual([{ path: "notes.md", change: "created" }]);
    expect(e.liveLine).toBe("reading the spec");
  });

  it("takes a helper with a label through its label only, not as a helper of the fan-out", () => {
    const runs = fold([
      ...opened(),
      line("step_start", { ...fan, performer: "child" }),
      ev({
        type: "agent_message",
        from: "main",
        to: "explore-7",
        role: "task",
        state: "submitted",
        text: "sum up",
        label: "workflow:other",
      }),
    ]);
    expect(runs[0].entries[0].agents).toEqual([]);
  });

  it("changes nothing for such a helper while no fan-out is open", () => {
    const ended = fold([
      ...opened(),
      line("step_start", { node: "draft", name: "draft", kind: "prompt", entry: 1, performer: "chat" }),
      line("step_end", { node: "draft", name: "draft", kind: "prompt", entry: 1, status: "done" }),
    ]);
    expect(foldRun(ended, helperTask("explore-1"))).toBe(ended);
    const child = fold([start, step("step_start", "build", { performer: "child", role: "worker" })]);
    expect(foldRun(child, helperTask("explore-1"))).toBe(child);
    const prompt = fold([
      ...opened(),
      line("step_start", { node: "draft", name: "draft", kind: "prompt", entry: 1, performer: "chat" }),
    ]);
    expect(foldRun(prompt, helperTask("explore-1"))).toBe(prompt);
  });

  it("takes only a task the run's main agent hands out", () => {
    const runs = fold([
      ...opened(),
      line("step_start", { ...fan, performer: "child" }),
      ev({
        type: "agent_message",
        from: "worker-3",
        to: "explore-2",
        role: "task",
        state: "submitted",
        text: "x",
      }),
      ev({
        type: "agent_message",
        from: "main",
        to: "explore-3",
        role: "status",
        state: "working",
        text: "x",
      }),
    ]);
    expect(runs[0].entries[0].agents).toEqual([]);
  });

  it("keeps the streamed text per agent and shows the line of the agent that wrote last", () => {
    let runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "help" }),
      ev({ type: "text_delta", agentId: "main", text: "main says\nmain li" }),
      ev({ type: "text_delta", agentId: "worker-1", text: "worker says" }),
    ]);
    expect(runs[0].entries[0].liveLine).toBe("worker says");
    runs = [ev({ type: "text_delta", agentId: "main", text: "ne two" })].reduce(foldRun, runs);
    expect(runs[0].entries[0].liveLine).toBe("main line two");
    runs = [ev({ type: "text_delta", agentId: "worker-1", text: " more" })].reduce(foldRun, runs);
    expect(runs[0].entries[0].liveLine).toBe("worker says more");
  });

  it("keeps the shown line while the agent that wrote last has no line yet", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "help" }),
      ev({ type: "text_delta", agentId: "main", text: "main line" }),
      ev({ type: "text_delta", agentId: "worker-1", text: "\n" }),
    ]);
    expect(runs[0].entries[0].liveLine).toBe("main line");
  });

  it("keeps at most 2,000 characters per agent", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "help" }),
      ev({ type: "text_delta", agentId: "main", text: "m".repeat(1_500) }),
      ev({ type: "text_delta", agentId: "worker-1", text: "w".repeat(2_500) }),
    ]);
    const e = runs[0].entries[0];
    expect(e.liveText.main).toBe("m".repeat(1_500));
    expect(e.liveText["worker-1"]).toBe("w".repeat(2_000));
  });
});
