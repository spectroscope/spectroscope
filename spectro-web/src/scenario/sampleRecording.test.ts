// The pin under card 310: the recording this repo ships is still the recording
// its own source produces.
//
// A committed artefact that quietly stops matching the code it came from is the
// drift this house keeps paying for — the file still opens, still looks like a
// run, and lies about which run. compile() is deterministic (fixed base
// timestamp, ids minted in order), so "still matching" is a byte comparison and
// not a judgement call.
//
// WHEN THIS GOES RED, THE FIX IS TO REGENERATE THE FILE. Every failure message
// below says so, because the cheap way out — widening the comparison until the
// stale file passes — would leave the repo shipping a recording nobody can
// trace to a scenario, which is the exact failure the pin exists to stop.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { groupPickedFiles } from "../import/claudeCodeRun";
import { detectAndLoad } from "../import/detect";
import { deriveDetail, sceneToFlow } from "../lab/flowmap/sceneToFlow";
import { advanceScene, initialScene } from "../lab/labScene";
import { declarationOf } from "./compile";
import { loc } from "./dsl";
import {
  SAMPLE_LANG,
  SAMPLE_PATH,
  SAMPLE_REGEN_COMMAND,
  SAMPLE_SCENARIO_ID,
  renderSampleRecording,
  sampleScenario,
} from "./sampleRecording";

/** The shipped file, resolved from THIS test's location so the pin does not
 *  depend on where vitest was started from. */
const onDisk = fileURLToPath(new URL(`../../../${SAMPLE_PATH}`, import.meta.url));

/** The signpost beside it, resolved the same way. */
const README_PATH = SAMPLE_PATH.replace(/[^/]+$/, "README.md");
const readmeOnDisk = fileURLToPath(new URL(`../../../${README_PATH}`, import.meta.url));

/**
 * The full type tally of the shipped file, measured 2026-08-29 with
 *
 *   npm run generate:sample-run   (then: cut -d'"' -f4 on the type field)
 *
 * All thirteen kinds, not a selection: a partial tally is green for a stream
 * that grew a fourteenth kind, and a new event type in a shipped sample is
 * exactly the change somebody should have to look at.
 */
const MEASURED_MIX: Record<string, number> = {
  run_start: 14,
  turn_start: 14,
  context_info: 1,
  thinking_delta: 1,
  tool_call: 31,
  agent_spawn: 13,
  agent_message: 39,
  tool_result: 31,
  usage: 14,
  text_delta: 14,
  run_end: 14,
  permission_request: 5,
  permission_decision: 5,
};

const fix = `regenerate it with \`${SAMPLE_REGEN_COMMAND}\` — do not loosen this test`;

describe(`the shipped recording ${SAMPLE_PATH}`, () => {
  it("exists", () => {
    expect(existsSync(onDisk), `${SAMPLE_PATH} is missing — ${fix}`).toBe(true);
  });

  it("is byte-identical to what its scenario compiles to today", () => {
    const shipped = readFileSync(onDisk, "utf8");
    const fresh = renderSampleRecording();
    // Line-by-line first: a 196-line diff of one string is unreadable, and the
    // first differing line is the whole answer.
    const shippedLines = shipped.split("\n");
    const freshLines = fresh.split("\n");
    const at = shippedLines.findIndex((line, i) => line !== freshLines[i]);
    expect(
      at,
      at < 0
        ? ""
        : `${SAMPLE_PATH} line ${at + 1} no longer matches compile("${SAMPLE_SCENARIO_ID}", "${SAMPLE_LANG}") — ${fix}\n` +
            `  shipped: ${shippedLines[at]?.slice(0, 200) ?? "<end of file>"}\n` +
            `  fresh:   ${freshLines[at]?.slice(0, 200) ?? "<end of file>"}`,
    ).toBe(-1);
    // And then the whole string, because a difference in LENGTH alone (a file
    // one line short, or one line long) leaves every compared line equal.
    expect(shipped, `${SAMPLE_PATH} is not byte-identical to its source — ${fix}`).toBe(fresh);
  });
});

describe("the shipped recording is still the run card 310 describes", () => {
  // Measured on the generated file, 2026-08-29. These are not a second opinion
  // about the bytes — that is the comparison above. They are here so that
  // regenerating after a scenario edit is a DECISION: if the workflow run stops
  // being 13 agents in 5 phases, this says so out loud instead of letting a
  // silent regeneration swap the shipped run for another one.
  //
  // Read inside each case, not once at module level: a missing file must fail
  // the case above with its own message, not blow the whole suite up during
  // collection with an ENOENT that names no fix.
  const events = (): RunEvent[] =>
    readFileSync(onDisk, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent);

  const note = `the scenario changed shape — decide whether that is wanted, then ${SAMPLE_REGEN_COMMAND}`;

  it("holds 196 events, one per line", () => {
    expect(events().length, note).toBe(196);
  });

  it("spawns the 13 named agents of the five phases", () => {
    const spawned = events()
      .filter((e) => e.type === "agent_spawn")
      .map((e) => e.agentId);
    expect(spawned, note).toEqual([
      "scope",
      "probe-1",
      "probe-2",
      "probe-3",
      "probe-4",
      "probe-5",
      "merge",
      "draft",
      "audit-1",
      "audit-2",
      "audit-3",
      "audit-4",
      "audit-5",
    ]);
  });

  it("opens on a run_start and closes on a run_end", () => {
    const all = events();
    expect(all[0].type, note).toBe("run_start");
    expect(all[all.length - 1].type, note).toBe("run_end");
  });

  it("carries the event mix the card measured", () => {
    const tally: Record<string, number> = {};
    for (const e of events()) tally[e.type] = (tally[e.type] ?? 0) + 1;
    expect(tally, note).toEqual(MEASURED_MIX);
  });
});

describe("the shipped recording opens the way the README says it does", () => {
  // The README tells a reader to drop this file into the import dialog. That
  // is a claim about the app's own reader, so it is checked here with the
  // app's own reader — detectAndLoad is exactly what ImportDialog calls on the
  // text of a picked file. Bytes that match their source and still fail to
  // load would be a sample nobody can use.
  it("reads back through detectAndLoad as a spectroscope session of 196 events", () => {
    const loaded = detectAndLoad(readFileSync(onDisk, "utf8"));
    expect(loaded.kind).toBe("spectroscope");
    expect(loaded.events.length).toBe(196);
    // A session, not one agent's transcript: the bar in the app says so, and a
    // sample that announced itself as a subagent would be teaching the wrong
    // thing about the format.
    expect(loaded.subagent).toBeUndefined();
  });
});

describe("the workflow the recording belongs to", () => {
  // THE OTHER HALF OF THE PIN, and it is not a second opinion about the bytes.
  //
  // A phase title and a phase's membership never reach the wire: `compile()`
  // emits spawns, messages and results, while `declarationOf()` reads
  // `dsl.phases` and hands the columns straight to the lab. So the byte
  // comparison above is blind to them — measured 2026-08-30 by renaming
  // "probe" to "REVIEW-BITE" and dropping probe-5 out of that phase in
  // registry.ts: every case in this file stayed GREEN, including the one that
  // lists the thirteen spawned ids, because the spawns are in the stream and
  // the columns are not.
  //
  // The card and docs/sample-runs/README.md both call this file a DECLARED
  // workflow of five named phases. That sentence needs a pin of its own, or
  // the shipped file keeps its bytes while the workflow it is advertised as
  // quietly becomes another one.
  const declared = () => declarationOf(sampleScenario(), SAMPLE_LANG)?.get("main");

  const note =
    `the declared workflow changed — the README and the card describe this file as five named ` +
    `phases holding 13 agents, so decide whether the change is wanted and update both, then ` +
    SAMPLE_REGEN_COMMAND;

  it("declares the five phases the README names, in order", () => {
    expect(
      declared()?.phases.map((p) => p.title),
      note,
    ).toEqual(["scope", "probe", "merge", "draft", "audit"]);
  });

  it("puts the named agents in the named phase", () => {
    expect(
      declared()?.phases.map((p) => p.members.map((m) => m.agentId)),
      note,
    ).toEqual([
      ["scope"],
      ["probe-1", "probe-2", "probe-3", "probe-4", "probe-5"],
      ["merge"],
      ["draft"],
      ["audit-1", "audit-2", "audit-3", "audit-4", "audit-5"],
    ]);
  });

  it("declares exactly the agents the shipped file spawns, in the same order", () => {
    // The seam between the two halves. Each half above can be right on its own
    // while the file records a run the columns do not describe — a declaration
    // naming an agent no line spawns, or a spawn standing in no column.
    const spawned = readFileSync(onDisk, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent)
      .filter((e) => e.type === "agent_spawn")
      .map((e) => e.agentId);
    const placed = (declared()?.phases ?? []).flatMap((p) => p.members.map((m) => m.agentId));
    expect(placed, note).toEqual(spawned);
  });
});

describe("what the shipped file draws in the lab, and what it does not", () => {
  // Card 310 fix round. The README used to promise that opening this file
  // replays "the lab with its workflow box". It does not, and this is the
  // measurement that says so — the app's own chain end to end: the shipped
  // bytes through `detectAndLoad`, the real scene fold, the real
  // `sceneToFlow`, with exactly the options `App` passes for each case.
  //
  // The reason is the one the block above states: the declaration is not on
  // the wire. `App.tsx` fills the lab's `declared` from `run?.declared`, which
  // only a Claude Code run import carries (its state file holds the phases),
  // and from `declarationOf()` when the run came from the scenario picker. A
  // picked `.jsonl` is neither, so the lab draws the recovered picture.
  //
  // BOTH ARMS ARE HERE ON PURPOSE. "No box" alone would also be green for a
  // sample that draws nothing at all, and it would read as a defect instead of
  // a boundary. The second arm shows the same bytes drawing the box the moment
  // a declaration is supplied, which is where the box actually lives.
  //
  // IF THE FIRST ARM GOES RED, that is good news, not drift: the wire learned
  // to carry a declaration. Update docs/sample-runs/README.md in the same pass
  // — it currently tells the reader the box is NOT in the file.

  /** The stream one event short of its own closing `run_end`.
   *
   *  Not a trick to make a number come out: the root's `run_end` retires every
   *  child, so the whole file folded to its last line holds no agent cards at
   *  all (measured: 0, with or without a declaration). A reader looking at
   *  agents is scrubbed INTO the run, and that is the position this asks
   *  about — the same cut card 306's pin uses for the same reason. */
  const inFlight = () => detectAndLoad(readFileSync(onDisk, "utf8")).events.slice(0, -1);

  const flowOf = (declared: ReturnType<typeof declarationOf>) => {
    const events = inFlight();
    const scene = events.reduce(advanceScene, initialScene());
    return sceneToFlow(scene, deriveDetail(events), {
      provider: "ollama",
      model: "m",
      lang: SAMPLE_LANG,
      declared,
    });
  };

  it("draws NO workflow box on import — the declaration is not in the bytes", () => {
    expect(
      flowOf(undefined).nodes.filter((n) => n.type === "wfbox"),
      `the shipped recording now draws a workflow box on a plain import — if the wire learned ` +
        `to carry the declaration, say so in ${README_PATH} instead of loosening this`,
    ).toEqual([]);
  });

  it("still puts the run's agents on the map, loose", () => {
    // The other side of that boundary: no box is not nothing. The agents are
    // there, they are simply not framed by anything, because nothing in the
    // file says which column each of them belongs to.
    const cards = flowOf(undefined).nodes.filter((n) => n.type === "subagent");
    expect(cards.length, `the import draws no agents at all — ${README_PATH} promises a run`).toBeGreaterThan(
      0,
    );
    expect(
      cards.filter((n) => n.parentId !== undefined),
      "loose means loose",
    ).toEqual([]);
  });

  it("brings no declaration in through the FOLDER picker either", () => {
    // The README offers two ways in, so both have to be answered. A folder
    // pick is grouped before anything is read, and the group is where a
    // declaration would have to come from: `App` fills the lab from
    // `run.declared`, which is built from the `runStates` of the pick. This
    // directory has none — it holds one recording and this signpost — so the
    // folder path lands on the same picture as the single file, and the
    // README's "a folder works too" does not quietly mean "and shows more".
    const picked = readdirSync(dirname(onDisk))
      .sort()
      .map((name) => ({ name, relativePath: `sample-runs/${name}` }));
    expect(picked.length, "the sample directory grew a file — decide what it is").toBeGreaterThan(1);
    const group = groupPickedFiles(picked);
    expect(group.kind).toBe("run"); // one session plus company
    if (group.kind !== "run") return;
    expect(picked[group.session].name).toBe(SAMPLE_PATH.replace(/^.*\//, ""));
    expect(group.runStates, "a run state file would carry phases — this one must not").toEqual([]);
  });

  it("draws exactly one box, from the same bytes, once the declaration is supplied", () => {
    const flow = flowOf(declarationOf(sampleScenario(), SAMPLE_LANG));
    const box = flow.nodes.filter((n) => n.type === "wfbox");
    expect(box, "the box the scenario picker shows is gone").toHaveLength(1);
    // And it holds the whole cast: the same thirteen the declaration names,
    // standing IN the box rather than beside it.
    expect(flow.nodes.filter((n) => n.parentId === box[0].id)).toHaveLength(13);
  });
});

describe("the README beside it says what is true today", () => {
  // The blocker this fix round came from: the README promised that opening
  // the file replays "the lab with its workflow box", and it draws none. A
  // docs page in a public repo is the third place a claim can be wrong, after
  // the code and the test, and it is the only one a reader trusts on sight.
  //
  // So the facts it quotes are read back off the artefacts they describe. Not
  // its prose — nobody should have to keep a sentence byte-identical to pass a
  // test — only the handful of things a reader would act on: the numbers, the
  // phase names, the entry in the picker, and the command that rewrites it.
  const readme = () => readFileSync(readmeOnDisk, "utf8");
  const fix = (what: string) => `${README_PATH} states a stale ${what} — correct the README`;

  it("quotes the file's real size", () => {
    const text = readFileSync(onDisk, "utf8");
    const lines = text.trimEnd().split("\n").length;
    const bytes = Buffer.byteLength(text, "utf8");
    const said = readme();
    expect(said.includes(String(lines)), fix(`line count (it is ${lines})`)).toBe(true);
    // Written with a thousands separator in the prose, so ask for the form a
    // reader actually sees.
    const grouped = bytes.toLocaleString("en-US");
    expect(said.includes(grouped), fix(`byte count (it is ${grouped})`)).toBe(true);
  });

  it("names the five phases the scenario declares", () => {
    const said = readme();
    for (const p of declarationOf(sampleScenario(), SAMPLE_LANG)?.get("main")?.phases ?? [])
      expect(said.includes(p.title), fix(`phase list — "${p.title}" is missing`)).toBe(true);
  });

  it("names the picker entry that shows the workflow box", () => {
    // The README sends a reader who wants the box to the scenario picker, and
    // names the row to look for. A renamed scenario would leave that reader
    // hunting a row that is not there.
    const name = loc(sampleScenario().name, SAMPLE_LANG);
    expect(readme().includes(name), fix(`scenario name (it is "${name}")`)).toBe(true);
  });

  it("names the command that regenerates the file", () => {
    expect(readme().includes(SAMPLE_REGEN_COMMAND), fix("regeneration command")).toBe(true);
  });
});
