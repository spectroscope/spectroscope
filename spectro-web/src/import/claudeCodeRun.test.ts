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

const sidecar = (
  agentId: string,
  prompt: string,
  answer: string,
  startMs: number,
  cwd = "/workspaces/demo-project",
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 10, output_tokens: 5 },
): string =>
  [
    line({
      type: "user",
      isSidechain: true,
      agentId,
      sessionId: "session-under-test",
      uuid: `${agentId}-u`,
      timestamp: iso(startMs),
      cwd,
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
        usage,
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

type Frame = RunEvent & {
  runId?: string;
  parentId?: string;
  agentId?: string;
  task?: string;
  ts?: number;
};
const frames = (events: RunEvent[]): Frame[] => events as Frame[];
const runStartOf = (events: RunEvent[], agentId: string): Frame | undefined =>
  frames(events).find((e) => e.type === "run_start" && e.agentId === agentId);

describe("importClaudeCodeRun", () => {
  it("joins each sidecar by its meta toolUseId — that id IS the child on screen", () => {
    // The meta names the tool_use the spawn rode in on, and the session
    // already spawned the child under exactly that id. The merged run_start
    // carries it, parented under the spawner.
    const { events } = importClaudeCodeRun(RUN);
    expect(runStartOf(events, "toolu_child_1")?.parentId).toBe("main");
    expect(runStartOf(events, "toolu_child_2")?.parentId).toBe("main");
  });

  it("gives each child run its own runId, off the join key", () => {
    // The in-file sidechain path names a child's run `cc-<tool use id>`; the
    // merged stream speaks the same language, so the reducer can never take a
    // child's run_end for the session's.
    const { events } = importClaudeCodeRun(RUN);
    expect(runStartOf(events, "toolu_child_1")?.runId).toBe("cc-toolu_child_1");
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
    const child1 = at((e) => e.type === "run_start" && e.agentId === "toolu_child_1");
    const child2 = at((e) => e.type === "run_start" && e.agentId === "toolu_child_2");
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

  it("on a timestamp tie, the session's frame lands first", () => {
    // A child whose first record shares its stamp with a session record: the
    // merge is a k-way pick with a strict `<`, so the earliest stream — the
    // session — wins the tie. A `<=` would flip this and put a child's frame
    // before the session frame that carries the same clock reading.
    const merged = importClaudeCodeRun({
      sessionText: SESSION,
      sidecars: [
        {
          jsonlText: sidecar("agent-tie", "first subtask", "tie answer", T0 + 60_000),
          metaJson: meta("toolu_child_1"),
        },
      ],
    });
    const all = frames(merged.events);
    const sessionResult = all.findIndex((e) => e.type === "tool_result");
    const childStart = all.findIndex((e) => e.type === "run_start" && e.agentId === "toolu_child_1");
    // The premise: both frames really carry the same stamp.
    expect(all[sessionResult].ts).toBe(all[childStart].ts);
    expect(sessionResult).toBeGreaterThanOrEqual(0);
    expect(sessionResult).toBeLessThan(childStart);
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

  it("the session's cwd outranks a child's, and a child's fills in when the session has none", () => {
    // The search order is session first, then the merged children in order —
    // a child checked out elsewhere must not displace the session's own
    // workspace in the banner.
    const elsewhere = sidecar(
      "agent-one",
      "first subtask",
      "child answer",
      T0 + 2_000,
      "/workspaces/child-checkout",
    );
    const withElsewhere = {
      sessionText: SESSION,
      sidecars: [{ jsonlText: elsewhere, metaJson: meta("toolu_child_1") }],
    };
    expect(importClaudeCodeRun(withElsewhere).workspace).toBe("/workspaces/demo-project");
    // ... and the children ARE searched: with a cwd-less session, the first
    // merged child's cwd is the answer rather than null.
    const bareSession = SESSION.split("\n")
      .map((l) => {
        const r = JSON.parse(l) as { cwd?: string };
        delete r.cwd;
        return JSON.stringify(r);
      })
      .join("\n");
    expect(importClaudeCodeRun({ ...withElsewhere, sessionText: bareSession }).workspace).toBe(
      "/workspaces/child-checkout",
    );
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
    // The session file's own detection travels through: the dialog hands the
    // result to the same onLoad a single pick uses, kind and all.
    expect(merged.kind).toBe(lone.kind);
    expect(merged.subagent).toBe(lone.subagent);
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

    it("skips every sidecar beside a session that is not a Claude Code transcript", () => {
      // A spectroscope-native file may carry an `agent_spawn` verbatim, so the
      // join KEY can exist — but the subagents/ directory layout is Claude
      // Code's, and merging a Claude Code sidecar under a foreign session
      // would fabricate a child that run never recorded. The kind gate, not
      // the spawn lookup, is what refuses this.
      const spectroSession = [
        line({ type: "run_start", runId: "r1", agentId: "main", ts: T0 }),
        line({ type: "agent_spawn", agentId: "toolu_child_1", parentId: "main", task: "x", ts: T0 + 1_000 }),
        line({ type: "run_end", runId: "r1", ts: T0 + 2_000 }),
      ].join("\n");
      const merged = importClaudeCodeRun({
        sessionText: spectroSession,
        sidecars: [{ jsonlText: SIDECAR_1, metaJson: meta("toolu_child_1") }],
      });
      expect(merged.kind).toBe("spectroscope");
      expect(merged.childrenMerged).toBe(0);
      expect(merged.childrenSkipped).toBe(1);
      expect(JSON.stringify(merged.events)).toBe(JSON.stringify(detectAndLoad(spectroSession).events));
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
      expect(runStartOf(merged.events, "toolu_child_2")?.runId).toBe("cc-toolu_child_2");
    });
  });

  describe("a merged child keeps the ONE identity the session already knows (twin repair)", () => {
    // Measured on the real reference run (browser pass, 2026-08-28): the main
    // stream spawns each child under its Task tool_use id, and the merged
    // sidecar arrived under its own hex agentId — every child twice, one twin
    // ended by the result message and one working forever. The canon is the
    // single-file importer's own convention: Task tool_use ids double as the
    // child agentIds. The coordinator re-keys every merged frame onto it.
    const idFields = ["agentId", "parentId", "from", "to"] as const;
    const idsIn = (events: RunEvent[]): Set<string> => {
      const ids = new Set<string>();
      for (const e of frames(events))
        for (const k of idFields) {
          const v = (e as Record<string, unknown>)[k];
          if (typeof v === "string") ids.add(v);
        }
      return ids;
    };

    it("re-keys the sidecar's frames onto the Task tool_use id — no hex twin anywhere", () => {
      const ids = idsIn(importClaudeCodeRun(RUN).events);
      expect(ids.has("agent-one")).toBe(false);
      expect(ids.has("agent-two")).toBe(false);
      expect(ids.has("toolu_child_1")).toBe(true);
      expect(ids.has("toolu_child_2")).toBe(true);
    });

    it("the child's run_start speaks the in-file sidechain language", () => {
      // runId `cc-<tool use id>`, agentId the tool use id, parentId the
      // SPAWNER — exactly what the importer emits for a child it finds in the
      // same file. parentId must never be the child's own id: before the
      // repair the coordinator wrote parentId = toolUseId, which after the
      // re-key would nest the child under itself.
      const rs = runStartOf(importClaudeCodeRun(RUN).events, "toolu_child_1");
      expect(rs?.runId).toBe("cc-toolu_child_1");
      expect(rs?.parentId).toBe("main");
    });

    it("the sidecar's token frames land on the titled identity, not on a twin", () => {
      const usage = frames(importClaudeCodeRun(RUN).events).filter(
        (e) => e.type === "usage" && e.agentId === "toolu_child_1",
      ) as { inputTokens: number; outputTokens: number }[];
      expect(usage).toHaveLength(1);
      expect(usage[0].inputTokens).toBe(10);
      expect(usage[0].outputTokens).toBe(5);
    });

    it("a grandchild keeps its own identity, and its parentId follows the re-key", () => {
      // A Task spawned INSIDE the sidecar: the grandchild's id is its own
      // tool_use id and stays; only the pointer at its spawner moves from the
      // hex root onto the toolu identity.
      const withGrandchild = [
        line({
          type: "user",
          isSidechain: true,
          agentId: "agent-one",
          sessionId: "session-under-test",
          uuid: "agent-one-u",
          timestamp: iso(T0 + 2_000),
          message: { role: "user", content: "first subtask" },
        }),
        line({
          type: "assistant",
          isSidechain: true,
          agentId: "agent-one",
          uuid: "agent-one-a",
          parentUuid: "agent-one-u",
          timestamp: iso(T0 + 3_000),
          message: {
            id: "msg_agent-one",
            role: "assistant",
            model: "test-model-child",
            content: [
              {
                type: "tool_use",
                id: "toolu_grandchild",
                name: "Task",
                input: { description: "a nested subtask", subagent_type: "worker" },
              },
            ],
          },
        }),
      ].join("\n");
      const { events } = importClaudeCodeRun({
        sessionText: SESSION,
        sidecars: [{ jsonlText: withGrandchild, metaJson: meta("toolu_child_1") }],
      });
      const grandSpawn = frames(events).find(
        (e) => e.type === "agent_spawn" && e.agentId === "toolu_grandchild",
      );
      expect(grandSpawn?.parentId).toBe("toolu_child_1");
      expect(idsIn(events).has("agent-one")).toBe(false);
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
      // Both bills name the same agent after the re-key, so the NUMBERS are
      // the witness: the sidecar's own grain (21/13) survives, the launch
      // record's summary (10/5) does not — one bill, not two, not the sum.
      const distinctBill = sidecar("agent-one", "first subtask", "child one answer", T0 + 2_000, undefined, {
        input_tokens: 21,
        output_tokens: 13,
      });
      const merged = importClaudeCodeRun({
        sessionText: SESSION_WITH_BILL,
        sidecars: [{ jsonlText: distinctBill, metaJson: meta("toolu_child_1") }],
      });
      const bills = usageFor(merged.events, "toolu_child_1") as unknown as {
        inputTokens: number;
        outputTokens: number;
      }[];
      expect(bills).toHaveLength(1);
      expect(bills[0].inputTokens).toBe(21);
      expect(bills[0].outputTokens).toBe(13);
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
  it("one file alone is a single file — today's path, whatever its name", () => {
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
    // The extension does not matter for a lone pick: the file input invites
    // .json and .txt as well, and the importer's shape detection (card 152)
    // is the judge of what the bytes are — a vscode-agent export is a .json.
    expect(groupPickedFiles([{ name: "export.json", relativePath: "" }])).toEqual({
      kind: "single",
      session: 0,
    });
    expect(groupPickedFiles([{ name: "notes.txt", relativePath: "" }])).toEqual({
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
        { jsonl: 1, meta: 2, runId: null },
        { jsonl: 3, meta: 4, runId: null },
      ],
      runStates: [],
    });
  });

  it("a sidecar without a meta still counts — the coordinator will skip and say so", () => {
    const group = groupPickedFiles([
      { name: "sess.jsonl", relativePath: "" },
      { name: "agent-a.jsonl", relativePath: "" },
    ]);
    expect(group).toEqual({
      kind: "run",
      session: 0,
      sidecars: [{ jsonl: 1, meta: null, runId: null }],
      runStates: [],
    });
  });

  it("no session .jsonl in the selection is nothing to load", () => {
    expect(
      groupPickedFiles([
        { name: "agent-a.jsonl", relativePath: "" },
        { name: "agent-a.meta.json", relativePath: "" },
      ]),
    ).toEqual({ kind: "none" });
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

// ---- card 297: the workflow runs beside a session --------------------------
//
// Claude Code files a workflow's agents under
// `<session>/subagents/workflows/<runId>/`, next to a `journal.jsonl` the run
// writes for itself, and keeps the run's own state in
// `<session>/workflows/<runId>.json`. The layout below is the measured one
// (2026-08-29, over a real project directory), with synthetic names.
const FOLDER_PICK = [
  { name: "sess.jsonl", relativePath: "proj/sess.jsonl" },
  { name: "agent-direct.jsonl", relativePath: "proj/sess/subagents/agent-direct.jsonl" },
  { name: "agent-direct.meta.json", relativePath: "proj/sess/subagents/agent-direct.meta.json" },
  {
    name: "agent-wfa.jsonl",
    relativePath: "proj/sess/subagents/workflows/wf_run-one/agent-wfa.jsonl",
  },
  {
    name: "agent-wfa.meta.json",
    relativePath: "proj/sess/subagents/workflows/wf_run-one/agent-wfa.meta.json",
  },
  { name: "journal.jsonl", relativePath: "proj/sess/subagents/workflows/wf_run-one/journal.jsonl" },
  { name: "wf_run-one.json", relativePath: "proj/sess/workflows/wf_run-one.json" },
  { name: "board-sweep.js", relativePath: "proj/sess/workflows/scripts/board-sweep.js" },
  { name: "b1el7nj1s.txt", relativePath: "proj/sess/tool-results/b1el7nj1s.txt" },
];

describe("groupPickedFiles — a session folder that holds workflow runs", () => {
  it("does not take a run's journal.jsonl for a second session candidate", () => {
    // THE BLOCKING DEFECT: every `journal.jsonl` counted as a session, so a
    // folder with 12 runs offered 13 candidates and the WHOLE import failed
    // with "no session found". The journal is named by its directory, which
    // is exactly the kind of statement a directory pick can carry.
    const group = groupPickedFiles(FOLDER_PICK);
    expect(group.kind).toBe("run");
    if (group.kind !== "run") return;
    expect(FOLDER_PICK[group.session].name).toBe("sess.jsonl");
  });

  it("tells a workflow child from a direct spawn by the directory it sits in", () => {
    const group = groupPickedFiles(FOLDER_PICK);
    if (group.kind !== "run") throw new Error("expected a run");
    const named = group.sidecars.map((s) => ({
      name: FOLDER_PICK[s.jsonl].name,
      runId: s.runId,
    }));
    expect(named).toEqual([
      { name: "agent-direct.jsonl", runId: null },
      { name: "agent-wfa.jsonl", runId: "wf_run-one" },
    ]);
  });

  it("collects each run's own state file, keyed by its run id", () => {
    const group = groupPickedFiles(FOLDER_PICK);
    if (group.kind !== "run") throw new Error("expected a run");
    expect(group.runStates).toEqual([{ runId: "wf_run-one", file: 6 }]);
  });

  it("a journal.jsonl outside a run directory is still a session candidate", () => {
    // The rule is the PATH, not the name: only a journal under
    // subagents/workflows/<runId>/ is a run's own log. Anything else keeping
    // that name is somebody's session and must stay ambiguous rather than be
    // quietly dropped.
    expect(
      groupPickedFiles([
        { name: "sess.jsonl", relativePath: "proj/sess.jsonl" },
        { name: "journal.jsonl", relativePath: "proj/journal.jsonl" },
      ]).kind,
    ).toBe("none");
  });
});

// ---- card 297: a workflow run brings its agents ----------------------------
//
// A workflow child's meta is the WHOLE meta: {"agentType":"workflow-subagent",
// "spawnDepth":1} — no toolUseId, so card 291's join has nothing to hold and
// every one of them was skipped. What the layout DOES say is the run the child
// belonged to, and the session's own stream names that run once, in the
// receipt the Workflow tool_use came back with. Measured 2026-08-29 over a real
// session: 12 of 12 runs resolve that way, exactly one tool_use each.
const WF_T0 = Date.parse("2026-02-03T09:00:00.000Z");

const WF_RECEIPT = [
  "Workflow launched in background. Task ID: wntzxz4mx",
  "Summary: sweep the board and diagnose three cards",
  "Run ID: wf_run-one",
  "To resume after editing the script: rerun the tool.",
].join("\n");

/** The session: a Workflow tool_use and the receipt that names its run. */
const WF_SESSION = [
  line({
    type: "user",
    uuid: "wu1",
    timestamp: iso(WF_T0),
    cwd: "/workspaces/demo-project",
    message: { role: "user", content: "run the board sweep" },
  }),
  line({
    type: "assistant",
    uuid: "wa1",
    parentUuid: "wu1",
    timestamp: iso(WF_T0 + 1_000),
    message: {
      id: "msg_w1",
      role: "assistant",
      model: "test-model-parent",
      content: [
        {
          type: "tool_use",
          id: "toolu_workflow_1",
          name: "Workflow",
          input: { script: "export const meta = {}" },
        },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "wu2",
    parentUuid: "wa1",
    timestamp: iso(WF_T0 + 2_000),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_workflow_1", content: WF_RECEIPT }],
    },
  }),
].join("\n");

/** The meta a workflow child really gets — it names no tool_use at all. */
const WF_META = line({ agentType: "workflow-subagent", spawnDepth: 1 });

const wfState = (progress: object[], extra: object = {}): string =>
  JSON.stringify({
    runId: "wf_run-one",
    workflowName: "board-sweep-and-three",
    summary: "sweep every open card and diagnose three",
    status: "completed",
    workflowProgress: [{ type: "workflow_phase", index: 1, title: "Sweep" }, ...progress],
    ...extra,
  });

const wfAgent = (agentId: string, label: string, promptPreview: string): object => ({
  type: "workflow_agent",
  index: 1,
  label,
  phaseIndex: 1,
  phaseTitle: "Sweep",
  agentId,
  model: "test-model-child",
  state: "done",
  promptPreview,
});

const WF_CHILD_A = sidecar("a11aaaa", "sweep the todo column", "child a answer", WF_T0 + 3_000);
const WF_CHILD_B = sidecar("b22bbbb", "diagnose card 146", "child b answer", WF_T0 + 4_000);

const WF_RUN = {
  sessionText: WF_SESSION,
  sidecars: [
    { jsonlText: WF_CHILD_A, metaJson: WF_META, runId: "wf_run-one" },
    { jsonlText: WF_CHILD_B, metaJson: WF_META, runId: "wf_run-one" },
  ],
  runStates: [
    {
      runId: "wf_run-one",
      // Both previews are the SAME on purpose: a run's agents share their
      // preamble in real life, so this fixture leaves only the agent id able
      // to tell the two apart. Without that, the promptPreview rule silently
      // carried the test for the agent-id rule and biting the agent-id rule
      // stayed green.
      json: wfState([
        wfAgent("a11aaaa", "sweep-the-todo-column", "the shared preamble"),
        wfAgent("b22bbbb", "card-146-lab-map", "the shared preamble"),
      ]),
    },
  ],
};

const spawnOf = (events: RunEvent[], agentId: string): Frame[] =>
  frames(events).filter((e) => e.type === "agent_spawn" && e.agentId === agentId);

describe("importClaudeCodeRun — a workflow run brings its agents (card 297)", () => {
  it("joins a workflow child by the RUN its directory names, not by a toolUseId it has not got", () => {
    const run = importClaudeCodeRun(WF_RUN);
    expect(run.childrenMerged).toBe(2);
    expect(run.childrenSkipped).toBe(0);
    // A workflow child keeps its own hex id — unlike a Task child there is no
    // second identity to collapse onto, and the run's state file knows it by
    // exactly this id.
    expect(runStartOf(run.events, "a11aaaa")?.runId).toBe("cc-a11aaaa");
    expect(runStartOf(run.events, "b22bbbb")?.runId).toBe("cc-b22bbbb");
  });

  it("re-parents each child under the Workflow tool_use, not under the spawner", () => {
    const run = importClaudeCodeRun(WF_RUN);
    expect(runStartOf(run.events, "a11aaaa")?.parentId).toBe("toolu_workflow_1");
    expect(runStartOf(run.events, "b22bbbb")?.parentId).toBe("toolu_workflow_1");
  });

  it("gives the run itself a node: one spawn and one task message, at the tool_use stamp", () => {
    const run = importClaudeCodeRun(WF_RUN);
    const wf = spawnOf(run.events, "toolu_workflow_1");
    expect(wf).toHaveLength(1);
    expect(wf[0].parentId).toBe("main");
    expect(wf[0].ts).toBe(WF_T0 + 1_000);
    const msg = frames(run.events).filter(
      (e) => e.type === "agent_message" && (e as { to?: string }).to === "toolu_workflow_1",
    );
    expect(msg).toHaveLength(1);
    expect(msg[0]).toMatchObject({ from: "main", role: "task", label: "workflow" });
  });

  it("names the run by what the state file called it, falling back to the receipt's Summary", () => {
    const named = importClaudeCodeRun(WF_RUN);
    expect(spawnOf(named.events, "toolu_workflow_1")[0].task).toBe("board-sweep-and-three");
    // No state file at all: the receipt still says what the run was for.
    const bare = importClaudeCodeRun({ ...WF_RUN, runStates: [] });
    expect(spawnOf(bare.events, "toolu_workflow_1")[0].task).toBe("sweep the board and diagnose three cards");
  });

  it("spawns each child under the run, labelled by the state file's own label", () => {
    const run = importClaudeCodeRun(WF_RUN);
    const a = spawnOf(run.events, "a11aaaa");
    expect(a).toHaveLength(1);
    expect(a[0].parentId).toBe("toolu_workflow_1");
    expect(a[0].task).toBe("sweep-the-todo-column");
    expect(spawnOf(run.events, "b22bbbb")[0].task).toBe("card-146-lab-map");
  });

  it("falls back to the promptPreview match when the state file knows another agent id", () => {
    // A superseded attempt: the run was re-tried and the state file kept the
    // NEW agent's id, while the transcript on disk is the old one's. The
    // prompt is the same, so the label still belongs to it.
    const run = importClaudeCodeRun({
      ...WF_RUN,
      sidecars: [{ jsonlText: WF_CHILD_A, metaJson: WF_META, runId: "wf_run-one" }],
      runStates: [
        {
          runId: "wf_run-one",
          json: wfState([wfAgent("c33cccc", "sweep-the-todo-column", "sweep the todo column")]),
        },
      ],
    });
    expect(spawnOf(run.events, "a11aaaa")[0].task).toBe("sweep-the-todo-column");
  });

  it("falls back to the child's own prompt when no state file has been written yet", () => {
    // A LIVE run: the agents are on disk, the state file is not. The prompt is
    // the only honest label left, clipped the way a Task child's is.
    const run = importClaudeCodeRun({
      ...WF_RUN,
      sidecars: [{ jsonlText: WF_CHILD_A, metaJson: WF_META, runId: "wf_run-one" }],
      runStates: [],
    });
    expect(spawnOf(run.events, "a11aaaa")[0].task).toBe("sweep the todo column");
  });

  it("refuses a promptPreview that fits two agents — a shared preamble is not a name", () => {
    // A run's agents routinely share hundreds of leading characters. Measured
    // 2026-08-29 over the whole store: of the 565 agents the agent-id rule
    // missed, a full 400-character preview fitted 36 uniquely and 134
    // ambiguously. Taking either of those 134 would print somebody else's name
    // on this agent's card, so the ambiguous case falls to the prompt.
    const run = importClaudeCodeRun({
      ...WF_RUN,
      sidecars: [{ jsonlText: WF_CHILD_A, metaJson: WF_META, runId: "wf_run-one" }],
      runStates: [
        {
          runId: "wf_run-one",
          json: wfState([
            wfAgent("c33cccc", "sweep-the-todo-column", "sweep the"),
            wfAgent("d44dddd", "card-146-lab-map", "sweep the"),
          ]),
        },
      ],
    });
    expect(spawnOf(run.events, "a11aaaa")[0].task).toBe("sweep the todo column");
  });

  it("does not open a card with the prompt's own blank lines", () => {
    // Measured 2026-08-29 against a real session whose two newest runs had no
    // state file yet: rule 3 produced labels beginning "\nCONTEXT — …", so the
    // card opened on a blank line. Whitespace is not content.
    const run = importClaudeCodeRun({
      ...WF_RUN,
      sidecars: [
        {
          jsonlText: sidecar("e55eeee", "\n\nCONTEXT — read this first.\n", "done", WF_T0 + 3_000),
          metaJson: WF_META,
          runId: "wf_run-one",
        },
      ],
      runStates: [],
    });
    expect(spawnOf(run.events, "e55eeee")[0].task).toBe("CONTEXT — read this first.");
  });

  it("a run the session never named is skipped and counted, not guessed at", () => {
    const run = importClaudeCodeRun({
      ...WF_RUN,
      sidecars: [{ jsonlText: WF_CHILD_A, metaJson: WF_META, runId: "wf_never-mentioned" }],
      runStates: [],
    });
    expect(run.childrenMerged).toBe(0);
    expect(run.childrenSkipped).toBe(1);
    expect(spawnOf(run.events, "wf_never-mentioned")).toHaveLength(0);
  });

  it("counts a labelled agent that left no transcript — neither merged nor skipped", () => {
    // Without its own count such an agent simply vanishes, and a run that
    // says "4 agents" shows three with nothing admitting the fourth.
    const run = importClaudeCodeRun({
      ...WF_RUN,
      sidecars: [{ jsonlText: WF_CHILD_A, metaJson: WF_META, runId: "wf_run-one" }],
    });
    expect(run.childrenMerged).toBe(1);
    expect(run.childrenSkipped).toBe(0);
    expect(run.childrenUnrecorded).toBe(1);
  });

  it("leaves a Task child's join exactly as it was — the meta still rules", () => {
    // Branch A, byte for byte: a run with no workflow sidecars at all must
    // produce what card 291 produced.
    const before = importClaudeCodeRun(RUN);
    const after = importClaudeCodeRun({ ...RUN, runStates: [] });
    expect(after.events).toEqual(before.events);
    expect(after.childrenMerged).toBe(2);
    expect(after.childrenUnrecorded).toBe(0);
  });
});
