// Card 314: the workflow whose SHAPE IS THE FAN-OUT.
//
// "workflow-phases" (card 302) is a five-stage pipeline that happens to
// contain two fan-outs; this one is a single wide phase with a scope in front
// of it and a sign-off behind it, which is the picture the owner asked to be
// able to load by name.
//
// The name carries the count, so these cases exist to keep that number honest
// in the only way that survives an edit: the name is compared against the
// DECLARATION, the declaration against the STREAM, and the stream against the
// BOX that draws it. Break any one link and exactly one case goes red.

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

import { releaseCheckSubjects, SCENARIOS } from "./registry";
import { compile, declarationOf } from "./compile";
import { loc } from "./dsl";
import type { Step } from "./dsl";
import { lensPhaseNodeId, spawnTree } from "../lab/spawnTree";
import { layoutStateGraph } from "../stategraph/layout";
import { SEATS_MAX_EXPANDED } from "../lab/flowmap/workerGrid";
import { advanceScene, initialScene } from "../lab/labScene";
import { WorkflowLens } from "../lab/workflow/WorkflowLens";

const dsl = SCENARIOS.find((s) => s.id === "fanout-workflow")!;

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
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    const rows = tree.meta[lensPhaseNodeId("main", 1)].members.map((m) => m.label);
    expect(rows).toHaveLength(declaredWidest());
    for (const r of rows) expect(r).not.toBe("");
    // Eight rows saying the same thing would render as one job done eight
    // times, which is not what a fan-out is.
    expect(new Set(rows).size).toBe(rows.length);
    // A row that fell back to its raw id is a row the stream never named.
    const ids = new Set((dsl.phases ?? [])[1].agents);
    for (const r of rows) expect(ids.has(r), r).toBe(false);
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

  it("asks for exactly the checks the fan-out runs", () => {
    for (const lang of ["en", "de"] as const) {
      const prompt = loc(dsl.prompt, lang);
      expect(countsIn(prompt), lang).toEqual([declaredWidest()]);
      // And it names them: the list in the ask is joined from the workers, so
      // a worker added to the array is a check the ask asked for.
      for (const c of releaseCheckSubjects(lang)) expect(prompt, `${lang} ${c}`).toContain(c);
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
