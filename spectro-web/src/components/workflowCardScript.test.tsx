// Card 322: the workflow card shows its script.
//
// THE DEFECT, as the owner photographed it. A `Workflow` launch that carried
// only a `scriptPath` draws a card with no PHASES and no SCRIPT, an ARGUMENTS
// region holding a doubly-escaped JSON *string* (the reader reads backslashes),
// and the sentence "launched · no outcome recorded" over a run whose own state
// file records that it finished, how long it took, and what it cost.
//
// The renderer is not missing those sections — `ToolViewBody`'s `workflow`
// branch already draws all five. They are EMPTY, and empty for one reason:
// `describeTool` reads the script out of the CALL, and a path-only call has
// none. The script is not lost; it is in `<session>/workflows/<runId>.json`,
// beside the phases and the figures, and the app already reads those files
// (card 297 threads them in as `RunStateText`, card 315 carries the declared
// phases to the lab).
//
// THE SEAM THESE TESTS DEMAND, stated once so the build is not a guessing
// game: the run's own state TEXT reaches the card the way `detail` (card 167)
// and `fileChange` (card 269) already do — a new optional `runState` prop on
// `ToolViewBody`, handed on to `describeTool` as a seventh argument. Nothing
// here resolves WHICH file belongs to WHICH call; that is the caller's job,
// exactly as it is for `detail`.
//
// WHAT WAS MEASURED, and where it corrects the card (2026-08-30, over
// ~/.claude/projects — 590 state files, 684 `Workflow` tool_use calls):
//   - 590/590 state files carry `script`, `phases`, `status`, `agentCount`,
//     `durationMs`, `totalTokens`, `totalToolCalls`. Status is `completed` 541,
//     `killed` 42, `failed` 7 — no file in the store is mid-run.
//   - 111 of the 684 calls carry a `scriptPath` and no `script`. That is the
//     population this card exists for.
//   - `args` arrives 82 times, a STRING every time — and 7 of those 82 do NOT
//     parse as JSON. The card's premise said 53 of 53 parse; the non-JSON
//     branch is not hypothetical, it is seven real prose payloads, three of
//     them with real line breaks. It is the branch that lies today.
//   - the median script is 9,424 characters and 556 of 590 (94 %) are longer
//     than `CLIP_CHARS = 4000`. The fixture here is deliberately SHORT: these
//     tests are about the script arriving, not about the clip. AC 9 is left to
//     the build, which must decide with the owner between raising the reserve
//     and saying the cut out loud — `cut()` already appends "... (truncated)",
//     so AC 9 as written is nearly green today and a test here would have
//     foreclosed one of the owner's two branches.
//
// Assertions are on the RENDERED markup, never on a lookup returning a value.
// A view field that is populated and not drawn is the same defect from the
// reader's chair.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolViewBody } from "./ToolViewBody";
import { setLang } from "../state/lang";
import { t, type Lang } from "../i18n/i18n";

afterEach(() => setLang("en"));

// ---------------------------------------------------------------------------
// Reading the markup back
// ---------------------------------------------------------------------------

/** Markup → the text a reader sees. Comments go FIRST: React separates
 *  adjacent children with `<!-- -->`, and the highlighter's spans make the
 *  script one long run of them — left in, the separators would land inside the
 *  program text and every claim about it would be about a string nobody sees. */
function text(markup: string): string {
  return markup
    .replace(/<!--.*?-->/gs, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The end of the element opening at `from`, by counting `<div`/`</div>`.
 *  Counted rather than split on the next region, because a region body holds
 *  divs of its own (`tv-path`) and notes sit BETWEEN regions — a split would
 *  hand one region its neighbour's sentence. */
function divEnd(markup: string, from: number): number {
  let depth = 0;
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = from;
  for (let m = tag.exec(markup); m !== null; m = tag.exec(markup)) {
    depth += m[1] === "" ? 1 : -1;
    if (depth === 0) return m.index + m[0].length;
  }
  return markup.length;
}

type Region = { label: string; meta: string | null; body: string };

/** Every `<div class="tv-region">` of the card, in the order it was drawn. */
function regions(markup: string): Region[] {
  const found: Region[] = [];
  const open = /<div class="tv-region">/g;
  for (let m = open.exec(markup); m !== null; m = open.exec(markup)) {
    const whole = markup.slice(m.index, divEnd(markup, m.index));
    const headEnd = whole.indexOf("</div>") + "</div>".length;
    const head = whole.slice(0, headEnd);
    found.push({
      label: text(/<span class="tv-label">([\s\S]*?)<\/span>/.exec(head)?.[1] ?? ""),
      meta: (() => {
        const hit = /<span class="tv-meta tabular">([\s\S]*?)<\/span>/.exec(head);
        return hit === null ? null : text(hit[1]);
      })(),
      body: whole.slice(headEnd),
    });
  }
  return found;
}

/** The one region under `label`, or null when the card drew none. Null and ""
 *  are kept apart on purpose: "no region" and "an empty region under a
 *  heading" are the two outcomes AC 4 has to tell apart. */
function region(markup: string, label: string): Region | null {
  const hits = regions(markup).filter((r) => r.label === label);
  expect(hits.length, `regions labelled ${label}`).toBeLessThan(2);
  return hits[0] ?? null;
}

/** The labels of every region the card drew, in order. */
const labels = (markup: string): string[] => regions(markup).map((r) => r.label);

/** The outcome row as `key=value` pairs, in the order `runStats` chose. Read
 *  off the STRUCTURE, not off a substring of the page: "tokens" would be found
 *  in any script that mentions tokens, and a missing counter has to be provably
 *  missing, not merely unfound. */
function outcomeRow(markup: string): string[] {
  const row =
    /<li class="tv-run-stat[^"]*"><span class="tv-run-k">([\s\S]*?)<\/span><span class="tv-run-v mono tabular">([\s\S]*?)<\/span><\/li>/g;
  const out: string[] = [];
  for (let m = row.exec(markup); m !== null; m = row.exec(markup)) {
    out.push(`${text(m[1])}=${text(m[2])}`);
  }
  return out;
}

/** The phase list as the reader scans it: its number and its title. */
function phaseRows(markup: string): string[] {
  const li = /<li class="tv-entry">([\s\S]*?)<\/li>/g;
  const out: string[] = [];
  for (let m = li.exec(markup); m !== null; m = li.exec(markup)) out.push(text(m[1]).trim());
  return out;
}

// ---------------------------------------------------------------------------
// The fixtures — the SHAPE of the store, none of its content
// ---------------------------------------------------------------------------

/** An invented workflow, in the shape all 590 real ones share: an
 *  `export const meta` head with a `phases:` array, then the run itself.
 *  Deliberately under `CLIP_CHARS` — see the header. */
const SCRIPT = `export const meta = {
  name: "index-rebuild",
  description: "rebuild the search index, then prove it still answers",
  phases: [
    { title: "Survey", detail: "count what is on disk before anything moves" },
    { title: "Rebuild", detail: "one agent per shard" },
    { title: "Prove", detail: "query the fresh index and compare the counts" },
  ],
};

export default async function run(ctx) {
  const shards = await ctx.discover("shards/*.jsonl");
  const before = shards.length;

  await ctx.phase("Survey", async () => {
    ctx.log(\`found \${before} shards\`);
  });

  await ctx.phase("Rebuild", async () => {
    await ctx.parallel(
      shards.map((shard) =>
        ctx.agent({ label: \`rebuild:\${shard}\`, prompt: \`Rebuild \${shard}.\` }),
      ),
    );
  });

  await ctx.phase("Prove", async () => {
    const after = await ctx.discover("index/*.idx");
    if (after.length !== before) throw new Error("shard count moved under the rebuild");
  });

  return { shards: before };
}
// end of index-rebuild
`;

/** The first line, the last line, and one line whose leading spaces are the
 *  whole point — a program the reader cannot indent-read is not shown. */
const SCRIPT_HEAD = "export const meta = {";
const SCRIPT_TAIL = "// end of index-rebuild";
const SCRIPT_INDENTED = '  const shards = await ctx.discover("shards/*.jsonl");';

const PHASES = [
  { title: "Survey", detail: "count what is on disk before anything moves" },
  { title: "Rebuild", detail: "one agent per shard" },
  { title: "Prove", detail: "query the fresh index and compare the counts" },
];

/**
 * `workflowProgress`'s agent entries, one per word.
 *
 * The FILE's own bookkeeping of who ran and how it went, in the shape measured
 * over the store — 5,203 entries across 592 files, every one of them carrying
 * `label`, `phaseTitle` and `state`, the vocabulary being `done` (4,864),
 * `error` (228), `progress` (86) and `start` (25):
 *
 *   node -e '…' over ~/.claude/projects/**\/workflows/wf_*.json
 *
 * `agentCount` equals the number of these entries in 592 of 592 files, so a
 * fixture whose count and entries disagree is a shape the engine never writes.
 */
function agentEntries(states: readonly string[]): unknown[] {
  return states.map((state, i) => ({
    type: "workflow_agent",
    agentId: `a${i + 1}`,
    label: `rebuild:shard-0${i}`,
    phaseIndex: 2,
    phaseTitle: "Rebuild",
    model: "claude-opus-5",
    state,
    startedAt: 1787900050000 + i,
    durationMs: 90000,
  }));
}

/** Every top-level key a real state file carries, with invented values. */
const BASE_STATE = {
  runId: "wf_7c1e40a9-b2d",
  timestamp: "2026-08-28T09:14:02.117Z",
  taskId: "k3n2v9pq7",
  script: SCRIPT,
  scriptPath: "/tmp/wf/index-rebuild.js",
  args: { shards: "shards/*.jsonl" },
  result: { shards: 7 },
  agentCount: 7,
  logs: [],
  durationMs: 512430,
  summary: "rebuild the search index, then prove it still answers",
  workflowName: "index-rebuild",
  status: "completed",
  startTime: 1787900042117,
  phases: PHASES,
  defaultModel: "claude-opus-5",
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Survey" },
    { type: "workflow_phase", index: 2, title: "Rebuild" },
    ...agentEntries(["done", "done", "done", "done", "done", "done", "done"]),
  ],
  totalTokens: 918273,
  totalToolCalls: 164,
};

/** `<session>/workflows/<runId>.json`, as text — a key set to `undefined`
 *  drops out, which is how a file that never reported a counter is written. */
function stateJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE_STATE, ...over });
}

/** The call the owner photographed: a path and nothing else. 48 of the 684
 *  calls in the store are exactly this shape, 111 carry a path and no script. */
const PATH_ONLY = { scriptPath: "/tmp/wf/index-rebuild.js" };

/** The launch RECEIPT — no `--- task <id> · <status> ---` section, so nothing
 *  in the text itself is an outcome and the card reads `launched`. */
const RECEIPT = `Workflow launched in background. Task ID: k3n2v9pq7
Run ID: wf_7c1e40a9-b2d
Summary: rebuild the search index, then prove it still answers
Use the Monitor tool to watch it; the outcome arrives as its own notification.`;

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** The chat card's structured face, exactly as `ToolCard` mounts it.
 *
 *  `runState` is the seam this card must build: until it exists, TypeScript
 *  says so here, in ONE place, and vitest — which erases types — renders the
 *  card without it. That is the red these tests are written against. */
function card(opts: { input: unknown; output?: string; runState?: string; lang?: Lang }): string {
  setLang(opts.lang ?? "en");
  return renderToStaticMarkup(
    <ToolViewBody
      mode="structured"
      name="Workflow"
      input={opts.input}
      output={opts.output}
      isError={false}
      denied={false}
      runState={opts.runState}
    />,
  );
}

const EN = (key: Parameters<typeof t>[1]): string => t("en", key);

// ---------------------------------------------------------------------------
// The instrument, proved before it is trusted
// ---------------------------------------------------------------------------

describe("card 322 — the instrument reads the card that exists today", () => {
  // These four are GREEN, and that is their whole job. Every failure below is
  // an EMPTY result — no region, no rows — which is exactly what a broken
  // parser also returns. So each reader is first driven against markup the
  // renderer already produces: an INLINE script (which fills SCRIPT and PHASES
  // today, off `workflowMeta`) and a receipt carrying a joined outcome section
  // (which fills the run row today, off `workflowRun`). Green here and red
  // below can only mean the card is empty, not that the test cannot see.

  /** The same launch, joined to the outcome the importer appends to a receipt.
   *  The counters are the state file's four, so the row the card draws from
   *  this path is byte-identical to the row demanded of the state-file path. */
  const JOINED = `${RECEIPT}
--- task k3n2v9pq7 · completed ---
usage: agent_count=7 agents_done=7 subagent_tokens=918273 tool_uses=164 duration_ms=512430`;

  it("finds a SCRIPT region and reads the program out of it", () => {
    const markup = card({ input: { script: SCRIPT }, output: RECEIPT });
    const body = text(region(markup, EN("tv.script"))?.body ?? "");

    expect(body).toContain(SCRIPT_HEAD);
    expect(body).toContain(SCRIPT_TAIL);
    expect(body.split("\n")).toContain(SCRIPT_INDENTED);
  });

  it("finds a PHASES region and reads its rows", () => {
    const markup = card({ input: { script: SCRIPT }, output: RECEIPT });

    expect(phaseRows(markup)).toEqual(["1 Survey", "2 Rebuild", "3 Prove"]);
    expect(region(markup, EN("tv.phases"))?.meta).toBe("3 phases");
  });

  it("finds an OUTCOME region and reads its status and its figures", () => {
    const markup = card({ input: { script: SCRIPT }, output: JOINED });

    expect(region(markup, EN("tv.outcome"))?.meta).toBe("completed");
    expect(outcomeRow(markup)).toEqual(["agents=7 / 7", "tokens=918k", "tool calls=164", "elapsed=8 m 32 s"]);
    expect(text(markup)).not.toContain(EN("tv.wfOpen"));
  });

  it("keeps one region's body out of its neighbour's", () => {
    // `tv.wfOpen` is a `<p>` BETWEEN two regions and `tv-path` is a `<div>`
    // INSIDE one, so a reader that split on the next region marker instead of
    // balancing would hand the file region the sentence after it.
    const markup = card({ input: { script: SCRIPT }, output: RECEIPT });

    expect(text(markup)).toContain(EN("tv.wfOpen"));
    expect(text(region(markup, EN("tv.script"))?.body ?? "")).not.toContain(EN("tv.wfOpen"));
    expect(text(region(markup, EN("tv.workflow"))?.body ?? "")).not.toContain(EN("tv.wfOpen"));
  });
});

describe("card 322 — a path-only launch, with the run's own state loaded", () => {
  it("shows the script the call never carried", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson() });
    const script = region(markup, EN("tv.script"));

    expect(script, "no SCRIPT region was drawn").not.toBeNull();
    const body = text(script?.body ?? "");
    // Head AND tail: a script that arrives and is then cut in half is the
    // defect one step along, not a fix.
    expect(body).toContain(SCRIPT_HEAD);
    expect(body).toContain(SCRIPT_TAIL);
    // Its own indentation, byte for byte — the reference the owner showed is
    // readable because the shape of the program survived.
    expect(body.split("\n")).toContain(SCRIPT_INDENTED);
  });

  it("colours it as javascript, through the highlighter that already exists", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson() });
    const script = region(markup, EN("tv.script"));

    expect(script, "no SCRIPT region was drawn").not.toBeNull();
    // The existing branch renders `highlight(cut(view.script), "javascript")`
    // into `tv-well--script`. Both are asserted, so a second script renderer
    // or a plain `<pre>` would show up here rather than pass as equivalent.
    expect(script?.body ?? "").toContain('class="tv-well tv-well--script mono"');
    expect(script?.body ?? "").toMatch(/<span class="hl hl-[a-z]+">/);
  });

  it("lists the phases the run declared, off the state file", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson() });
    const phases = region(markup, EN("tv.phases"));

    expect(phases, "no PHASES region was drawn").not.toBeNull();
    expect(phaseRows(markup)).toEqual(["1 Survey", "2 Rebuild", "3 Prove"]);
    expect(phases?.meta).toBe("3 phases");
  });

  it("takes them from the file and not from a list somebody typed", () => {
    // THE BITE (AC 3). The state file declares a FOURTH phase the script's own
    // `meta` literal does not. No real file disagrees with its script — the
    // disagreement is the instrument, and the only one that can tell a
    // derivation from a hand-typed list wearing a loop (the card 312 lesson).
    // A card that answers "3" here is reading the wrong source; a card that
    // answers "1 Survey, 2 Rebuild, 3 Prove, 4 Retire" is reading the file.
    const fourth = { title: "Retire", detail: "drop the superseded shards" };
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ phases: [...PHASES, fourth] }),
    });

    expect(phaseRows(markup)).toEqual(["1 Survey", "2 Rebuild", "3 Prove", "4 Retire"]);
    expect(region(markup, EN("tv.phases"))?.meta).toBe("4 phases");
  });

  it("reads to its last line, at the length real scripts actually are", () => {
    // ADDED BY THE BUILD, not part of the red above — AC 9, which the card left
    // to a decision. The decision taken: raise the reserve for THIS region.
    //
    // `cut()` clips at 4,000 characters, and the store's median workflow script
    // is 9,417 with 557 of 591 over the clip — so 94 % of real scripts reached
    // the card halved. Every other clipped body is a slice of the call, and a
    // reader who wants the rest switches to the raw face; a script that came
    // out of the run's STATE file is in neither, because raw and json show the
    // call and the call carried a path. The reserve for the script region is
    // 48,000, over the store's longest script (44,380).
    const filler = Array.from({ length: 400 }, (_, i) => `  ctx.log("step ${i} of the long one");`);
    const long = [SCRIPT_HEAD, ...filler, SCRIPT_TAIL].join("\n");
    expect(long.length).toBeGreaterThan(9345);

    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson({ script: long }) });
    const body = text(region(markup, EN("tv.script"))?.body ?? "");

    expect(body).toContain(SCRIPT_TAIL);
    expect(body).not.toContain("(truncated)");
    // Its own indentation, at the far end of the file and not only at the top.
    expect(body.split("\n")).toContain('  ctx.log("step 399 of the long one");');
  });

  it("still names the file it was launched from", () => {
    // The path does not stop being useful once the script is here: it is where
    // the reader goes to edit it. Pinned so the build does not trade one
    // region for the other.
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson() });
    expect(text(region(markup, EN("tv.file"))?.body ?? "")).toContain("/tmp/wf/index-rebuild.js");
  });
});

describe("card 322 — the script is genuinely nowhere", () => {
  // GUARD, green today. It cannot go red until somebody makes it: it exists so
  // that the build above cannot be paid for by drawing an empty SCRIPT region
  // over every path-only call. The measured population is the launches whose
  // file the engine could not read at all.
  it("draws no SCRIPT region and no PHASES region — never an empty one", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT });

    expect(region(markup, EN("tv.script")), "an empty SCRIPT region").toBeNull();
    expect(region(markup, EN("tv.phases")), "an empty PHASES region").toBeNull();
    expect(labels(markup)).not.toContain(EN("tv.script"));
    expect(labels(markup)).not.toContain(EN("tv.phases"));
  });

  it("keeps the file it was pointed at, and today's sentence about the outcome", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT });

    expect(text(region(markup, EN("tv.file"))?.body ?? "")).toContain("/tmp/wf/index-rebuild.js");
    expect(text(markup)).toContain(EN("tv.wfOpen"));
  });
});

describe("card 322 — the arguments become readable", () => {
  const PAYLOAD = { repo: "/tmp/demo-repo", gateWorktree: "/tmp/demo-gate", shards: 7 };
  /** How every one of the 82 real payloads arrives: a JSON *string*, not an
   *  object. Rendered through `prettyJson` it is quoted once and escaped once
   *  more, which is the wall of backslashes in the owner's screenshot. */
  const AS_STRING = JSON.stringify(PAYLOAD);

  it("renders a JSON string as JSON — indented, one key per line", () => {
    const markup = card({ input: { ...PATH_ONLY, args: AS_STRING }, output: RECEIPT });
    const args = region(markup, EN("tv.args"));

    expect(args, "no ARGUMENTS region was drawn").not.toBeNull();
    const body = text(args?.body ?? "");

    // Nobody should be reading escapes. This is the owner's complaint, stated
    // as a fact about the page.
    expect(body).not.toContain('\\"');
    // One key per line, so the payload can be scanned rather than deciphered.
    const lineOf = (key: string): string[] => body.split("\n").filter((l) => l.includes(`"${key}"`));
    expect(lineOf("repo")).toHaveLength(1);
    expect(lineOf("gateWorktree")).toHaveLength(1);
    expect(lineOf("shards")).toHaveLength(1);
    expect(lineOf("repo")[0]).not.toContain("gateWorktree");
    // Indented, not a flat dump.
    expect(body.split("\n").some((l) => /^\s+"repo":/.test(l))).toBe(true);
    // And coloured by the highlighter that already knows `json`.
    expect(args?.body ?? "").toMatch(/<span class="hl hl-[a-z]+">/);
  });

  it("shows a payload that is NOT JSON as the string it is", () => {
    // The branch that lies. 7 of the 82 real payloads are prose, three of them
    // with real line breaks — today every one of them is printed as a single
    // quoted line with the breaks spelled `\n`. Half-unescaping is the other
    // way to fail this: the text must arrive as itself, or not be touched.
    const PROSE = [
      "CONTEXT — the index has drifted since the last rebuild.",
      'Rebuild every shard under "shards/", then prove the fresh index',
      "answers the same queries the old one did. Delete nothing.",
    ].join("\n");
    const markup = card({ input: { ...PATH_ONLY, args: PROSE }, output: RECEIPT });
    const args = region(markup, EN("tv.args"));

    expect(args, "no ARGUMENTS region was drawn").not.toBeNull();
    const body = text(args?.body ?? "");

    // Verbatim, with its line breaks as line breaks.
    expect(body).toContain(PROSE);
    // No escape sequence anywhere: not the breaks, not the quotes the prose
    // itself contains.
    expect(body).not.toContain("\\n");
    expect(body).not.toContain('\\"');
    // And not wrapped in the quotes `JSON.stringify` puts round a string.
    expect(body.trim().startsWith('"')).toBe(false);
    // The prose's OWN quotes survive — this is the half-unescaping trap: a
    // renderer that strips the wrapper by peeling one layer eats these too.
    expect(body).toContain('under "shards/"');
  });
});

describe("card 322 — the outcome line stops under-reporting", () => {
  it("reports what the state file records, in place of the open sentence", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson() });

    // Every figure off a named key: status, agentCount, totalTokens,
    // totalToolCalls, durationMs — in `runStats`' own order and format.
    expect(outcomeRow(markup)).toEqual(["agents=7 / 7", "tokens=918k", "tool calls=164", "elapsed=8 m 32 s"]);
    expect(region(markup, EN("tv.outcome"))?.meta).toBe("completed");
    // And the sentence it replaces is gone — a card that says both says
    // nothing.
    expect(text(markup)).not.toContain(EN("tv.wfOpen"));
  });

  it("leaves out a counter the file never reported, rather than printing zero", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ totalTokens: undefined, totalToolCalls: undefined }),
    });

    expect(outcomeRow(markup)).toEqual(["agents=7 / 7", "elapsed=8 m 32 s"]);
  });

  it("carries `killed` through as the file's own word", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({
        status: "killed",
        agentCount: 4,
        workflowProgress: agentEntries(["done", "done", "done", "done"]),
        durationMs: 61000,
        totalTokens: undefined,
        totalToolCalls: undefined,
      }),
    });

    // On the VALUE, never on a substring of prose: `assertFalse(contains(
    // "changed ("))` is green for "unchanged (", and this file will not repeat
    // that. 42 of the 590 state files in the store say `killed`.
    expect(region(markup, EN("tv.outcome"))?.meta).toBe("killed");
    expect(outcomeRow(markup)).toEqual(["agents=4 / 4", "elapsed=1 m 1 s"]);
  });

  it("says the figures in the reader's own language", () => {
    // No new copy is introduced by this card — every label is an existing
    // `tv.run.*` key. This is the pin that keeps it that way: a hard-coded
    // English word in the build would show up here and nowhere else.
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson(), lang: "de" });

    expect(outcomeRow(markup)).toEqual([
      "Agenten=7 / 7",
      "Tokens=918k",
      "Tool-Aufrufe=164",
      "Dauer=8 m 32 s",
    ]);
  });

  it("keeps today's sentence for a run that is still out there", () => {
    // GUARD, green today. A state file written MID-RUN records no ending, and
    // presenting one as an outcome is the failure this branch exists to
    // prevent. Constructed, not measured: 590 of 590 files in the store carry
    // an ending, because the engine rewrites the file when the run stops — so
    // the only honest way to hold this branch is to build the file by hand.
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({
        status: undefined,
        durationMs: undefined,
        totalTokens: undefined,
        totalToolCalls: undefined,
        agentCount: undefined,
        result: undefined,
      }),
    });

    expect(region(markup, EN("tv.outcome")), "an outcome over a run with no ending").toBeNull();
    expect(outcomeRow(markup)).toEqual([]);
    expect(text(markup)).toContain(EN("tv.wfOpen"));
  });
});

// ---------------------------------------------------------------------------
// Card 322, round two: what the first build claimed and did not read
// ---------------------------------------------------------------------------

describe("card 322 — the file's own agent bookkeeping", () => {
  // THE DEFECT. `readCardRunState` set `done`, `errors` and `failures` to
  // "nothing reported" and said so in three comments: the file "states nowhere
  // how many finished", losses are "counted nowhere in this file", it "names no
  // dead agent". All three are false. Measured over ~/.claude/projects, 592
  // state files:
  //
  //   workflow_agent entries          5,203, every one with label+phaseTitle
  //   their `state` vocabulary        done 4,864 · error 228 · progress 86 · start 25
  //   agentCount === entry count      592 / 592
  //   files holding a non-done agent  81 — of which 35 say status "completed"
  //
  // So a run whose file records seven dead agents drew `agents 17` and nothing
  // else, under a heading `runStats` documents as "a loss appears only when
  // there was one" — which makes a short row an affirmative claim of a clean
  // run. Those 35 files are the ones where the card said so and was wrong.

  it("counts the agents that finished, not only the agents there were", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({
        agentCount: 7,
        workflowProgress: agentEntries(["done", "done", "done", "done", "done", "error", "error"]),
      }),
    });

    // done / total, exactly as `agentsValue` prints the joined path's two
    // halves — and the losses in their own cell, which is what makes the SHORT
    // row on a clean run mean something.
    expect(outcomeRow(markup)).toEqual([
      "agents=5 / 7",
      "failed=2",
      "tokens=918k",
      "tool calls=164",
      "elapsed=8 m 32 s",
    ]);
  });

  it("says the two it could not name, rather than drawing an empty Failures list", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({
        agentCount: 7,
        workflowProgress: agentEntries(["done", "done", "done", "done", "done", "error", "error"]),
      }),
    });

    // The file carries `label` for every entry and an `error` string for the
    // 228 that failed, but `readWorkflowState` — the reader this card shares
    // with the lens — exposes neither reason. So the count travels and the
    // names do not, and the renderer's existing sentence for exactly that case
    // is the one that must appear. A FAILURES region here would be a list of
    // blanks under a heading.
    expect(region(markup, EN("tv.failures")), "a Failures region with nothing in it").toBeNull();
    expect(text(markup)).toContain(EN("tv.wfUnnamed").replace("{n}", "2"));
  });

  it("counts no loss where the file records none", () => {
    // The other direction, bitten on its own: a clean run must not grow a
    // `failed` cell, or the cell means nothing.
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson() });

    expect(outcomeRow(markup).some((cell) => cell.startsWith("failed="))).toBe(false);
    expect(text(markup)).not.toContain(EN("tv.wfUnnamed").replace("{n}", "0"));
  });

  it("counts neither half where the file listed no agents at all", () => {
    // 3 of the store's 592 files carry `agentCount` and no `workflow_agent`
    // entries. No entries is NOTHING REPORTED, not "nobody finished" — a zero
    // in the done half would be the card claiming a total loss off a silence.
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ workflowProgress: [] }),
    });

    expect(outcomeRow(markup)[0]).toBe("agents=7");
    expect(outcomeRow(markup).some((cell) => cell.startsWith("failed="))).toBe(false);
  });

  it("counts an agent still in flight as neither finished nor failed", () => {
    // `progress` and `start` are two of the four words the file uses (86 and 25
    // entries in the store). An agent wearing one of them has not finished and
    // has not died, and rounding it into either half would be this card
    // inventing an ending for it.
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({
        agentCount: 4,
        workflowProgress: agentEntries(["done", "done", "progress", "start"]),
      }),
    });

    expect(outcomeRow(markup)[0]).toBe("agents=2 / 4");
    expect(outcomeRow(markup).some((cell) => cell.startsWith("failed="))).toBe(false);
  });
});

describe("card 322 — a run that has not ended is not an outcome", () => {
  // THE DEFECT. The guard for AC 8 was `status === null`, so ANY word became an
  // ending: the OUTCOME region drew, `tv.wfOpen` vanished, and the run's
  // half-way counters were printed as its final ones. The fixture that pinned
  // it removed the `status` key altogether — the one shape the engine is not
  // known to write. Its own word for a workflow in flight is `running`:
  //
  //   grep -ohE '\{[^{}]*"task_type":"local_workflow"[^{}]*\}' -r \
  //     ~/.claude/projects --include='*.jsonl' | grep -o '"status":"[a-z_]*"' | sort | uniq -c
  //   → 35 × "status":"running"

  it("keeps the open sentence for a file whose status says the run is running", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ status: "running" }),
    });

    expect(region(markup, EN("tv.outcome")), "an outcome over a run still going").toBeNull();
    expect(outcomeRow(markup)).toEqual([]);
    expect(text(markup)).toContain(EN("tv.wfOpen"));
  });

  it("still shows the script and the phases of a run that is running", () => {
    // The bound on the fix, bitten separately: what the file says the run IS
    // stays true while it runs. Only the ENDING is withheld.
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ status: "running" }),
    });

    expect(text(region(markup, EN("tv.script"))?.body ?? "")).toContain(SCRIPT_HEAD);
    expect(phaseRows(markup)).toEqual(["1 Survey", "2 Rebuild", "3 Prove"]);
  });

  it("carries an ending word through, so the gate cannot swallow the outcome", () => {
    // The opposite bite. A gate that refuses everything it does not recognise
    // would put the card back to "no outcome recorded" over 592 of 592 files.
    for (const status of ["completed", "killed", "failed"]) {
      const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson({ status }) });
      expect(region(markup, EN("tv.outcome"))?.meta, status).toBe(status);
      expect(text(markup), status).not.toContain(EN("tv.wfOpen"));
    }
  });
});

describe("card 322 — a field the file left blank is not a region", () => {
  // `str` keeps "", so without a guard a file carrying `"script": ""` draws the
  // empty well under a heading that AC 4 calls the one thing this card must not
  // draw. Each branch bitten on its own: one case per field.

  it("draws no SCRIPT region for a file whose script is the empty string", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson({ script: "" }) });

    expect(labels(markup)).not.toContain(EN("tv.script"));
  });

  it("draws no OUTCOME region for a file whose status is the empty string", () => {
    const markup = card({ input: PATH_ONLY, output: RECEIPT, runState: stateJson({ status: "" }) });

    expect(labels(markup)).not.toContain(EN("tv.outcome"));
    expect(text(markup)).toContain(EN("tv.wfOpen"));
  });

  it("draws no FILE region for a file whose scriptPath is the empty string", () => {
    const markup = card({
      input: { name: "index-rebuild" },
      output: RECEIPT,
      runState: stateJson({ scriptPath: "" }),
    });

    expect(labels(markup)).not.toContain(EN("tv.file"));
  });
});

describe("card 322 — a phase keeps the number the file gave it", () => {
  // THE DEFECT. The read filtered untitled phases out while the renderer numbers
  // by POSITION, so a file declaring [Survey, untitled, Prove] drew "1 Survey,
  // 2 Prove" — and the run's own second phase is not Prove. The comment above
  // the read claimed the card and the lens "agree on what a phase entry IS by
  // construction"; `workflowGraph.ts` keeps an untitled entry, so they did not.
  // 0 of the store's 1,488 phase entries are untitled — this is what happens
  // when one is.

  const GAPPED = [{ title: "Survey" }, { detail: "the one the file never named" }, { title: "Prove" }];

  it("draws the row the file declared, blank title and all", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ script: undefined, phases: GAPPED }),
    });

    expect(phaseRows(markup)).toEqual(["1 Survey", "2", "3 Prove"]);
  });

  it("counts it too, so the heading and the list say the same number", () => {
    const markup = card({
      input: PATH_ONLY,
      output: RECEIPT,
      runState: stateJson({ script: undefined, phases: GAPPED }),
    });

    expect(region(markup, EN("tv.phases"))?.meta).toBe("3 phases");
  });
});

describe("card 322 — the arguments well has the reserve its content needs", () => {
  /** A payload that pretty-prints past `CLIP_CHARS`. Five of the store's 76
   *  parsing payloads do (4,817 · 5,040 · 6,936 · 7,191 · 8,381), and all five
   *  are over 4,000 RAW as well — so the raw face, the fallback the script's
   *  own reserve was argued from, is cut at the same place. */
  const BIG = JSON.stringify(
    Object.fromEntries([
      ...Array.from({ length: 300 }, (_, i) => [`key_${String(i).padStart(3, "0")}`, `value ${i}`]),
      ["zz_last_key", "the end of the payload"],
    ]),
  );

  it("reaches the last key of an oversized payload", () => {
    expect(JSON.stringify(JSON.parse(BIG), null, 2).length).toBeGreaterThan(4000);
    const markup = card({ input: { ...PATH_ONLY, args: BIG }, output: RECEIPT });
    const body = text(region(markup, EN("tv.args"))?.body ?? "");

    expect(body).toContain("zz_last_key");
    expect(body).not.toContain("(truncated)");
  });
});

describe("card 322 — the arguments keep their three readings", () => {
  it("colours the payload's parts, not merely something", () => {
    // The old assertion was /hl-[a-z]+/, which any grammar in the registry
    // satisfies. Pinned on the TOKENS instead: `json` and `javascript` render
    // valid JSON byte-identically (JSON is a subset), so the grammar's NAME is
    // not a thing a test can see — what it can see is that a string reads as a
    // string, a number as a number and `true` as a keyword.
    const markup = card({
      input: { ...PATH_ONLY, args: JSON.stringify({ repo: "/tmp/demo", shards: 7, dry: true }) },
      output: RECEIPT,
    });
    const html = region(markup, EN("tv.args"))?.body ?? "";

    expect(html).toContain('<span class="hl hl-string">&quot;repo&quot;</span>');
    expect(html).toContain('<span class="hl hl-number">7</span>');
    expect(html).toContain('<span class="hl hl-keyword">true</span>');
  });

  it("keeps the input reading for a payload that arrived as an object", () => {
    // The third branch, which no store payload takes today — 83 of 83 arrive
    // as strings. It is drawn all the same, because `describeTool` yields it
    // and a view field that is populated and not drawn is the same defect as a
    // missing one.
    const markup = card({
      input: { ...PATH_ONLY, args: { repo: "/tmp/demo-repo", shards: 7 } },
      output: RECEIPT,
    });
    const body = text(region(markup, EN("tv.args"))?.body ?? "");

    expect(body).toContain("repo");
    expect(body).toContain("/tmp/demo-repo");
  });
});
