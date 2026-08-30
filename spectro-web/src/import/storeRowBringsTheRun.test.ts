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
// AND THE DOOR IS DRIVEN, not grepped. The first version of this file held the
// requirement as four `toContain` searches over the source text of
// `loadFromStore`. A reviewer restored the defect three separate ways with every
// one of them green — the row wired to the session door, the coordinator called
// with `sidecars: []`, the run branch made unreachable — because none of those
// edits removes a substring. So the door moved out of the component into
// `storeDoor.ts`, where a test can call it with a stubbed store and measure what
// comes back, which is the only kind of guard the sentence above deserves.
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
import { degradeKey, onLoadArgs, openFromStore, RUN_DEGRADE_REASONS, type StoreLoad } from "./storeDoor";
import { dict, t } from "../i18n/i18n";

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

// ---- the requirement, driven ------------------------------------------------

/**
 * The store as the server answers it: the bundle on `/run`, the session file
 * alone on `/content`. Built off the SAME fixture the folder pick uses, so the
 * two doors are measured over one recorded session and a difference between
 * them is a difference in the door.
 *
 * @param over what this particular store does differently — a status the run
 *        route answers with, or a body that is not the shape
 */
function stubStore(over: { runStatus?: number; runBody?: unknown; contentStatus?: number } = {}): void {
  const bundle = {
    path: STORE_PATH,
    sessionText: SESSION_TEXT,
    limitBytes: 128 * 1024 * 1024,
    totalBytes: 109_063_005,
    sidecars: AGENTS.map((agentId, i) => ({
      agentId,
      runId: RUN,
      jsonlText: childText(agentId, T0 + 3_000 + i * 100),
      metaJson: META,
    })),
    runStates: [{ runId: RUN, json: STATE_TEXT }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/api/claude/transcripts/run")) {
        const status = over.runStatus ?? 200;
        return Promise.resolve({
          ok: status === 200,
          status,
          json: () => Promise.resolve(over.runBody ?? bundle),
          text: () => Promise.resolve(JSON.stringify(over.runBody ?? bundle)),
        } as unknown as Response);
      }
      const status = over.contentStatus ?? 200;
      return Promise.resolve({
        ok: status === 200,
        status,
        text: () => Promise.resolve(status === 200 ? SESSION_TEXT : ""),
      } as unknown as Response);
    }),
  );
}

const ROW = { path: STORE_PATH, file: "s1.jsonl" };

/** What the panel reads off a completed store load: the roster the merge left,
 *  against the file listing the same address also answers. */
const readingOf = async (load: StoreLoad): Promise<ReturnType<typeof besideReading>> =>
  besideReading(launchItem(load.events), roster(load.events), await sidecarIndex());

describe("a store row brings what the folder pick brings", () => {
  it("the run door puts the agents IN THE STREAM, over the same session", async () => {
    // The whole card in one measurement, and it is the reading — not a call
    // count, not a substring. Compare with the second case in the block above:
    // same session, same fixture, and the row that said "3 files sit beside
    // this" now says "3 agents of this run are in this stream".
    stubStore();
    const load = await openFromStore(ROW, "run", AGENTS.length, "en");
    const reading = await readingOf(load);

    expect(reading?.kind).toBe("inStream");
    expect(reading?.kind === "inStream" ? reading.agents : []).toEqual([...AGENTS]);
    expect(roster(load.events)).toHaveLength(2 + AGENTS.length);
    expect(load.events.length).toBe(folderPick().events.length);
    expect(load.note).toBeUndefined();
  });

  it("and the triple it reports is the folder pick's triple", async () => {
    // AC2: the same three text inputs through the same already-tested merge.
    stubStore();
    const load = await openFromStore(ROW, "run", AGENTS.length, "en");
    const control = folderPick();

    expect(load.run?.childrenMerged).toBe(control.childrenMerged);
    expect(load.run?.childrenSkipped).toBe(control.childrenSkipped);
    expect(load.run?.childrenUnrecorded).toBe(control.childrenUnrecorded);
    expect(load.run?.childrenMerged).toBe(AGENTS.length);
  });

  it("and hands onLoad BOTH the store path and the run summary", async () => {
    // AC9, read out of the argument list the dialog spreads rather than out of
    // its source text. The previous version of this guard sliced the component
    // and searched for `tr.path`, which is in the fetch URL either way — a
    // reviewer dropped `storePath` from the call and every case stayed green.
    stubStore();
    const args = onLoadArgs(await openFromStore(ROW, "run", AGENTS.length, "en"));

    expect(args[5], "a store load is an address, and onLoad must carry it").toBe(STORE_PATH);
    expect(args[6], "the summary comes from the importer's own narrowing").toBeDefined();
    expect(args[6]?.childrenMerged).toBe(AGENTS.length);
    expect(args[0].length, "the merged stream travels first").toBe(folderPick().events.length);
  });

  it("the session door is still reachable, and still brings the file alone", async () => {
    // The escape the owner asked for, and the shape every degrade lands in.
    stubStore();
    const load = await openFromStore(ROW, "session", AGENTS.length, "en");
    const reading = await readingOf(load);

    expect(reading?.kind).toBe("files");
    expect(roster(load.events)).toHaveLength(1);
    expect(load.run).toBeUndefined();
    expect(onLoadArgs(load)[5]).toBe(STORE_PATH);
  });
});

// ---- and a refusal degrades LOUDLY ------------------------------------------

describe("what the reader is told when the run does not arrive", () => {
  it("over the ceiling: the session file loads and the sentence names both numbers", async () => {
    // AC8. The 413's own two numbers, and the agent count the SERVER counted
    // while it weighed the bundle — not the row's cached one, which is what a
    // pruned sidecar folder makes stale.
    stubStore({ runStatus: 413, runBody: { totalBytes: 109_063_005, limitBytes: 67_108_864, agents: 240 } });
    const load = await openFromStore(ROW, "run", 13, "en");

    expect(roster(load.events)).toHaveLength(1); // the file, and only the file
    expect(load.note).toContain("104.0 MB");
    expect(load.note).toContain("64.0 MB");
    expect(load.note).toContain("240");
  });

  it("anything else that goes wrong ALSO loads the file, and says so", async () => {
    // The regression this closes: only a 413 degraded, so a 500 — the shape a
    // heap-starved server really answers with — left the reader with nothing
    // at all, where the door before this card loaded the session file.
    stubStore({ runStatus: 500 });
    const load = await openFromStore(ROW, "run", 13, "en");

    expect(roster(load.events)).toHaveLength(1);
    expect(load.note, "a silent nothing is this card's own defect in a new coat").toBeDefined();
    expect(load.note).toContain("500");
  });

  it("promised agents that are not on disk any more are announced, not swallowed", async () => {
    // The row's count comes from the facts cache, whose key is the SESSION
    // file's path, mtime and size — the sidecar directory is not in it. Prune
    // that directory and the row still promises N while the bundle honestly
    // carries none, and the merge of zero sidecars is byte-for-byte today's
    // single-file import. Without this the row promises the run and delivers
    // the defect.
    stubStore({ runBody: { path: STORE_PATH, sessionText: SESSION_TEXT, sidecars: [], runStates: [] } });
    const load = await openFromStore(ROW, "run", AGENTS.length, "en");

    expect(roster(load.events)).toHaveLength(1);
    expect(load.note).toContain(String(AGENTS.length));
  });

  it("every degrade reason has its own sentence in both languages", () => {
    // The codes are the mechanism, not the prose: a degrade matched by
    // substring goes soft the day somebody rewords the copy. Walked off the
    // exported list, so a fourth reason with no word for it is red here — and
    // the sentences must DIFFER, or two reasons have collapsed into one and the
    // reader cannot tell "too big" from "gone".
    const seen = new Set<string>();
    for (const reason of RUN_DEGRADE_REASONS) {
      const key = degradeKey(reason);
      expect(dict[key], `${key} is missing from the dictionary`).toBeDefined();
      for (const lang of ["en", "de"] as const) {
        const said = t(lang, key, { size: "104.0 MB", limit: "64.0 MB", agents: 240, status: 500 });
        expect(said, `${key}.${lang} fell back to the key`).not.toBe(key);
        seen.add(said);
      }
    }
    expect(seen.size, "each reason and language needs its own sentence").toBe(RUN_DEGRADE_REASONS.length * 2);
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
