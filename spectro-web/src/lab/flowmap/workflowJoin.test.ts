// Card 306: PROVING the join, rather than assuming it.
//
// The box seats a run's declared members. Two id spaces have to be one for
// that to be possible at all:
//
//   · `PhaseMember.agentId` — what the run's own state file calls an agent,
//     read by `readWorkflowState`/`declarationFor`;
//   · `scene.subagents[].id` — what the Lab's reducer calls the card it drew,
//     which comes off `agent_spawn.agentId` in the merged stream.
//
// Nothing in the types says these are the same space, and reading the importer
// and believing it is exactly the mistake this house keeps paying for. So the
// fixture goes through the REAL importer and the REAL reducer, and the test
// compares the two sets.
//
// The fixture is the measured layout (card 297): a Workflow tool_use, the
// receipt that names its run, two sidecars filed under that run, and the run's
// own state file. A workflow child carries NO toolUseId, so its id stays the
// hex id its own file knows — which is precisely why the state file can name
// it at all. Synthetic and minimal: no real transcript content, no real paths.

import { describe, expect, it } from "vitest";
import { importClaudeCodeRun } from "../../import/claudeCodeRun";
import { advanceScene, initialScene } from "../labScene";

const T0 = Date.parse("2026-02-03T09:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (r: object): string => JSON.stringify(r);

const RECEIPT = [
  "Workflow launched in background. Task ID: wntest001",
  "Summary: the shape under test",
  "Run ID: wf_run-one",
].join("\n");

const SESSION = [
  line({
    type: "user",
    uuid: "u1",
    timestamp: iso(T0),
    cwd: "/workspaces/demo-project",
    message: { role: "user", content: "run the flow" },
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
      content: [{ type: "tool_use", id: "toolu_workflow_1", name: "Workflow", input: { script: "" } }],
    },
  }),
  line({
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: iso(T0 + 2_000),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_workflow_1", content: RECEIPT }],
    },
  }),
  // The notification the run files when it comes back. Without it the
  // session's own run_end lands at the receipt — BEFORE the children merge in
  // — and the reducer clears the subagents it just drew. That is the real
  // shape (card 297's fixture carries it) and not a convenience.
  line({
    type: "user",
    uuid: "u3",
    timestamp: iso(T0 + 60_000),
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>wntest001</task-id>\n" +
        "<tool-use-id>toolu_workflow_1</tool-use-id>\n<status>completed</status>\n" +
        "<summary>the run came back</summary>\n</task-notification>",
    },
  }),
].join("\n");

const sidecar = (agentId: string, prompt: string, startMs: number): string =>
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
        id: `msg-${agentId}`,
        role: "assistant",
        model: "test-model-child",
        content: [{ type: "text", text: "done" }],
      },
    }),
  ].join("\n");

const META = line({ agentType: "workflow-subagent", spawnDepth: 1 });

/** Two phases: the first holds one agent, the second holds two. */
const STATE = JSON.stringify({
  runId: "wf_run-one",
  workflowName: "the shape under test",
  status: "completed",
  // What the SCRIPT declared before the run began — the order the box reads.
  phases: [
    { title: "survey", detail: "look at the board" },
    { title: "fan out", detail: null },
  ],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "survey" },
    { type: "workflow_phase", index: 2, title: "fan out" },
    {
      type: "workflow_agent",
      label: "surveyor",
      phaseIndex: 1,
      phaseTitle: "survey",
      agentId: "a11aaaa",
      model: "test-model-child",
      state: "done",
      promptPreview: "the shared preamble",
    },
    {
      type: "workflow_agent",
      label: "hand-one",
      phaseIndex: 2,
      phaseTitle: "fan out",
      agentId: "b22bbbb",
      model: "test-model-child",
      state: "done",
      promptPreview: "the shared preamble",
    },
    {
      type: "workflow_agent",
      label: "hand-two",
      phaseIndex: 2,
      phaseTitle: "fan out",
      agentId: "c33cccc",
      model: "test-model-child",
      state: "done",
      promptPreview: "the shared preamble",
    },
  ],
});

export const WF_FIXTURE = {
  sessionText: SESSION,
  sidecars: [
    { jsonlText: sidecar("a11aaaa", "survey the board", T0 + 3_000), metaJson: META, runId: "wf_run-one" },
    { jsonlText: sidecar("b22bbbb", "first hand", T0 + 4_000), metaJson: META, runId: "wf_run-one" },
    { jsonlText: sidecar("c33cccc", "second hand", T0 + 5_000), metaJson: META, runId: "wf_run-one" },
  ],
  runStates: [{ runId: "wf_run-one", json: STATE }],
};

describe("the workflow join — declaration ids and scene ids are ONE id space", () => {
  const imported = importClaudeCodeRun(WF_FIXTURE);
  // THE PREFIX MATTERS, and measuring that cost a detour worth writing down.
  // Folding the WHOLE stream leaves one card standing: `advanceScene` retires
  // every child at a `run_end` whose runId is not the root's, and once the
  // root's own run_end has cleared `rootRunId` the guard cannot tell a child's
  // run_end from the root's — so each merged child wipes the board on its way
  // out. The Lab never shows that fold: it shows the fold over the applied
  // PREFIX at the reader's step. So the join is measured where the reader
  // actually meets it — the step the run's last member was spawned on, which
  // is the fullest the map ever gets.
  const lastSpawn = imported.events.map((e) => e.type).lastIndexOf("agent_spawn");
  const scene = imported.events.slice(0, lastSpawn + 1).reduce(advanceScene, initialScene());

  it("the import produces a declaration at all, keyed by the run's tool_use id", () => {
    expect(imported.declared).toBeDefined();
    expect([...imported.declared!.keys()]).toEqual(["toolu_workflow_1"]);
  });

  it("every agent the declaration names is a card the scene drew, by the SAME id", () => {
    const run = imported.declared!.get("toolu_workflow_1")!;
    const declaredIds = run.phases.flatMap((p) => p.members.map((m) => m.agentId));
    const sceneIds = new Set(scene.subagents.map((s) => s.id));
    expect(declaredIds).toEqual(["a11aaaa", "b22bbbb", "c33cccc"]);
    for (const id of declaredIds) expect(sceneIds.has(id)).toBe(true);
  });

  it("the run itself is a scene card too, under the key the declaration is filed by", () => {
    // So a box can be seated where the run's own card stands, instead of
    // somewhere the reader never met it.
    expect(scene.subagents.map((s) => s.id)).toContain("toolu_workflow_1");
  });

  it("the declared phases are the ones the file stated, in the file's order", () => {
    const run = imported.declared!.get("toolu_workflow_1")!;
    expect(run.phases.map((p) => p.title)).toEqual(["survey", "fan out"]);
    expect(run.phases.map((p) => p.members.length)).toEqual([1, 2]);
    expect(run.unplaced).toEqual([]);
  });
});
