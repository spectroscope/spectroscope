// Card 314: the workflow whose SHAPE IS THE FAN-OUT.
//
// "workflow-phases" (card 302) is a five-stage pipeline that happens to
// contain two fan-outs; this one is a single wide phase with a scope in front
// of it and a sign-off behind it, which is the picture the owner asked to be
// able to load by name.
//
// THE TWO SIDES ARE WRITTEN AND DECLARED, and they are not the same source.
// The first cut of this suite assembled the scenario's copy out of the very
// array the cases then derived their expectation from, so "asks for exactly
// the checks the fan-out runs" could only prove that a join of a list contains
// that list. Measured, not argued: renaming one worker's subject to "the
// release notes" — work no agent in this scenario does — left all seventeen
// cases green.
//
// So the copy is now WRITTEN OUT, in both locales. SEVEN of the twenty-one
// cases below hold those written words against the phases as DECLARED, and
// the seven are named so the number and the list have to agree: the two
// numbers in the name, the guard against a third number in it, the counts the
// copy says out loud, the ask, the noun each check is given, and the caption
// under the wide box.
//
// The other fourteen hold something else — the declaration against the
// compiled stream, the stream against the rendered markup, the copy against
// our CLI's own source, the copy against a rule (no release version, no
// spelled-out count), or the registry's source text against itself. Saying
// "every case" was the same overreach this file keeps finding one level down.
//
// A literal that has to match a derivation bites in both directions; a
// derivation compared against itself bites in neither. `writes the words it
// shows instead of assembling them` keeps the two sides apart, because the
// cheapest way to hollow all of this out again is one `${…}` in the ask.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// The lens reaches for React Flow's runtime. This stand-in RENDERS THE NODES
// through the lens's own node-type map — the plain children-only mock the
// other lens suites use draws no card at all, and the first run of the case
// below reported zero rows for exactly that reason.
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    children,
    nodes,
    nodeTypes,
  }: {
    children?: ReactNode;
    nodes?: { id: string; type: string; data: unknown }[];
    nodeTypes?: Record<string, (p: { data: unknown; id: string }) => ReactNode>;
  }) => (
    <div>
      {(nodes ?? []).map((n) => (
        <div key={n.id}>{nodeTypes?.[n.type]?.({ data: n.data, id: n.id })}</div>
      ))}
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
}));

import { RELEASE_CHECK_SUBJECTS, SCENARIOS } from "./registry";
import { compile, declarationOf } from "./compile";
import { loc } from "./dsl";
import type { Localized, Step } from "./dsl";
import { LABEL_MAX, lensPhaseNodeId, spawnTree } from "../lab/spawnTree";
import { layoutStateGraph } from "../stategraph/layout";
import { SEATS_MAX_EXPANDED } from "../lab/flowmap/workerGrid";
import { advanceScene, clipMiddle, initialScene } from "../lab/labScene";
import { WorkflowLens } from "../lab/workflow/WorkflowLens";

const dsl = SCENARIOS.find((s) => s.id === "fanout-workflow")!;

const REPO = join(__dirname, "..", "..", "..");
const registrySource = readFileSync(join(__dirname, "registry.ts"), "utf8");

/** One top-level declaration of `registry.ts`, verbatim. Nested closers are
 *  indented, so a closer at column 0 is this block's own. */
const sourceBlock = (opener: string, closer: string): string => {
  const at = registrySource.indexOf(opener);
  expect(at, opener).toBeGreaterThan(-1);
  const end = registrySource.indexOf(closer, at);
  expect(end, closer).toBeGreaterThan(at);
  return registrySource.slice(at, end + closer.length);
};

/** The verbs our own CLI declares, read out of the CLI's own source. A demo
 *  that types `spectro <verb>` is telling the viewer this product has that
 *  verb, so the claim is checked against the product. */
const cliVerbs = (): string[] => {
  const dir = join(REPO, "spectro-cli", "src", "main", "java", "dev", "spectroscope", "cli");
  const src = readdirSync(dir)
    .filter((f) => f.endsWith(".java"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  return [...src.matchAll(/@Command\(\s*name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
};

/** The two numbers the name claims, read back off the declaration. */
const declaredWidths = (): number[] => (dsl.phases ?? []).map((p) => p.agents.length);
const declaredTotal = (): number => declaredWidths().reduce((a, b) => a + b, 0);
const declaredWidest = (): number => Math.max(...declaredWidths());

/** Every number in the shown name, in the order it is shown. */
const numbersInName = (lang: "en" | "de"): number[] =>
  [...loc(dsl.name, lang).matchAll(/\d+/g)].map((m) => Number(m[0]));

/** Every string of the scenario's OWN copy: the name, the ask, the captions,
 *  and the words the run itself says. A fan-out worker's transcript is its
 *  own copy and is deliberately left out — those lines talk about one check,
 *  not about how many there are. */
const ownCopy = (lang: "en" | "de"): string[] => {
  const out: string[] = [loc(dsl.name, lang), loc(dsl.prompt, lang)];
  for (const p of dsl.phases ?? []) {
    out.push(loc(p.title, lang));
    if (p.detail !== undefined) out.push(loc(p.detail, lang));
  }
  const walk = (steps: Step[]): void => {
    for (const s of steps) {
      if ("think" in s) out.push(loc(s.think, lang));
      else if ("say" in s) out.push(loc(s.say, lang));
      else if ("status" in s) out.push(loc(s.status, lang));
      else if ("spawn" in s) {
        out.push(loc(s.task, lang));
        walk(s.steps);
      }
    }
  };
  walk(dsl.steps);
  return out;
};

/** Every LOCALIZED string one step of the DSL puts on screen, plus the two
 *  unlocalized ones a step shows verbatim: the command, path or tool name the
 *  step is keyed by, and the `label` a spawn or a fan-out is drawn under.
 *
 *  WHAT THE `never` ON THE LAST LINE HOLDS — and it is less than three rounds
 *  of this file read into it. It holds the ARMS of the union: add a member to
 *  `Step`, or drop a case from here, and `npx tsc -b` stops. It holds NOTHING
 *  about the FIELDS inside an arm. A new field on an existing arm compiles
 *  silently and this walk never sees it, so "the coverage is the one the
 *  compiler holds" was true of arms and false of shown text, which is the
 *  same overclaim this suite keeps finding elsewhere.
 *
 *  So the gaps are NAMED instead of implied. Not scanned, on purpose:
 *    - `mcp.input` and `tool.input` — the argument objects. They are
 *      `Record<string, unknown>`, so there is no localized line to read and no
 *      cheap way to walk them; the tool row still draws them.
 *    - `image.provider`, `image.model`, `image.asset` — the caption is
 *      scanned, the three fields under it are not.
 *  Both gaps are EMPTY in this scenario today (no `input:`, no `image:` step
 *  anywhere in its block), which is why the narrow branch was taken.
 *
 *  The step `label`s ARE scanned, because unlike the two above this scenario
 *  ships three of them — "scope", "check" and "sign off" — and compile.ts
 *  turns each into the `name` of a `tool_call` the transcript prints.
 *  Measured before they were walked: `label: "scope 0.11.0"` gave EXIT=0 with
 *  21 passed, and so did the other two, one at a time.
 *
 *  `usage` and `compact` are named and return nothing: they carry numbers,
 *  not text. That is a statement about those two arms, not a gap.
 *
 *  The localized side went blind twice, so both are written down. The first
 *  cut never read a worker's `status` or `say` (SIXTEEN rendered lines per
 *  locale, and with "Six files carry the version; all six say 0.11.0." in one
 *  worker's answer all twenty cases stayed green). The second cut enumerated
 *  the union BY HAND and skipped `context` — whose `parts[].label` compile.ts
 *  maps through `loc()` into the context_info event and `ContextRing` draws as
 *  `.context-part-label`; with "the 0.11.0 baseline" planted as one,
 *  twenty-one cases stayed green. */
const stepShown = (s: Step, lang: "en" | "de"): string[] => {
  const withResult = (head: string, result?: Localized): string[] =>
    result === undefined ? [head] : [head, loc(result, lang)];
  const nested = (steps: Step[]): string[] => steps.flatMap((x) => stepShown(x, lang));
  const withLabel = (label: string | undefined, rest: string[]): string[] =>
    label === undefined ? rest : [label, ...rest];
  if ("think" in s) return [loc(s.think, lang)];
  if ("say" in s) return [loc(s.say, lang)];
  if ("status" in s) return [loc(s.status, lang)];
  if ("spawn" in s) return withLabel(s.label, [loc(s.task, lang), ...nested(s.steps)]);
  if ("fanout" in s)
    return withLabel(
      s.fanout.label,
      s.fanout.agents.flatMap((a) => [loc(a.task, lang), ...nested(a.steps)]),
    );
  if ("run" in s) return withResult(s.run, s.result);
  if ("read" in s) return withResult(s.read, s.result);
  if ("write" in s) return withResult(s.write, s.result);
  if ("list" in s) return withResult(s.list, s.result);
  if ("mcp" in s) return withResult(s.mcp, s.result);
  if ("tool" in s) return withResult(s.tool, s.result);
  if ("image" in s) return [loc(s.image, lang)];
  if ("context" in s) return s.context.parts.map((p) => loc(p.label, lang));
  if ("usage" in s) return [];
  if ("compact" in s) return [];
  const unreached: never = s;
  throw new Error(`unhandled step kind: ${JSON.stringify(unreached)}`);
};

/** The captions the three phase boxes draw. */
const phaseCaptions = (lang: "en" | "de"): string[] =>
  (dsl.phases ?? []).flatMap((p) =>
    p.detail === undefined ? [loc(p.title, lang)] : [loc(p.title, lang), loc(p.detail, lang)],
  );

/** Every line of this scenario that `stepShown` reaches, plus the strings that
 *  live OUTSIDE the steps: the name, the ask and the phase captions. Which is
 *  the name, the ask, the captions, every worker's transcript, and each step's
 *  command, path, tool name, label and result.
 *
 *  NOT "everything it shows". `stepShown` names the two kinds of shown text it
 *  leaves out — the `input` object of an mcp or tool step, and an image step's
 *  provider, model and asset — and both are empty in this scenario today. Any
 *  case built on this list inherits exactly that bound, and says so. */
const everyShownString = (lang: "en" | "de"): string[] => [
  loc(dsl.name, lang),
  loc(dsl.prompt, lang),
  ...phaseCaptions(lang),
  ...dsl.steps.flatMap((s) => stepShown(s, lang)),
];

/** The workers of the wide phase, as the fan-out step declares them. */
type FanoutWorker = { id: string; task: Localized; steps: Step[] };
const fanoutWorkers = (): FanoutWorker[] => {
  const out: FanoutWorker[] = [];
  for (const s of dsl.steps) if ("fanout" in s) out.push(...s.fanout.agents);
  return out;
};

/** Everything ONE worker puts on screen: its task, and every string its steps
 *  show. Same walker as above, so the two cannot drift apart — they did, and
 *  `context` was missing from both. */
const workerShown = (a: FanoutWorker, lang: "en" | "de"): string[] => [
  loc(a.task, lang),
  ...a.steps.flatMap((s) => stepShown(s, lang)),
];

/** The head word of a subject, hyphens flattened and case folded: "the version
 *  pins" → "pins", "die Konfigurations-Migration" → "migration". */
const headNoun = (subject: string): string => {
  const words = flat(subject).trim().split(/\s+/);
  return words[words.length - 1].toLowerCase();
};

/** The lines a fan-out worker itself puts on screen: its status band and its
 *  answer. These are exactly the lines the first cut of `everyShownString`
 *  dropped, so the scan proves it reaches them rather than assuming it. */
const workerTranscriptLines = (lang: "en" | "de"): string[] => {
  const out: string[] = [];
  for (const s of dsl.steps) {
    if (!("fanout" in s)) continue;
    for (const a of s.fanout.agents)
      for (const step of a.steps) {
        if ("status" in step) out.push(loc(step.status, lang));
        else if ("say" in step) out.push(loc(step.say, lang));
      }
  }
  return out;
};

/** Every shell command the run types. */
const runCommands = (): string[] => {
  const out: string[] = [];
  const walk = (steps: Step[]): void => {
    for (const s of steps) {
      if ("run" in s) out.push(s.run);
      else if ("spawn" in s) walk(s.steps);
      else if ("fanout" in s) for (const a of s.fanout.agents) walk(a.steps);
    }
  };
  walk(dsl.steps);
  return out;
};

/** A release number: `0.11.0`, `v0.10.0`, `0.10`. A trailing `%` rules out a
 *  percentage (`-2.1%`), which names no release of ours.
 *
 *  THE LOOKBEHIND HAS ONE JOB: do not start reading in the MIDDLE of a longer
 *  number. So it names digits and the dot, and nothing else — whatever else
 *  stands in front is exactly what this scan has to see through. That rule
 *  was arrived at by narrowing twice, and each narrowing left the door open
 *  by the width of the characters still listed. It began as `\w`, to spare
 *  `Apache-2.0`, and so went blind to every version a HYPHEN precedes
 *  (`spectro-0.11.0`, `since-0.11.0`). Round two dropped the hyphen and kept
 *  `\w` — which still carries the UNDERSCORE, so `notes_fetch_0.11.0` and
 *  `readiness_0.11.0.md` stayed invisible while the comment reasoned about
 *  the hyphen alone and read as if the door were shut. Measured:
 *  `{ mcp: "notes_fetch_0.11.0" }` gave EXIT=0 and 21 passed, while the same
 *  step written `notes fetch 0.11.0` was red. Listing characters is how this
 *  went wrong twice; the rule is what is written down now.
 *
 *  The one licence name that reads like a version is excluded BY NAME below,
 *  which spares that string and nothing else. */
const VERSION_LIKE = /(?<![\d.])v?\d+\.\d+(?:\.\d+)?(?![\d%])/g;

/** A licence identifier, not a release of ours. The only such string in this
 *  scenario's copy, and named in full so it cannot cover anything else. */
const LICENCE_ID = /Apache-2\.0/g;

/** Every release number a shown line names. */
const versionsIn = (line: string): string[] =>
  [...line.replace(LICENCE_ID, "Apache").matchAll(VERSION_LIKE)].map((m) => m[0]);

/** The checks the wide phase DECLARES, in the order it declares them, said in
 *  the words the ask has to use. The ask does not read this — it is written
 *  out — which is the whole point of the two cases below. */
const declaredSubjects = (lang: "en" | "de"): string[] =>
  ((dsl.phases ?? [])[1]?.agents ?? []).map((id) => {
    const subject = RELEASE_CHECK_SUBJECTS[id];
    expect(subject, `no subject declared for ${id}`).toBeDefined();
    return subject[lang];
  });

/** The ask cut into sentences at its full stops, each keeping the stop it was
 *  cut at. Naive on purpose: this ask has no decimals and no abbreviations,
 *  and it must not grow any — a sentence count is only a bound while the
 *  count means sentences. */
const sentences = (s: string): string[] =>
  s
    .trim()
    .split(/(?<=\.)\s+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");

/** "a, b and c" / "a, b und c" — the shape the ask is written in. */
const joinList = (items: string[], conj: string): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;

/** The nouns this scenario counts. Hyphens are flattened first so a German
 *  compound ("Release-Prüfungen") is read as the two words it is. */
const CHECK_NOUN = String.raw`(?:checks|reports|Prüfungen|Berichten?)`;
const flat = (s: string): string => s.replace(/[-\u2013\u2014]/g, " ");

/** "8 checks", "8 independent checks", "8 Release Prüfungen" — one adjective
 *  of slack, which is all the copy uses. */
const countsIn = (s: string): number[] =>
  [...flat(s).matchAll(new RegExp(String.raw`(\d+)\s+(?:\S+\s+)?` + CHECK_NOUN, "gi"))].map((m) =>
    Number(m[1]),
  );

/** The same shape with the number written out — the form that cannot follow
 *  the declaration, and the one this scenario shipped in seven places. */
const SPELLED = new RegExp(
  String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|` +
    String.raw`ein|eine|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+` +
    String.raw`(?:\S+\s+)?` +
    CHECK_NOUN,
  "i",
);

describe("the fan-out workflow scenario", () => {
  it("is registered, and is a chat scenario so it lands in the Lab", () => {
    expect(dsl).toBeDefined();
    expect(dsl.fleet).toBeUndefined();
  });

  it("is shaped as a fan-out: a scope, ONE wide phase, a sign-off", () => {
    const widths = declaredWidths();
    expect(widths).toHaveLength(3);
    expect(widths[0]).toBe(1);
    expect(widths[2]).toBe(1);
    // The middle phase is the scenario. Wider than both its neighbours put
    // together is what makes this a fan-out rather than a pipeline.
    expect(widths[1]).toBeGreaterThan(widths[0] + widths[2]);
  });

  it("keeps the wide phase inside the seat grid the map can actually draw", () => {
    // SEATS_MAX_EXPANDED is the ceiling past which the map stops drawing the
    // seats and the chip confesses the gap. A name promising a fan-out wider
    // than the map seats is the drift this card exists to avoid — so this
    // reads the ceiling rather than repeating the literal 8.
    expect(declaredWidest()).toBeLessThanOrEqual(SEATS_MAX_EXPANDED);
  });

  it("states the total agent count in its name, in both locales", () => {
    for (const lang of ["en", "de"] as const) {
      expect(numbersInName(lang)[0], lang).toBe(declaredTotal());
    }
  });

  it("states the fan-out width in its name, in both locales", () => {
    for (const lang of ["en", "de"] as const) {
      expect(numbersInName(lang)[1], lang).toBe(declaredWidest());
    }
  });

  it("puts no third number in its name that nothing pins", () => {
    for (const lang of ["en", "de"] as const) {
      expect(numbersInName(lang), lang).toHaveLength(2);
    }
  });

  it("hands out every agent id exactly once", () => {
    const ids = (dsl.phases ?? []).flatMap((p) => p.agents);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares only agents the stream actually spawns", () => {
    const spawned = compile(dsl, "en")
      .filter((e) => e.type === "agent_spawn")
      .map((e) => (e as { agentId: string }).agentId);
    for (const id of (dsl.phases ?? []).flatMap((p) => p.agents)) {
      expect(spawned.includes(id), id).toBe(true);
    }
  });

  it("spawns no agent the declaration left out", () => {
    const declared = new Set((dsl.phases ?? []).flatMap((p) => p.agents));
    const spawned = compile(dsl, "en")
      .filter((e) => e.type === "agent_spawn")
      .map((e) => (e as { agentId: string }).agentId);
    expect(spawned).toHaveLength(declaredTotal());
    for (const id of spawned) expect(declared.has(id), id).toBe(true);
  });

  it("draws three phase boxes holding exactly what the phases declare", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    expect(tree.declared).toBe(true);
    const laid = layoutStateGraph(tree.topo, "horizontal");
    // Four boxes: main and its three phases. The agents are ROWS.
    expect(laid.nodes).toHaveLength(4);
    const held = [0, 1, 2].map((i) => tree.meta[lensPhaseNodeId("main", i)].members.length);
    expect(held).toEqual(declaredWidths());
  });

  it("chains the three, and lets nothing else out of the root", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    const id = (i: number) => lensPhaseNodeId("main", i);
    expect(tree.topo.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      `main->${id(0)}`,
      `${id(0)}->${id(1)}`,
      `${id(1)}->${id(2)}`,
    ]);
  });

  it("names every row of the wide phase from the task the run gave it", () => {
    // The name claims PROVENANCE, so the body has to check provenance. Until
    // round four it asserted non-empty, unique, and not-the-raw-id, and a
    // wrong label passes all three: with `clipMiddle(seen.task, 12)` planted
    // in spawnTree the rows read "reconcile…gelog" and the suite gave EXIT=0
    // with 21 passed, while not one row carried the task the run gave it.
    //
    // So each row is rebuilt from ITS OWN worker's task, through the same clip
    // the reader applies, with LABEL_MAX read out of the reader rather than
    // repeated here. That subsumes the old non-empty and raw-id assertions:
    // no task is empty and none equals an id. Uniqueness stays, because it is
    // a statement about the SCENARIO's eight tasks, not about the derivation.
    for (const lang of ["en", "de"] as const) {
      const tree = spawnTree(compile(dsl, lang), declarationOf(dsl, lang));
      const rows = tree.meta[lensPhaseNodeId("main", 1)].members;
      expect(rows, lang).toHaveLength(declaredWidest());
      const byId = new Map(fanoutWorkers().map((a) => [a.id, a]));
      for (const r of rows) {
        const worker = byId.get(r.agentId);
        expect(worker, `${lang}: no fan-out worker declared for ${r.agentId}`).toBeDefined();
        expect(r.label, `${lang} ${r.agentId}`).toBe(clipMiddle(loc(worker!.task, lang), LABEL_MAX));
      }
      // Eight rows saying the same thing would render as one job done eight
      // times, which is not what a fan-out is.
      const labels = rows.map((m) => m.label);
      expect(new Set(labels).size, lang).toBe(labels.length);
    }
  });

  it("renders the wide box with one row per agent the phase declared", () => {
    // Every case above stops at the tree the lens is BUILT from. This one
    // renders the assembled lens, because a box that computes eight members
    // and draws six would leave all of them green.
    for (const lang of ["en", "de"] as const) {
      const events = compile(dsl, lang);
      const scene = events.reduce(advanceScene, initialScene());
      const html = renderToStaticMarkup(
        <WorkflowLens events={events} applied={events} scene={scene} declared={declarationOf(dsl, lang)} />,
      );
      // One <li class="wf-agent…"> per agent, across all three boxes.
      expect((html.match(/class="wf-agent /g) ?? []).length, lang).toBe(declaredTotal());
      // And every worker of the wide phase is named on screen, by the task.
      // Read out of the LABEL SPAN, not out of the whole page: the row's
      // tooltip carries the same words, so a card printing the raw id in the
      // visible span passed a plain `toContain` — measured, not guessed.
      const shown = [...html.matchAll(/class="wf-agent-label">([^<]*)</g)].map((m) => m[1]);
      const tree = spawnTree(events, declarationOf(dsl, lang));
      const wide = tree.meta[lensPhaseNodeId("main", 1)].members.map((m) => m.label);
      expect(shown, lang).toHaveLength(declaredTotal());
      for (const label of wide) expect(shown, `${lang} ${label}`).toContain(label);
    }
  });

  it("captions all three columns, in both locales, clear of the boxes", () => {
    for (const lang of ["en", "de"] as const) {
      const tree = spawnTree(compile(dsl, lang), declarationOf(dsl, lang));
      const laid = layoutStateGraph(tree.topo, "horizontal");
      const titles = [1, 2, 3].map((r) => tree.topo.rankCaptions!.get(r)?.title ?? null);
      expect(
        titles.every((x) => x !== null && x !== ""),
        lang,
      ).toBe(true);
      // The wide box is the tall one, and it is the reason this case exists:
      // the caption is pinned above a column whose height the widest box in
      // it sets, so a taller box than card 302 ever drew is where an overlap
      // would first show.
      for (const l of laid.rankLabels) {
        for (const n of laid.nodes.filter((x) => x.rank === l.rank)) {
          expect(l.y, `${lang} rank ${l.rank}`).toBeLessThan(n.y);
        }
      }
    }
  });

  it("counts the checks with the SAME number everywhere its copy counts them", () => {
    // The name was drift-proofed; the prose was not. Measured before this
    // case existed: a ninth worker renamed the scenario to "9 abreast" while
    // the caption under the wide box still read "eight independent checks at
    // once" and the sign-off still weighed "eight reports".
    for (const lang of ["en", "de"] as const) {
      const copy = ownCopy(lang);
      const counted = copy.flatMap(countsIn);
      // A green run over zero matches would say nothing, so the copy has to
      // still count out loud: the two captions, the ask, the think, the scope
      // agent's answer, the sign-off's task and status, and the closing line.
      expect(counted.length, lang).toBeGreaterThanOrEqual(8);
      for (const n of counted) expect(n, lang).toBe(declaredWidest());
      for (const line of copy) expect(SPELLED.test(flat(line)), `${lang}: ${line}`).toBe(false);
    }
  });

  it("writes the ask as three sentences whose list is exactly the declared checks", () => {
    // THE TWO SIDES: the ask is a written sentence; the expectation is derived
    // from the wide phase's declared agent ids. Add a worker and the ask stops
    // naming one; edit the ask and it stops matching the phase. Both bite.
    //
    // WHAT IS HELD, and why the name says three sentences rather than
    // "exactly". Round two bounded the LIST — written as a colon, the run, a
    // full stop — which closed the appended-to-the-list direction: with
    // ", and the release notes." tacked on, the joined eight were still a
    // substring and twenty cases stayed green, and after the bound both
    // locales went red. But a bounded list is not a bounded ASK. A ninth
    // demand phrased as its OWN sentence walked straight past it, and past
    // `countsIn` too, which sees no "<number> checks" in it: measured, with
    // "Also translate the release notes." between the list and the go/no-go,
    // EXIT=0 and 21 passed while the ask demanded work no worker here does.
    // So the whole ask is bounded now: three sentences, the middle one ENDING
    // at the run, and a fourth sentence is red.
    //
    // Still not held, and it is THREE open positions rather than the one an
    // earlier round wrote down. What the bound covers is the sentence COUNT
    // and the list's RIGHT EDGE. It covers no prose at all, and this ask has
    // three places prose sits: the opening sentence, the head of the middle
    // sentence in front of its colon, and the closing sentence. A demand for
    // work no worker here does can ride in ANY of the three and still be three
    // sentences whose list ends at the run. Naming only the closing one read
    // as if the other two were held — which is this file's own recurring
    // defect, a sentence reaching further than the code under it.
    //
    // That is why the name reads "three sentences whose list is exactly the
    // declared checks" and not "asks for exactly the checks".
    for (const lang of ["en", "de"] as const) {
      const prompt = loc(dsl.prompt, lang);
      const subjects = declaredSubjects(lang);
      expect(subjects, lang).toHaveLength(declaredWidest());
      // Named individually first, so a failure says WHICH check went missing.
      for (const c of subjects) expect(prompt, `${lang} ${c}`).toContain(c);
      const said = sentences(prompt);
      expect(said, `${lang}: ${prompt}`).toHaveLength(3);
      // The middle sentence is the list: a colon, the run, and then the full
      // stop it was cut at. `endsWith` is what makes it a bound rather than a
      // floor — nothing survives after the run inside its own sentence.
      const run = joinList(subjects, lang === "en" ? "and" : "und");
      expect(said[1].endsWith(`: ${run}.`), `${lang}: ${said[1]}`).toBe(true);
      expect(countsIn(prompt), lang).toEqual([declaredWidest()]);
    }
  });

  it("gives each check a noun the worker's own lines carry", () => {
    // `subject` is test-only data: the ask does not read it, nothing on screen
    // reads it, and the case above only holds it against the ask. That left
    // the step from a declared id to the noun the ask uses ASSERTED. Measured:
    // rewriting `check-bench` to translate the release notes - a different
    // task, a different command, a different answer - while its subject stayed
    // "the benchmarks" left all twenty cases green, with the ask still asking
    // for a benchmark nobody ran.
    //
    // This is the one thread back to the work: the head word of the noun has
    // to turn up in something that worker actually renders. A thread, not a
    // proof - it holds the noun against the worker's own words, and says
    // nothing about whether those words describe the check they claim.
    for (const lang of ["en", "de"] as const) {
      const workers = fanoutWorkers();
      expect(workers, lang).toHaveLength(declaredWidest());
      for (const a of workers) {
        const subject = RELEASE_CHECK_SUBJECTS[a.id];
        expect(subject, `no subject declared for ${a.id}`).toBeDefined();
        const noun = headNoun(subject[lang]);
        const lines = workerShown(a, lang).map((l) => flat(l).toLowerCase());
        expect(
          lines.some((l) => l.includes(noun)),
          `${lang} ${a.id}: nothing it shows says "${noun}"`,
        ).toBe(true);
      }
    }
  });

  it("writes the words it shows instead of assembling them", () => {
    // A drift case, and the load-bearing one: every count and every list above
    // is a written literal held against a derivation. Interpolate any of them
    // from the same array the derivation reads and the pin turns into a
    // tautology that cannot fail — which is what the first cut shipped.
    const blocks: [string, string, string][] = [
      ["const releaseChecks: FanoutAgent[] = [", "\n];", "check-changelog"],
      ["const fanoutWorkflowPhases: DslPhase[] = [", "\n];", "sign off"],
      ["const fanoutWorkflow: Dsl = {", "\n};", "fanout-workflow"],
    ];
    for (const [opener, closer, anchor] of blocks) {
      const src = sourceBlock(opener, closer);
      expect(src, opener).toContain(anchor);
      expect(src.includes("${"), opener).toBe(false);
    }
  });

  it("names no release version in any line the scan reaches", () => {
    // A demo scenario ships once and is read for years. The first cut cut
    // "0.11.0" through the ask, a file it read, a path it wrote and lines the
    // run says out loud, and its own author flagged that it would read as
    // stale the day that version shipped. The story is the WORK, so the run
    // reaches for the last tag instead of naming one.
    //
    // The name says "the scan reaches" and not "anything it shows", because
    // those are different and only the first is held. `everyShownString` walks
    // every localized line, every command, path and tool name, and every step
    // label; it does not walk an mcp or tool step's `input` object or an image
    // step's provider, model and asset. Both are empty here, so the narrow
    // scan is the whole picture TODAY — and if a later edit adds one, this
    // case will keep passing and the name will still be true.
    for (const lang of ["en", "de"] as const) {
      const shown = everyShownString(lang);
      expect(shown.length, lang).toBeGreaterThan(40);
      // The scan has to REACH the fan-out, not just the copy around it. Every
      // worker's status band and answer is one of the strings scanned — the
      // sixteen lines that a version hid in while twenty cases stayed green.
      const transcript = workerTranscriptLines(lang);
      expect(transcript, lang).toHaveLength(2 * declaredWidest());
      for (const line of transcript) expect(shown, `${lang}: ${line}`).toContain(line);
      for (const line of shown) {
        expect(versionsIn(line), `${lang}: ${line}`).toEqual([]);
      }
    }
  });

  it("types our own tooling only where the product really has that verb", () => {
    // The build already pulled three commands that claimed our CLI had verbs
    // it does not. The rule that keeps them out: a command is git, or a script
    // of the release repo the story is set in — plainly not our tooling — or
    // it is our CLI, and then the verb is checked against the CLI's source.
    const verbs = cliVerbs();
    expect(verbs, "the CLI source must yield its verbs").toContain("doctor");
    const commands = runCommands();
    expect(commands.length).toBeGreaterThan(8);
    const ours = commands.filter((c) => c.startsWith("spectro "));
    expect(ours.length, "the demo does show our CLI").toBeGreaterThan(0);
    for (const c of ours) expect(verbs, c).toContain(c.split(/\s+/)[1]);
    for (const c of commands.filter((x) => !ours.includes(x))) {
      expect(c, c).toMatch(/^(?:git|scripts\/[a-z-]+\.sh)(?:\s|$)/);
    }
  });

  it("shows the width in the caption drawn under the wide box", () => {
    // `DslPhase.detail` is not a comment: WorkflowLens puts it in the caption
    // band as <span class="wf-rankdetail">, directly under the box whose rows
    // this number counts. So the number is read back OUT OF THE MARKUP.
    for (const lang of ["en", "de"] as const) {
      const events = compile(dsl, lang);
      const scene = events.reduce(advanceScene, initialScene());
      const html = renderToStaticMarkup(
        <WorkflowLens events={events} applied={events} scene={scene} declared={declarationOf(dsl, lang)} />,
      );
      const details = [...html.matchAll(/class="wf-rankdetail">([^<]*)</g)].map((m) => m[1]);
      expect(details, lang).toHaveLength(3);
      // The wide column and the sign-off that weighs it both say the width.
      expect(countsIn(details[1]), lang).toEqual([declaredWidest()]);
      expect(countsIn(details[2]), lang).toEqual([declaredWidest()]);
    }
  });
});
