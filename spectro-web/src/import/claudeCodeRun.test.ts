// Card 291: the run's children come along on import.
//
// The coordinator sits OVER the existing importer: it parses nothing new, it
// joins. Every fixture here is synthetic and minimal — no real transcript
// content, no real paths, no private names. The joins under test are the
// measured ones: a child's meta names the `tool_use` id its spawn rode in on
// (`toolUseId`), and that id IS the child's agent id in the parent's stream.
import { describe, expect, it } from "vitest";
import { detectAndLoad } from "./detect";
import { groupPickedFiles, importClaudeCodeRun } from "./claudeCodeRun";
import type { RunEvent } from "../events";

// ---- synthetic fixtures --------------------------------------------------
// A 3-line main stream (user prompt, one response spawning two Tasks, one
// tool_result coming back) and two 2-line sidecars with metas. Timestamps are
// real ISO stamps because the merge orders on them.
const T0 = Date.parse("2026-01-05T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const line = (r: object): string => JSON.stringify(r);

const SESSION = [
  line({
    type: "user",
    uuid: "u1",
    timestamp: iso(T0),
    cwd: "/workspaces/demo-project",
    message: { role: "user", content: "please fan out" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: iso(T0 + 1_000),
    message: {
      id: "msg_1",
      role: "assistant",
      model: "test-model-parent",
      content: [
        {
          type: "tool_use",
          id: "toolu_child_1",
          name: "Task",
          input: { description: "first subtask", subagent_type: "worker" },
        },
        {
          type: "tool_use",
          id: "toolu_child_2",
          name: "Task",
          input: { description: "second subtask", subagent_type: "worker" },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: iso(T0 + 60_000),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_child_1", content: "child one is done" }],
    },
  }),
].join("\n");

const sidecar = (agentId: string, prompt: string, answer: string, startMs: number): string =>
  [
    line({
      type: "user",
      isSidechain: true,
      agentId,
      sessionId: "session-under-test",
      uuid: `${agentId}-u`,
      timestamp: iso(startMs),
      cwd: "/workspaces/demo-project",
      message: { role: "user", content: prompt },
    }),
    line({
      type: "assistant",
      isSidechain: true,
      agentId,
      uuid: `${agentId}-a`,
      parentUuid: `${agentId}-u`,
      timestamp: iso(startMs + 1_000),
      message: {
        id: `msg_${agentId}`,
        role: "assistant",
        model: "test-model-child",
        content: [{ type: "text", text: answer }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ].join("\n");

const meta = (toolUseId: string): string =>
  line({
    agentType: "worker",
    description: "a synthetic subtask",
    toolUseId,
    spawnDepth: 1,
    model: "test-model-child",
  });

const SIDECAR_1 = sidecar("agent-one", "first subtask", "child one answer", T0 + 2_000);
const SIDECAR_2 = sidecar("agent-two", "second subtask", "child two answer", T0 + 4_000);

const RUN = {
  sessionText: SESSION,
  sidecars: [
    { jsonlText: SIDECAR_1, metaJson: meta("toolu_child_1") },
    { jsonlText: SIDECAR_2, metaJson: meta("toolu_child_2") },
  ],
};

type Frame = RunEvent & { runId?: string; parentId?: string; agentId?: string; ts?: number };
const frames = (events: RunEvent[]): Frame[] => events as Frame[];
const runStartOf = (events: RunEvent[], agentId: string): Frame | undefined =>
  frames(events).find((e) => e.type === "run_start" && e.agentId === agentId);

describe("importClaudeCodeRun", () => {
  it("sets each child's run_start.parentId from its meta toolUseId", () => {
    const { events } = importClaudeCodeRun(RUN);
    expect(runStartOf(events, "agent-one")?.parentId).toBe("toolu_child_1");
    expect(runStartOf(events, "agent-two")?.parentId).toBe("toolu_child_2");
  });

  it("gives each child run its own runId, off the join key", () => {
    // The in-file sidechain path names a child's run `cc-<tool use id>`; the
    // merged stream speaks the same language, so the reducer can never take a
    // child's run_end for the session's.
    const { events } = importClaudeCodeRun(RUN);
    expect(runStartOf(events, "agent-one")?.runId).toBe("cc-toolu_child_1");
    const childEnd = frames(events).filter((e) => e.type === "run_end" && e.runId === "cc-toolu_child_1");
    expect(childEnd).toHaveLength(1);
    // The session's own root run keeps its id, once.
    const rootStarts = frames(events).filter((e) => e.type === "run_start" && e.runId === "cc-import");
    expect(rootStarts).toHaveLength(1);
    expect(rootStarts[0].agentId).toBe("main");
  });

  it("merges on real timestamps: a child's events land after its spawn", () => {
    const { events } = importClaudeCodeRun(RUN);
    const at = (pred: (e: Frame) => boolean): number => frames(events).findIndex(pred);
    const spawn1 = at((e) => e.type === "agent_spawn" && e.agentId === "toolu_child_1");
    const child1 = at((e) => e.type === "run_start" && e.agentId === "agent-one");
    const child2 = at((e) => e.type === "run_start" && e.agentId === "agent-two");
    const result1 = at((e) => e.type === "tool_result");
    expect(spawn1).toBeGreaterThanOrEqual(0);
    expect(child1).toBeGreaterThan(spawn1);
    expect(child2).toBeGreaterThan(child1);
    // The Task's tool_result is a minute later in the file; the children sit
    // between the spawn and it, which only a timestamp merge produces.
    expect(result1).toBeGreaterThan(child2);
    const stamps = frames(events).map((e) => e.ts ?? 0);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("reports the workspace off the first record carrying cwd", () => {
    expect(importClaudeCodeRun(RUN).workspace).toBe("/workspaces/demo-project");
    // A run whose records never carry one says so with null, not with "".
    const bare = {
      sessionText: SESSION.split("\n")
        .map((l) => {
          const r = JSON.parse(l) as { cwd?: string };
          delete r.cwd;
          return JSON.stringify(r);
        })
        .join("\n"),
      sidecars: [],
    };
    expect(importClaudeCodeRun(bare).workspace).toBeNull();
  });

  it("counts what it merged", () => {
    const { childrenMerged, childrenSkipped } = importClaudeCodeRun(RUN);
    expect(childrenMerged).toBe(2);
    expect(childrenSkipped).toBe(0);
  });

  it("with no sidecars, the events are today's single-file import, byte for byte", () => {
    const lone = detectAndLoad(SESSION);
    const merged = importClaudeCodeRun({ sessionText: SESSION, sidecars: [] });
    expect(JSON.stringify(merged.events)).toBe(JSON.stringify(lone.events));
    expect([...merged.source.origin]).toEqual([...lone.source.origin]);
    expect(merged.source.lines).toEqual(lone.source.lines);
  });

  it("keeps the session's own line origins and gives merged child frames none", () => {
    const lone = detectAndLoad(SESSION);
    const merged = importClaudeCodeRun(RUN);
    expect(merged.source.lines).toEqual(lone.source.lines);
    expect(merged.source.origin.length).toBe(merged.events.length);
    const at = frames(merged.events).findIndex(
      (e) => e.type === "text_delta" && (e as { text?: string }).text === "child one answer",
    );
    expect(at).toBeGreaterThanOrEqual(0);
    // A child frame was read from ANOTHER file: pointing it at a line of the
    // session file would show a reader the wrong bytes. -1 is the honest "not
    // from this file", the same word the importer's own frames use.
    expect(merged.source.origin[at]).toBe(-1);
    // The session's run_start still names the session's own line.
    const rootAt = frames(merged.events).findIndex((e) => e.type === "run_start" && e.agentId === "main");
    const loneAt = frames(lone.events).findIndex((e) => e.type === "run_start" && e.agentId === "main");
    expect(merged.source.origin[rootAt]).toBe(lone.source.origin[loneAt]);
  });

  describe("a sidecar that cannot be joined degrades to a count, never to a throw", () => {
    const sessionOnly = detectAndLoad(SESSION).events;
    const expectSkipped = (bad: { jsonlText: string; metaJson: string }): void => {
      const merged = importClaudeCodeRun({ sessionText: SESSION, sidecars: [bad] });
      expect(merged.childrenMerged).toBe(0);
      expect(merged.childrenSkipped).toBe(1);
      expect(JSON.stringify(merged.events)).toBe(JSON.stringify(sessionOnly));
    };

    it("skips a meta that is not JSON", () => {
      expectSkipped({ jsonlText: SIDECAR_1, metaJson: "not json {" });
    });

    it("skips a meta that names no toolUseId", () => {
      expectSkipped({ jsonlText: SIDECAR_1, metaJson: line({ agentType: "worker" }) });
    });

    it("skips a toolUseId the session never spawned", () => {
      expectSkipped({ jsonlText: SIDECAR_1, metaJson: meta("toolu_unknown") });
    });

    it("skips a sidecar whose stream is not parseable JSONL", () => {
      expectSkipped({ jsonlText: "this is not jsonl", metaJson: meta("toolu_child_1") });
    });

    it("skips a sidecar that is not one agent's transcript", () => {
      // A session-shaped file (nothing sidechain) beside a meta is a layout
      // this coordinator does not understand; merging it would reparent a
      // whole second session under one Task.
      expectSkipped({ jsonlText: SESSION, metaJson: meta("toolu_child_1") });
    });

    it("one bad sidecar does not take the good one with it", () => {
      const merged = importClaudeCodeRun({
        sessionText: SESSION,
        sidecars: [
          { jsonlText: "broken", metaJson: meta("toolu_child_1") },
          { jsonlText: SIDECAR_2, metaJson: meta("toolu_child_2") },
        ],
      });
      expect(merged.childrenMerged).toBe(1);
      expect(merged.childrenSkipped).toBe(1);
      expect(runStartOf(merged.events, "agent-two")?.parentId).toBe("toolu_child_2");
    });
  });

  describe("a merged child's bill is not paid twice", () => {
    // The launch record's `usage` summarises the child's whole run. In a lone
    // session import it is the only bill there is and it stays; once the
    // child's own records are merged in, they are the per-response grain and
    // the summary is the same money a second time — the importer's own
    // `billedOwn` rule, applied across files.
    const SESSION_WITH_BILL = [
      SESSION.split("\n")[0],
      SESSION.split("\n")[1],
      line({
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        timestamp: iso(T0 + 60_000),
        toolUseResult: {
          resolvedModel: "test-model-child",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_child_1", content: "child one is done" }],
        },
      }),
    ].join("\n");
    const usageFor = (events: RunEvent[], agentId: string): Frame[] =>
      frames(events).filter((e) => e.type === "usage" && e.agentId === agentId);

    it("the lone import bills the child off the launch record (the premise)", () => {
      expect(usageFor(detectAndLoad(SESSION_WITH_BILL).events, "toolu_child_1")).toHaveLength(1);
    });

    it("the merged import drops the summary and keeps the child's own bill", () => {
      const merged = importClaudeCodeRun({
        sessionText: SESSION_WITH_BILL,
        sidecars: [{ jsonlText: SIDECAR_1, metaJson: meta("toolu_child_1") }],
      });
      expect(usageFor(merged.events, "toolu_child_1")).toHaveLength(0);
      expect(usageFor(merged.events, "agent-one")).toHaveLength(1);
    });

    it("a SKIPPED child keeps the launch record's bill — it is the only one", () => {
      const merged = importClaudeCodeRun({
        sessionText: SESSION_WITH_BILL,
        sidecars: [{ jsonlText: "broken", metaJson: meta("toolu_child_1") }],
      });
      expect(usageFor(merged.events, "toolu_child_1")).toHaveLength(1);
    });
  });
});

describe("groupPickedFiles", () => {
  it("one .jsonl alone is a single file — today's path, whatever its name", () => {
    expect(groupPickedFiles([{ name: "session.jsonl", relativePath: "" }])).toEqual({
      kind: "single",
      session: 0,
    });
    // A lone agent transcript stays on the card-152 path too: the shape rule
    // decides what it is, never this grouping.
    expect(groupPickedFiles([{ name: "agent-abc.jsonl", relativePath: "" }])).toEqual({
      kind: "single",
      session: 0,
    });
  });

  it("a directory pick pairs the session with its sidecars and metas", () => {
    const group = groupPickedFiles([
      { name: "sess.jsonl", relativePath: "sess/sess.jsonl" },
      { name: "agent-a.jsonl", relativePath: "sess/subagents/agent-a.jsonl" },
      { name: "agent-a.meta.json", relativePath: "sess/subagents/agent-a.meta.json" },
      { name: "agent-b.jsonl", relativePath: "sess/subagents/agent-b.jsonl" },
      { name: "agent-b.meta.json", relativePath: "sess/subagents/agent-b.meta.json" },
      { name: "unrelated.txt", relativePath: "sess/unrelated.txt" },
    ]);
    expect(group).toEqual({
      kind: "run",
      session: 0,
      sidecars: [
        { jsonl: 1, meta: 2 },
        { jsonl: 3, meta: 4 },
      ],
    });
  });

  it("a sidecar without a meta still counts — the coordinator will skip and say so", () => {
    const group = groupPickedFiles([
      { name: "sess.jsonl", relativePath: "" },
      { name: "agent-a.jsonl", relativePath: "" },
    ]);
    expect(group).toEqual({ kind: "run", session: 0, sidecars: [{ jsonl: 1, meta: null }] });
  });

  it("no session .jsonl in the selection is nothing to load", () => {
    expect(
      groupPickedFiles([
        { name: "agent-a.jsonl", relativePath: "" },
        { name: "agent-a.meta.json", relativePath: "" },
      ]),
    ).toEqual({ kind: "none" });
    expect(groupPickedFiles([{ name: "notes.txt", relativePath: "" }])).toEqual({ kind: "none" });
  });

  it("two session candidates are ambiguous, not a coin toss", () => {
    expect(
      groupPickedFiles([
        { name: "one.jsonl", relativePath: "" },
        { name: "two.jsonl", relativePath: "" },
      ]),
    ).toEqual({ kind: "none" });
  });
});
