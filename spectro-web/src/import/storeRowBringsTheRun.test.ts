// Card 318: the store list brings the whole run.
//
// THE DEFECT, in one sentence: the merge that loads a workflow run's agents
// INTO the stream (cards 291 and 297, done and shipped) is reachable only from
// the folder picker. The store list — the one-click door the owner actually
// uses — fetches `/api/claude/transcripts/content` for the session file alone
// and hands the bytes to `detectAndLoad`, so a session with hundreds of agents
// beside it opens with none of them.
//
// The owner, watching it happen:
//   "When I open a workflow I still see the agents as individual clickable
//    files. There are hundreds of agents in the session and I see none of them
//    in the Lab, because the file is not resolved."
//
// Measured over his own session (13 agent transcripts in wf_33b5add0-f8f):
//
//   store list (one file)   3327 events    48 items   roster 1     -> "files"
//   folder pick (whole run) 50907 events  303 items   roster 288   -> "inStream"
//
// This file reproduces that pair on a synthetic session of the same SHAPE — a
// `Workflow` tool_use whose receipt names a run id, agent sidecars under
// `subagents/workflows/<runId>/` with the real two-key meta, and the run's own
// `workflows/<runId>.json` — and demands that the store row produce the second
// reading rather than the first.
//
// The assertions are on the READING, `besideReading`, which is what the work
// panel actually draws. Not on a call count: the owner's complaint is about
// what he sees, and a test that counted fetches would go green on a door that
// asks for everything and then throws it away.
//
// Nothing here is copied out of the real store.

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectAndLoad } from "./detect";
import { groupPickedFiles, importClaudeCodeRun, type PickedFile } from "./claudeCodeRun";
import { loadSidecarAgents, type SidecarIndex } from "./sidecarAgents";
import { besideReading } from "../components/workLevels";
import { foldWork, type WorkItem } from "../state/work";
import { initialState, normalizeReplay, reduceAll, type AgentInfo } from "../state/reducer";
import type { RunEvent } from "../events";
import { read, stripComments } from "../testkit/source";

// ---- a synthetic recording of the shape the owner's store holds ------------

const T0 = Date.parse("2026-03-02T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (r: object): string => JSON.stringify(r);

const RUN = "wf_fixture-run";
const WF_TOOL = "toolu_fixture_workflow";
const TASK = "tskfixture01";
/** The three agents this run recorded, and the only list any expectation may
 *  come from: everything below is derived off this array, so a fourth entry
 *  moves the fixture, the roster and every count together. */
const AGENTS = ["a11111", "a22222", "a33333"] as const;

const RECEIPT = [
  `Workflow launched in background. Task ID: ${TASK}`,
  "Summary: survey the board, then diagnose",
  `Run ID: ${RUN}`,
].join("\n");

/** The session file, exactly what `/api/claude/transcripts/content` serves. */
const SESSION_TEXT = [
  line({
    type: "user",
    uuid: "u1",
    timestamp: iso(T0),
    cwd: "/workspaces/demo-project",
    message: { role: "user", content: "run the survey" },
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
        { type: "tool_use", id: WF_TOOL, name: "Workflow", input: { script: "export const meta = {}" } },
      ],
    },
  }),
  line({
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: iso(T0 + 2_000),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: WF_TOOL, content: RECEIPT }] },
  }),
  line({
    type: "user",
    uuid: "u3",
    timestamp: iso(T0 + 60_000),
    message: {
      role: "user",
      content:
        `<task-notification>\n<task-id>${TASK}</task-id>\n` +
        `<tool-use-id>${WF_TOOL}</tool-use-id>\n` +
        "<status>completed</status>\n<summary>the run came back</summary>\n</task-notification>",
    },
  }),
].join("\n");

const childText = (agentId: string, at: number): string =>
  [
    line({
      type: "user",
      isSidechain: true,
      agentId,
      uuid: `${agentId}-u`,
      timestamp: iso(at),
      cwd: "/workspaces/demo-project",
      message: { role: "user", content: `work on ${agentId}` },
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

/** What a workflow child's meta really carries, in full. There is no join key
 *  in it at all, which is why the run directory is the only attribution. */
const META = line({ agentType: "workflow-subagent", spawnDepth: 1 });

const STATE_TEXT = JSON.stringify({
  runId: RUN,
  workflowName: "survey-then-diagnose",
  status: "completed",
  agentCount: AGENTS.length,
  phases: [{ title: "Survey", detail: "walk every open card" }],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Survey" },
    ...AGENTS.map((agentId, i) => ({
      type: "workflow_agent",
      index: i + 1,
      label: `lane-${i}`,
      phaseIndex: 1,
      phaseTitle: "Survey",
      agentId,
      model: "test-model-child",
      state: "done",
      promptPreview: "the shared preamble",
    })),
  ],
});

/** The session's store address, the string the listing row carries. */
const STORE_PATH = "-Users-x-repo/s1.jsonl";
const AGENT_DIR = "-Users-x-repo/s1/subagents/workflows";

// ---- the two doors ---------------------------------------------------------

/**
 * The FOLDER pick, as `ImportDialog.onFile` performs it: the directory listing
 * is grouped, the group's three text sets go to the coordinator. Real code
 * throughout — `groupPickedFiles` and `importClaudeCodeRun` are the shipped
 * ones, untouched by this card.
 */
function folderPick(): ReturnType<typeof importClaudeCodeRun> {
  const files: PickedFile[] = [
    { name: "s1.jsonl", relativePath: "s1/s1.jsonl" },
    ...AGENTS.flatMap((id) => [
      { name: `agent-${id}.jsonl`, relativePath: `s1/s1/subagents/workflows/${RUN}/agent-${id}.jsonl` },
      {
        name: `agent-${id}.meta.json`,
        relativePath: `s1/s1/subagents/workflows/${RUN}/agent-${id}.meta.json`,
      },
    ]),
    { name: `${RUN}.json`, relativePath: `s1/s1/workflows/${RUN}.json` },
  ];
  const texts = [
    SESSION_TEXT,
    ...AGENTS.flatMap((id, i) => [childText(id, T0 + 3_000 + i * 100), META]),
    STATE_TEXT,
  ];
  const group = groupPickedFiles(files);
  if (group.kind !== "run") throw new Error(`the fixture is not a run pick: ${group.kind}`);
  return importClaudeCodeRun({
    sessionText: texts[group.session],
    sidecars: group.sidecars.map((s) => ({
      jsonlText: texts[s.jsonl],
      metaJson: s.meta === null ? "" : texts[s.meta],
      ...(s.runId !== null ? { runId: s.runId } : {}),
    })),
    runStates: group.runStates.map((r) => ({ runId: r.runId, json: texts[r.file] })),
  });
}

/**
 * ONE `/api/claude/transcripts/content` answer, imported. This is what the
 * store row's click produces today — see "the door itself" at the foot of this
 * file, which reads `loadFromStore` off disk and holds that claim to the
 * component this suite has no DOM to click.
 */
function sessionFileAlone(): ReturnType<typeof detectAndLoad> {
  return detectAndLoad(SESSION_TEXT);
}

// ---- what the panel then reads ---------------------------------------------

const roster = (events: RunEvent[]): AgentInfo[] => normalizeReplay(reduceAll(initialState, events)).agents;

/** The row the panel draws for this run: the one item that launched something. */
const launchItem = (events: RunEvent[]): WorkItem => {
  const items = foldWork(events).filter((i) => i.runId === RUN || i.opaque !== null);
  expect(items, "the fixture must produce exactly one launching row").toHaveLength(1);
  return items[0];
};

/** What the store lists beside the session — the same three files, on disk. */
async function sidecarIndex(): Promise<SidecarIndex> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            agents: AGENTS.map((agentId, i) => ({
              agentId,
              path: `${AGENT_DIR}/${RUN}/agent-${agentId}.jsonl`,
              runId: RUN,
              bytes: 1024 + i,
              modifiedAt: T0 + i,
            })),
          }),
      } as unknown as Response),
    ),
  );
  return loadSidecarAgents(STORE_PATH);
}

afterEach(() => vi.unstubAllGlobals());

// ---- the measurement the card was cut from ---------------------------------

describe("the two doors over one recorded session", () => {
  it("the folder pick brings the run: its agents are in the stream", async () => {
    // The control. Every part of this path already works and already ships;
    // it is only unreachable from the list the owner clicks.
    const run = folderPick();
    const reading = besideReading(launchItem(run.events), roster(run.events), await sidecarIndex());

    expect(reading?.kind).toBe("inStream");
    expect(reading?.kind === "inStream" ? reading.agents : []).toEqual([...AGENTS]);
    expect(run.childrenMerged).toBe(AGENTS.length);
    expect(run.childrenSkipped).toBe(0);
    expect(run.childrenUnrecorded).toBe(0);
    // The roster the agents panel renders: the root, the run's node, one row
    // per agent. This is the "288" of the real session, in miniature.
    expect(roster(run.events)).toHaveLength(2 + AGENTS.length);
  });

  it("the session file alone brings none of them, and the row says so in files", async () => {
    // The owner's screenshot, measured rather than described: the agents are
    // named as clickable FILES beside the session, because the roster knows
    // nothing about them.
    const one = sessionFileAlone();
    const reading = besideReading(launchItem(one.events), roster(one.events), await sidecarIndex());

    expect(reading?.kind).toBe("files");
    expect(reading?.kind === "files" ? reading.files.length : 0).toBe(AGENTS.length);
    expect(roster(one.events)).toHaveLength(1); // just the root
    expect(one.events.length).toBeLessThan(folderPick().events.length);
  });
});

// ---- the requirement -------------------------------------------------------

describe("a store row must bring what the folder pick brings", () => {
  /**
   * The whole card in one line.
   *
   * The reading a row produces is the reading of whatever its ONE request
   * brings back, and the two cases above measure both possible answers. So the
   * demand is on the request: the row has to be able to ask the store for the
   * RUN. Until that route is asked for, the row can only ever produce the
   * second reading above, whatever else changes.
   */
  it("the row asks the store for the run", () => {
    expect(storeDoor()).toContain("/api/claude/transcripts/run");
  });

  it("and hands the answer to the coordinator, not to the single-file importer", () => {
    // AC2: the same three text inputs the folder pick builds, through the same
    // already-tested merge. A second merge written into the dialog is the way
    // the two doors start disagreeing about one session.
    expect(storeDoor()).toContain("importClaudeCodeRun");
  });

  it("and carries BOTH the store path and the run summary to onLoad", () => {
    // AC9. `storePath` is what keeps the deep link and the import address
    // right; `runSummary(run)` is what carries the merged/skipped/unrecorded
    // triple and the declared phases. A store run load needs both, and card
    // 315 is the record of what happens when a summary is assembled by hand at
    // a call site instead of by the importer's own narrowing.
    const door = storeDoor();
    expect(door).toContain("runSummary(");
    expect(door).toContain("tr.path");
  });

  it("keeps the single-file route as the escape, and does not delete it", () => {
    // Green today, and it must stay green: the secondary "session file only"
    // path and the degrade-over-the-ceiling path both land on this route.
    expect(storeDoor()).toContain("/api/claude/transcripts/content");
  });
});

// ---- the neighbour the fix makes true --------------------------------------

/**
 * The house rule after card 284: ask what the change makes TRUE for its
 * neighbours that was false before.
 *
 * A store run load answers BOTH questions at once — the merge puts the agents
 * in the roster, and `loadSidecarAgents(storePath)` still lists the same agents
 * as files beside the session. Two readings, one screen, the exact disagreement
 * card 313 was cut to end. `besideReading` already resolves it by asking the
 * roster first; this VERIFIES that against `workLevels.ts` as it stands rather
 * than reimplementing the rule somewhere new.
 */
describe("with the roster and the file listing both answering, the roster wins", () => {
  it("a merged run reads inStream even though the store listed the same files", async () => {
    const run = folderPick();
    const files = await sidecarIndex();

    expect(files.forRun(RUN)).toHaveLength(AGENTS.length); // the listing did answer
    expect(besideReading(launchItem(run.events), roster(run.events), files)?.kind).toBe("inStream");
  });
});

// ---- the door itself, read off disk ----------------------------------------

/**
 * `loadFromStore` is a closure inside a component and this suite has no DOM
 * (house rule), so the door is read as source — the same move
 * `declaredPhasesReachTheLab.test.tsx` makes for the two joins no unit test can
 * reach, and the same gap card 315 came out of.
 *
 * The slice is the store door only. A dialog-wide search would be satisfied by
 * `onFile`, which has done the right thing since card 291 — and a guard that a
 * neighbour can satisfy is not a guard.
 */
function storeDoor(): string {
  const src = stripComments(read("../components/ImportDialog.tsx", import.meta.url));
  const from = src.indexOf("const loadFromStore");
  const to = src.indexOf("const onFile", from + 1);
  expect(from, "ImportDialog no longer has a `loadFromStore`; this guard must follow it").toBeGreaterThan(-1);
  expect(to, "`onFile` no longer follows `loadFromStore`; this guard must follow it").toBeGreaterThan(from);
  return src.slice(from, to);
}
