// Card 313, end to end: the reading against a REAL imported workflow run.
//
// workAgentsInStream.test.tsx builds its rows by hand, which proves the rule
// and not the case the owner hit. Here the events come out of the importer
// itself: a session whose Workflow tool_use returned a receipt with a run id,
// two agent transcripts in that run's directory, merged the way card 297
// merges them. The roster is then folded by the very reducer the agents panel
// renders, and the work items by the very fold the work panel renders — so
// what this asserts is that the two panels agree about one screen.
//
// Every fixture is synthetic: no real transcript content, no real paths, no
// private names. The shape is the measured one card 297 recorded.

import { describe, expect, it } from "vitest";
import { importClaudeCodeRun } from "../import/claudeCodeRun";
import { initialState, reduce } from "../state/reducer";
import type { UiState } from "../state/reducer";
import { foldWork } from "../state/work";
import type { WorkItem } from "../state/work";
import { besideReading } from "./workLevels";
import type { SidecarAgent, SidecarIndex } from "../import/sidecarAgents";
import { NO_SIDECARS } from "../import/sidecarAgents";
import type { RunEvent } from "../events";

const T0 = Date.parse("2026-02-03T09:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (r: object): string => JSON.stringify(r);

const RECEIPT = [
  "Workflow launched in background. Task ID: wntzxz4mx",
  "Summary: sweep the board and diagnose three cards",
  "Run ID: wf_run-one",
].join("\n");

const SESSION = [
  line({
    type: "user",
    uuid: "u1",
    timestamp: iso(T0),
    cwd: "/workspaces/demo-project",
    message: { role: "user", content: "run the board sweep" },
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
          id: "toolu_workflow_1",
          name: "Workflow",
          input: { script: "export const meta = {}" },
        },
      ],
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
  // The `<task-notification>` the run files when it comes back: the ONE place
  // a session says how a launch ended, and where the reported agent count
  // comes from. The importer folds it into the launch's own tool_result.
  line({
    type: "user",
    uuid: "u3",
    timestamp: iso(T0 + 60_000),
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>wntzxz4mx</task-id>\n" +
        "<tool-use-id>toolu_workflow_1</tool-use-id>\n<status>completed</status>\n" +
        "<summary>the run came back</summary>\n" +
        "<usage><agent_count>2</agent_count><tool_uses>9</tool_uses></usage>\n" +
        "</task-notification>",
    },
  }),
].join("\n");

/** A workflow child's meta names no tool_use at all — its directory does. */
const META = line({ agentType: "workflow-subagent", spawnDepth: 1 });

const child = (agentId: string, prompt: string, at: number): string =>
  [
    line({
      type: "user",
      isSidechain: true,
      agentId,
      uuid: `${agentId}-u`,
      timestamp: iso(at),
      cwd: "/workspaces/demo-project",
      message: { role: "user", content: prompt },
    }),
    line({
      type: "assistant",
      isSidechain: true,
      agentId,
      uuid: `${agentId}-a`,
      parentUuid: `${agentId}-u`,
      timestamp: iso(at + 1_000),
      message: {
        id: `msg_${agentId}`,
        role: "assistant",
        model: "test-model-child",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ].join("\n");

const IMPORT = importClaudeCodeRun({
  sessionText: SESSION,
  sidecars: [
    { jsonlText: child("a11aaaa", "sweep the todo column", T0 + 3_000), metaJson: META, runId: "wf_run-one" },
    { jsonlText: child("b22bbbb", "diagnose card 146", T0 + 4_000), metaJson: META, runId: "wf_run-one" },
  ],
});

/** What the store lists beside the session: both children, as files. */
const FILES: SidecarAgent[] = ["a11aaaa", "b22bbbb"].map((agentId) => ({
  agentId,
  path: `sess/subagents/workflows/wf_run-one/agent-${agentId}.jsonl`,
  runId: "wf_run-one",
  bytes: 12_288,
  modifiedAt: 1,
}));

const INDEX: SidecarIndex = {
  all: FILES,
  forRun: (runId) => FILES.filter((f) => f.runId === runId),
  byAgentId: (id) => FILES.find((f) => f.agentId === id),
};

/** The agents panel's roster, folded by the reducer that feeds it. */
function roster(events: RunEvent[]): UiState["agents"] {
  return events.reduce<UiState>((s, e) => reduce(s, e), initialState).agents;
}

/** The work panel's row for the run, found the way the panel walks its tree. */
function rowFor(items: WorkItem[], id: string): WorkItem {
  for (const item of items) {
    if (item.id === id) return item;
    const hit = item.children.find((c) => c.id === id);
    if (hit !== undefined) return hit;
  }
  throw new Error(`no work row for ${id}`);
}

describe("a real imported workflow run — the two panels read one screen", () => {
  const items = foldWork(IMPORT.events);
  const node = rowFor(items, "toolu_workflow_1");

  it("the import merged both agents, so the receipt's row is a run with children", () => {
    expect(IMPORT.childrenMerged).toBe(2);
    expect(node.runId).toBe("wf_run-one");
    expect(node.opaque).not.toBeNull();
    expect(node.children.map((c) => c.id).sort()).toEqual(["a11aaaa", "b22bbbb"]);
  });

  it("the agents panel lists exactly those two under the run", () => {
    expect(
      roster(IMPORT.events)
        .filter((a) => a.parentId === "toolu_workflow_1")
        .map((a) => a.id)
        .sort(),
    ).toEqual(["a11aaaa", "b22bbbb"]);
  });

  it("so the work panel reads them as agents — not as the files they also are", () => {
    const reading = besideReading(node, roster(IMPORT.events), INDEX);
    expect(reading?.kind).toBe("inStream");
    expect(reading).toMatchObject({ agents: ["a11aaaa", "b22bbbb"] });
  });

  it("the run's own claim agrees with what was loaded, so nothing contradicts it", () => {
    expect(node.opaque?.agents).toBe(2);
    expect(besideReading(node, roster(IMPORT.events), INDEX)).toEqual({
      kind: "inStream",
      agents: ["a11aaaa", "b22bbbb"],
      claimed: 2,
    });
  });

  it("and the same session, imported WITHOUT its sidecars, still says what it always said", () => {
    // Nothing merged, so the roster knows no agent of this run and the row has
    // only the receipt to go on. This is the arm the old sentence was written
    // for, reached through the real importer rather than asserted about it.
    const alone = importClaudeCodeRun({ sessionText: SESSION, sidecars: [] });
    const lone = rowFor(foldWork(alone.events), "wntzxz4mx");
    expect(alone.childrenMerged).toBe(0);
    expect(roster(alone.events).some((a) => a.parentId === "toolu_workflow_1")).toBe(false);
    expect(besideReading(lone, roster(alone.events), NO_SIDECARS)).toEqual({
      kind: "claim",
      claimed: 2,
      toolUses: 9,
    });
    // …and where the store DOES list the transcripts, they are still files.
    expect(besideReading(lone, roster(alone.events), INDEX)?.kind).toBe("files");
  });
});
