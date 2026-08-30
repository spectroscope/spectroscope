// Card 322: the run's own state file reaches the CARD that draws it.
//
// The join was already computed and stopped one step short. `resolveRuns`
// reads the run id out of a launch's receipt and knows which `Workflow`
// tool_use it came back on (card 297); the pick already collects
// `<session>/workflows/<runId>.json` (`groupPickedFiles`); `readWorkflowState`
// already parses it (card 302); and the lab already draws the phases out of it
// (card 315). Nothing carried the file to the chat card, so a launch that
// named a script by path drew an empty SCRIPT region, an empty PHASES region,
// and "launched · no outcome recorded" over a run whose file records that it
// finished, how long it took and what it cost.
//
// This tests the CHAIN and not another link: recorded bytes in, an import-only
// frame out of the merge, through the reducer that patches it onto the card
// its call built, into the structured face that renders the program. Cut it
// anywhere and one of these goes red.
//
// The same class of hole as card 315's, one surface over: every half was
// tested and the wire between them was not.
//
// Every fixture here is synthetic. The SHAPES are measured — 2026-08-30 over
// ~/.claude/projects: 111 of 685 `Workflow` calls carry a `scriptPath` and no
// `script`, and all 591 state files carry `script`, `phases` and `status`.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { importClaudeCodeRun } from "./claudeCodeRun";
import { initialState, reduceAll } from "../state/reducer";
import { ToolViewBody } from "../components/ToolViewBody";
import { isWireEvent } from "../wire/nonWire";
import { setLang } from "../state/lang";
import { t } from "../i18n/i18n";

const T0 = Date.parse("2026-03-02T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (r: object): string => JSON.stringify(r);

const CALL_ID = "toolu_workflow_bypath";
const RUN_ID = "wf_run-bypath";

const RECEIPT = [
  "Workflow launched in background. Task ID: tskbypath",
  "Summary: rebuild the index, then prove it",
  `Run ID: ${RUN_ID}`,
].join("\n");

/** The script the call never carried — it named a file and sent the path. */
const SCRIPT = [
  "export const meta = {",
  '  name: "index-rebuild",',
  "  phases: [{ title: 'Survey' }, { title: 'Rebuild' }],",
  "};",
  "",
  "export default async function run(ctx) {",
  '  await ctx.phase("Survey", async () => ctx.log("counting"));',
  "}",
  "// end of index-rebuild",
].join("\n");

/** The session: a path-only `Workflow` launch and the receipt naming its run.
 *  No notification, so nothing in the transcript itself is an outcome — which
 *  is the case the card used to report as "no outcome recorded". */
const SESSION = [
  line({
    type: "user",
    uuid: "u1",
    timestamp: iso(T0),
    cwd: "/workspaces/demo-project",
    message: { role: "user", content: "rebuild the index" },
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
          id: CALL_ID,
          name: "Workflow",
          input: { scriptPath: "/tmp/wf/index-rebuild.js", args: '{"shards":7}' },
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
      content: [{ type: "tool_result", tool_use_id: CALL_ID, content: RECEIPT }],
    },
  }),
].join("\n");

/** `<session>/workflows/<runId>.json`, in the shape all 591 real ones share. */
const STATE = JSON.stringify({
  runId: RUN_ID,
  workflowName: "index-rebuild",
  script: SCRIPT,
  scriptPath: "/tmp/wf/index-rebuild.js",
  status: "completed",
  agentCount: 5,
  durationMs: 92_000,
  totalTokens: 431_000,
  totalToolCalls: 77,
  phases: [
    { title: "Survey", detail: "count what is on disk" },
    { title: "Rebuild", detail: "one agent per shard" },
  ],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Survey" },
    { type: "workflow_phase", index: 2, title: "Rebuild" },
  ],
});

/** The import, with the run state file or without it. */
function imported(withState: boolean) {
  return importClaudeCodeRun({
    sessionText: SESSION,
    sidecars: [],
    runStates: withState ? [{ runId: RUN_ID, json: STATE }] : [],
  });
}

/** The card the reducer built for the launch, after the whole stream. */
function cardOf(withState: boolean) {
  const state = reduceAll(initialState, imported(withState).events);
  const card = state.cards[CALL_ID];
  expect(card, "the reducer built no card for the launch").toBeDefined();
  return card;
}

/** That card's structured face, exactly as `ToolCard` mounts it. */
function markupOf(withState: boolean): string {
  setLang("en");
  const card = cardOf(withState);
  return renderToStaticMarkup(
    <ToolViewBody
      mode="structured"
      name={card.name}
      input={card.input}
      output={card.output}
      isError={false}
      denied={false}
      runState={card.runState}
    />,
  );
}

const strip = (markup: string): string => markup.replace(/<!--.*?-->/gs, "").replace(/<[^>]*>/g, "");

describe("card 322 — a run's state file reaches the card its launch built", () => {
  it("carries the file out of the import, keyed to the call the receipt named", () => {
    const frames = imported(true).events.filter(
      (e) => (e as unknown as { type: string }).type === "workflow_state",
    ) as unknown as { callId: string; runState: string }[];

    expect(frames).toHaveLength(1);
    // Keyed to the tool_use, not to the run id: the card is the CALL's.
    expect(frames[0].callId).toBe(CALL_ID);
    expect(frames[0].runState).toBe(STATE);
  });

  it("emits nothing at all when the pick carried no state file", () => {
    // The absent-first rule: an import without the file is byte for byte the
    // import it always was, and a frame with an empty payload would put an
    // empty card region where today there is an honest sentence.
    expect(
      imported(false).events.filter((e) => (e as unknown as { type: string }).type === "workflow_state"),
    ).toEqual([]);
  });

  it("keeps that frame out of anything a session file could hold", () => {
    // It is a file BESIDE the session, read by the importer — not a line of
    // this session's history. The Java reader would reject it and drop the
    // whole line without a word.
    const frame = imported(true).events.find(
      (e) => (e as unknown as { type: string }).type === "workflow_state",
    )!;
    expect(isWireEvent(frame as unknown as { type: string })).toBe(false);
  });

  it("patches it onto the card, and onto no other", () => {
    const state = reduceAll(initialState, imported(true).events);
    expect(state.cards[CALL_ID].runState).toBe(STATE);
    const carriers = Object.values(state.cards).filter((c) => c.runState !== undefined);
    expect(carriers.map((c) => c.callId)).toEqual([CALL_ID]);
  });

  it("leaves the card exactly as it was when there is no file", () => {
    expect(cardOf(false).runState).toBeUndefined();
  });

  it("draws the script, the phases and the outcome the call never carried", () => {
    const shown = strip(markupOf(true));

    expect(shown).toContain("export const meta = {");
    expect(shown).toContain("// end of index-rebuild");
    expect(shown).toContain("Survey");
    expect(shown).toContain("Rebuild");
    // The outcome, in place of the sentence that used to stand over it.
    expect(shown).toContain("completed");
    expect(shown).not.toContain(t("en", "tv.wfOpen"));
  });

  it("still says the honest sentence when the file is not there", () => {
    const shown = strip(markupOf(false));

    expect(shown).not.toContain("export const meta = {");
    expect(shown).toContain(t("en", "tv.wfOpen"));
  });
});
