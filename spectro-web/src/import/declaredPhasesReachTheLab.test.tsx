// Card 315: the declared phases are computed on import and were dropped
// before the lab ever saw them.
//
// Card 302 taught the importer to read a workflow run's own state file and
// hand back what the run DECLARED before it ran, keyed by the node its agents
// hang under. Card 306 taught the lens to draw exactly that: named columns,
// solid edges, a legend that says "declared". Both halves were tested. The
// wire between them was not, and it was cut: the dialog built the summary as a
// literal with four fields, `declared` was not one of them, and every imported
// run reached the lab as a reconstruction.
//
// It stayed invisible because the OTHER producer of a declaration — a compiled
// scenario — reaches the same state through its own line in App.tsx. So the
// declared picture was demonstrable at any time, on a demo, and unreachable
// for the thing the release is about.
//
// This file tests the CHAIN, not another link: recorded bytes in, declaration
// out of the importer, through the summary the dialog hands over, through the
// gate that stamps it with its session, into the lens that draws it. Cut it
// anywhere and one of these goes red.
//
// Every fixture here is synthetic.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Background: () => null,
  Controls: () => null,
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
}));

import { importClaudeCodeRun, runSummary, type ImportedRunSummary } from "./claudeCodeRun";
import { importedPhasesOf } from "../lab/workflowGraph";
import { advanceScene, initialScene } from "../lab/labScene";
import { WorkflowLens } from "../lab/workflow/WorkflowLens";
import { boxNodeId, deriveDetail, sceneToFlow } from "../lab/flowmap/sceneToFlow";
import { setLang } from "../state/lang";
import { t } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";

// ---- a synthetic recorded run -------------------------------------------

const T0 = Date.parse("2026-03-02T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (r: object): string => JSON.stringify(r);

const RECEIPT = [
  "Workflow launched in background. Task ID: tsknynthetic",
  "Summary: survey the board, then diagnose",
  "Run ID: wf_run-synthetic",
].join("\n");

/** The session: a `Workflow` tool_use, the receipt that names its run, and the
 *  notification that ends it. */
const SESSION = [
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
        {
          type: "tool_use",
          id: "toolu_workflow_synthetic",
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
      content: [{ type: "tool_result", tool_use_id: "toolu_workflow_synthetic", content: RECEIPT }],
    },
  }),
  line({
    type: "user",
    uuid: "u3",
    timestamp: iso(T0 + 60_000),
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>tsknynthetic</task-id>\n" +
        "<tool-use-id>toolu_workflow_synthetic</tool-use-id>\n" +
        "<status>completed</status>\n<summary>the run came back</summary>\n</task-notification>",
    },
  }),
].join("\n");

const child = (agentId: string, prompt: string, answer: string, startMs: number): string =>
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

/** What a workflow child's meta really carries: no tool_use id at all, which
 *  is why the sidecar names the run its directory sat in instead. */
const CHILD_META = line({ agentType: "workflow-subagent", spawnDepth: 1 });

const SIDECARS = [
  {
    jsonlText: child("c1aaaaa", "walk the open column", "done", T0 + 3_000),
    metaJson: CHILD_META,
    runId: "wf_run-synthetic",
  },
  {
    jsonlText: child("c2bbbbb", "read the three in depth", "done", T0 + 4_000),
    metaJson: CHILD_META,
    runId: "wf_run-synthetic",
  },
];

const agentRecord = (agentId: string, label: string, phaseIndex: number, phaseTitle: string): object => ({
  type: "workflow_agent",
  index: phaseIndex,
  label,
  phaseIndex,
  phaseTitle,
  agentId,
  model: "test-model-child",
  state: "done",
  promptPreview: "the shared preamble",
});

/** The run's own state file, with the two phases the script declared. */
const STATE_WITH_PHASES = JSON.stringify({
  runId: "wf_run-synthetic",
  workflowName: "survey-then-diagnose",
  status: "completed",
  phases: [
    { title: "Survey", detail: "walk every open card" },
    { title: "Diagnose", detail: "three of them in depth" },
  ],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Survey" },
    { type: "workflow_phase", index: 2, title: "Diagnose" },
    agentRecord("c1aaaaa", "walk-the-open-column", 1, "Survey"),
    agentRecord("c2bbbbb", "read-three-in-depth", 2, "Diagnose"),
  ],
});

/** The same run, recorded by a script that declared no phases at all. Its
 *  agents are still named; its columns are not. */
const STATE_WITHOUT_PHASES = JSON.stringify({
  runId: "wf_run-synthetic",
  workflowName: "survey-then-diagnose",
  status: "completed",
  workflowProgress: [
    agentRecord("c1aaaaa", "walk-the-open-column", 1, "Survey"),
    agentRecord("c2bbbbb", "read-three-in-depth", 1, "Survey"),
  ],
});

/** The pick a reader makes: the session folder, its two sidecars, and the run
 *  state file when the recording has one. */
const importedWith = (json: string | null): ImportedRunSummary =>
  runSummary(
    importClaudeCodeRun({
      sessionText: SESSION,
      sidecars: SIDECARS,
      runStates: json === null ? [] : [{ runId: "wf_run-synthetic", json }],
    }),
  );

const eventsWith = (json: string | null) =>
  importClaudeCodeRun({
    sessionText: SESSION,
    sidecars: SIDECARS,
    runStates: json === null ? [] : [{ runId: "wf_run-synthetic", json }],
  }).events;

// ---- the wire ------------------------------------------------------------

describe("the summary the dialog hands over carries what the importer measured", () => {
  it("a run whose script declared phases arrives declared", () => {
    // THE DEFECT. The importer computed this from card 302 on; the summary
    // dropped it, so no imported run ever reached the lab with it.
    const summary = importedWith(STATE_WITH_PHASES);
    const decl = summary.declared?.get("toolu_workflow_synthetic");
    expect(decl, "the run's declaration is missing from the summary").toBeDefined();
    expect(decl!.phases.map((p) => p.title)).toEqual(["Survey", "Diagnose"]);
    expect(decl!.phases[0].detail).toBe("walk every open card");
    expect(decl!.phases[0].members.map((m) => m.agentId)).toEqual(["c1aaaaa"]);
    expect(decl!.phases[1].members.map((m) => m.agentId)).toEqual(["c2bbbbb"]);
  });

  it("keeps the four fields card 291 and card 297 measure", () => {
    // The summary is narrowed by hand, so every field it drops is a field
    // nothing else can restore. This is the rest of the narrowing, held.
    const summary = importedWith(STATE_WITH_PHASES);
    expect(summary.workspace).toBe("/workspaces/demo-project");
    expect(summary.childrenMerged).toBe(2);
    expect(summary.childrenSkipped).toBe(0);
    expect(summary.childrenUnrecorded).toBe(0);
  });

  it("carries no stream into the value the app keeps", () => {
    // The narrowing is the point: `ClaudeCodeRunImport` is structurally an
    // `ImportedRunSummary`, so handing the whole result over would compile and
    // would park the events and the origin map in app state for the life of
    // the session.
    expect(Object.keys(importedWith(STATE_WITH_PHASES)).sort()).toEqual([
      "childrenMerged",
      "childrenSkipped",
      "childrenUnrecorded",
      "declared",
      "workspace",
    ]);
  });
});

describe("the gate says which session may draw a declaration, and whether there is one", () => {
  it("an import that declared phases reaches the lab, stamped with its session", () => {
    const stamped = importedPhasesOf(
      "import:claude-code:run.jsonl",
      importedWith(STATE_WITH_PHASES).declared,
    );
    expect(stamped).not.toBeNull();
    expect(stamped!.sessionId).toBe("import:claude-code:run.jsonl");
    expect([...stamped!.declared.keys()]).toEqual(["toolu_workflow_synthetic"]);
  });

  it("an import whose state file listed no phases gets null, not an empty declaration", () => {
    // The other direction, bitten on its own. A run that declared nothing must
    // not arrive LOOKING declared: an empty map would light the lens's
    // declared branch over a picture with no columns in it.
    const summary = importedWith(STATE_WITHOUT_PHASES);
    expect(summary.declared?.size ?? 0).toBe(0);
    expect(importedPhasesOf("import:claude-code:run.jsonl", summary.declared)).toBeNull();
  });

  it("an import that carried no state file at all gets null", () => {
    expect(importedPhasesOf("import:claude-code:run.jsonl", importedWith(null).declared)).toBeNull();
  });

  it("a lone-file import, which builds no summary at all, gets null", () => {
    // `openImport` reads `run?.declared` and a single pick passes no run. The
    // gate must answer that with null rather than with an undefined it would
    // then have to stamp.
    expect(importedPhasesOf("import:claude-code:one.jsonl", undefined)).toBeNull();
  });
});

// ---- the lab, driven with what actually travelled ------------------------

describe("the lens draws the imported run's own columns", () => {
  const lensFor = (json: string | null) => {
    const events = eventsWith(json);
    const declared = importedPhasesOf("import:claude-code:run.jsonl", importedWith(json).declared);
    const scene = events.reduce((s, e) => advanceScene(s, e), initialScene());
    return renderToStaticMarkup(
      <WorkflowLens
        events={events}
        applied={events}
        scene={scene}
        {...(declared !== null ? { declared: declared.declared } : {})}
      />,
    );
  };

  it("declared: the recorded phase titles are on the columns and the legend says declared", () => {
    setLang("en");
    const html = lensFor(STATE_WITH_PHASES);
    expect(html).toContain("wf-ranklabel");
    expect(html).toContain("Survey");
    expect(html).toContain("Diagnose");
    expect(html).toContain(t("en", "lab.lens.legendDeclared"));
  });

  it("declared, in German too — the chrome switches, the run's own words do not", () => {
    // The phase titles come out of the recording, so they are the same in both
    // locales on purpose. What must follow the chrome is the sentence that
    // says WHICH picture this is.
    setLang("de");
    const html = lensFor(STATE_WITH_PHASES);
    expect(html).toContain(t("de", "lab.lens.legendDeclared"));
    expect(html).not.toContain(t("de", "lab.lens.legend"));
    expect(html).toContain("Survey");
    setLang("en");
  });

  it("recovered: the same import without a state file names no column and says recovered", () => {
    setLang("en");
    const html = lensFor(null);
    expect(html).not.toContain("wf-ranklabel");
    expect(html).toContain(t("en", "lab.lens.sourceRecovered"));
    expect(html).not.toContain(t("en", "lab.lens.legendDeclared"));
  });
});

// ---- the neighbour the same value now reaches ----------------------------

/**
 * The house rule after card 284: ask what the fix makes TRUE for the
 * neighbours that was false before. `replay.declared` feeds TWO readers in
 * LabView — the lens above and the MAP (card 306) — off the same field, so
 * the map has been drawing every imported run's agents as loose cards with
 * nothing saying which phase any of them ran in, and now it will not.
 *
 * That is not free: a scenario's declaration is keyed "main", the root, while
 * an import's is keyed by the `Workflow` tool_use id, a CHILD card. A map that
 * only knew how to seat a box on the root would have looked right for every
 * demo and drawn nothing for a real import. It seats both, and this says so.
 */
describe("the map seats the imported run's agents in their declared bands", () => {
  /**
   * The map is drawn at the CURSOR, from `st.applied` — the prefix the reader
   * has stepped to — not from the whole file. That distinction is load-bearing
   * here and was measured, not assumed: the root's own `run_end` RETIRES every
   * subagent card (labScene, "only the root run ending retires them"), so a
   * fold over the complete stream leaves the map with no agents to seat and a
   * box with two empty bands. Reading a run means standing inside it, so the
   * cursor here stands where a reader stands: at the last frame before the
   * root run ends.
   */
  const flowFor = (json: string | null) => {
    const events = eventsWith(json);
    const ends = events.findIndex(
      (e) => e.type === "run_end" && (e as { runId?: string }).runId === "cc-import",
    );
    const applied = events.slice(0, ends);
    const stamped = importedPhasesOf("import:claude-code:run.jsonl", importedWith(json).declared);
    const scene = applied.reduce((s, e) => advanceScene(s, e), initialScene());
    return sceneToFlow(scene, deriveDetail(applied), {
      provider: "anthropic",
      model: "m",
      ...(stamped !== null ? { declared: stamped.declared } : {}),
    });
  };

  it("declared: one box, keyed by the run's own node and not by the root", () => {
    const flow = flowFor(STATE_WITH_PHASES);
    expect(flow.nodes.filter((n) => n.type === "wfbox").map((n) => n.id)).toEqual([
      boxNodeId("toolu_workflow_synthetic"),
    ]);
  });

  it("declared: the box's bands carry the recorded titles, and each holds its agent", () => {
    const box = flowFor(STATE_WITH_PHASES).nodes.find((n) => n.type === "wfbox")!;
    const bands = (box.data as { bands: { title: string; detail: string | null; count: number }[] }).bands;
    expect(bands.map((b) => b.title)).toEqual(["Survey", "Diagnose"]);
    expect(bands.map((b) => b.detail)).toEqual(["walk every open card", "three of them in depth"]);
    // Not a formality: a box drawn with two named bands and nothing standing
    // in either says the phases ran empty, which this run did not.
    expect(bands.map((b) => b.count)).toEqual([1, 1]);
  });

  it("declared: each recorded agent becomes a child of that box", () => {
    const flow = flowFor(STATE_WITH_PHASES);
    for (const id of ["c1aaaaa", "c2bbbbb"]) {
      expect(flow.nodes.find((n) => n.id === `sub-${id}`)?.parentId).toBe(
        boxNodeId("toolu_workflow_synthetic"),
      );
    }
  });

  it("recovered: the same import without a state file gets no box at all", () => {
    expect(flowFor(null).nodes.filter((n) => n.type === "wfbox")).toEqual([]);
  });
});

// ---- the two joins no unit test can reach --------------------------------

/**
 * Read off disk, because both ends of this wire live inside components this
 * suite has no DOM to drive: the dialog's `onFile` fires on a file input, and
 * `openImport` is a closure in App. Everything above pins what the seams DO;
 * these pin that the two call sites still USE them. That is the exact gap card
 * 315 came out of — the importer measured, the lens drew, and the literal
 * between them quietly named four fields out of five while 5,600 tests stayed
 * green.
 */
describe("the two call sites still go through the tested seams", () => {
  const dialog = stripComments(read("../components/ImportDialog.tsx", import.meta.url));
  const app = stripComments(read("../App.tsx", import.meta.url));

  it("the dialog hands over `runSummary(run)`, and builds no summary of its own", () => {
    expect(dialog).toContain("runSummary(run)");
    // The literal that dropped the field. Any field name from the interface
    // appearing as a key HERE means a second, hand-maintained summary is back.
    expect(dialog).not.toMatch(/childrenUnrecorded\s*:/);
    expect(dialog).not.toMatch(/childrenMerged\s*:/);
  });

  it("an import's declared phases go through the gate, off the summary", () => {
    expect(app).toContain("importedPhasesOf(sessionId, run?.declared)");
  });

  it("a scenario's declaration goes through the SAME gate", () => {
    // One gate, or the stamp and the empty-map refusal exist twice and one
    // copy can rot. `declarationOf` returns undefined rather than an empty
    // map, so routing it here changed nothing and keeps it that way.
    expect(app).toContain("importedPhasesOf(sessionId, declarationOf(dsl, lang))");
  });
});
