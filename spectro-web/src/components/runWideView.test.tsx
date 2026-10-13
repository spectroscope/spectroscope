// Card 586: the wide view of a playbook or workflow run.
//
// No DOM here: the markup comes from React's server renderer, and a press is
// the handler the view built, run through testkit/driveComponent. The runs are
// folded from run_step lines and agent events by the fold the reducer uses.
// The graph of a run comes from useRunGraph, which asks the server; it is
// replaced here by a literal graph file.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { setLang } from "../state/lang";
import { DEFAULT_LAYOUT, showsRunWide } from "../state/layout";
import { foldRun, type RunEntry, type RunTrack } from "../state/runView";
import { DEFAULT_VIEW } from "../stategraph/viewState";
import { StateGraphView } from "../stategraph/StateGraphView";
import { drive, type El } from "../testkit/driveComponent";
import { RunHead, RunPanel } from "./RunPanel";
import { __resetRunPickForTests } from "../state/runPick";
import { RunChain } from "./RunChain";
import { RunWideView } from "./RunWideView";

const graph = vi.hoisted(() => ({ text: "", calls: [] as unknown[][] }));
vi.mock("../state/useRunGraph", () => ({
  useRunGraph: (sessionId: string | null, run: { kind: string } | null, live: boolean): string => {
    graph.calls.push([sessionId, run, live]);
    return run !== null && run.kind === "playbook" ? graph.text : "";
  },
}));

const T0 = 1_000_000;
const R = "aaaaaaaaaaaa";
const W = "cccccccccccc";

const ev = (ts: number, e: Record<string, unknown>): RunEvent => ({ ts, ...e }) as unknown as RunEvent;
const line = (
  runId: string,
  ts: number,
  phase: string,
  more: Record<string, unknown> = {},
  runKind = "playbook",
): RunEvent => ev(ts, { type: "run_step", agentId: "playbook", runId, runKind, phase, ...more });
const NAMES: Record<string, string> = {
  brainstorm: "Brainstorm",
  spec_ok: "Review",
  build: "Build",
  ship: "Ship",
};
const node = (id: string, kind = "step", entry = 1) => ({ node: id, name: NAMES[id] ?? id, kind, entry });

const NODES = [
  { id: "brainstorm", name: "Brainstorm", kind: "step" },
  { id: "spec_ok", name: "Review", kind: "decision" },
  { id: "build", name: "Build", kind: "fanout" },
  { id: "ship", name: "Ship", kind: "step" },
];

/** A playbook run: a done chat step, a done decision, a running fan-out with two helpers. */
function runEvents(): RunEvent[] {
  return [
    line(R, T0, "run_start", { name: "spectro", task: "baue Frogger", nodes: NODES }),
    line(R, T0 + 1_000, "step_start", {
      ...node("brainstorm"),
      performer: "chat",
      provider: "ollama",
      model: "qwen2.5:7b",
      input: "Write the spec for Frogger",
      inputChars: 26,
      reads: [{ doc: "brief", path: "docs/brief.md" }, { doc: "house rules" }],
    }),
    ev(T0 + 1_100, {
      type: "tool_call",
      agentId: "main",
      callId: "c1",
      name: "write_file",
      input: { path: "src/a.ts", content: "x" },
    }),
    ev(T0 + 1_200, {
      type: "tool_result",
      agentId: "main",
      callId: "c1",
      output: "Wrote",
      isError: false,
      fileChange: "created",
    }),
    ev(T0 + 1_300, { type: "tool_call", agentId: "main", callId: "c2", name: "run_command", input: {} }),
    line(R, T0 + 5_000, "step_end", {
      ...node("brainstorm"),
      status: "done",
      durationMs: 4_000,
      output: "The spec is written.",
      outputChars: 20,
      documents: [{ doc: "spec", path: ".superpowers/spec.md", change: "created" }],
    }),
    line(R, T0 + 6_000, "step_start", { ...node("spec_ok", "decision"), round: 2, maxRounds: 5 }),
    line(R, T0 + 8_000, "step_end", {
      ...node("spec_ok", "decision"),
      status: "done",
      durationMs: 2_000,
      label: "changes needed",
    }),
    line(R, T0 + 9_000, "step_start", {
      ...node("build", "fanout"),
      performer: "child",
      role: "worker",
      model: "glm-5.3",
      picked: true,
      input: "Build the game",
    }),
    ev(T0 + 9_100, {
      type: "agent_message",
      from: "main",
      to: "helper-1",
      role: "task",
      state: "submitted",
      text: "build the frog",
    }),
    ev(T0 + 9_150, {
      type: "agent_message",
      from: "main",
      to: "helper-2",
      role: "task",
      state: "submitted",
      text: "build the road",
    }),
    ev(T0 + 9_200, { type: "text_delta", agentId: "helper-1", text: "compiling\nlinking the frog" }),
  ];
}

/** A workflow run whose step "draft" runs twice. */
function workflowEvents(): RunEvent[] {
  const wf = (ts: number, phase: string, more: Record<string, unknown> = {}) =>
    line(W, ts, phase, more, "workflow");
  return [
    wf(T0, "run_start", {
      name: "polish",
      nodes: [
        { id: "draft", name: "Draft", kind: "prompt" },
        { id: "check", name: "Check", kind: "prompt" },
      ],
    }),
    wf(T0 + 1_000, "step_start", {
      node: "draft",
      name: "Draft",
      kind: "prompt",
      entry: 1,
      input: "first draft",
    }),
    wf(T0 + 2_000, "step_end", {
      node: "draft",
      name: "Draft",
      kind: "prompt",
      entry: 1,
      status: "done",
      output: "draft one",
    }),
    wf(T0 + 3_000, "step_start", {
      node: "check",
      name: "Check",
      kind: "prompt",
      entry: 1,
      input: "check it",
    }),
    wf(T0 + 4_000, "step_end", {
      node: "check",
      name: "Check",
      kind: "prompt",
      entry: 1,
      status: "done",
      output: "looks fine",
    }),
    wf(T0 + 5_000, "step_start", {
      node: "draft",
      name: "Draft",
      kind: "prompt",
      entry: 2,
      input: "second draft",
    }),
    wf(T0 + 6_000, "step_end", {
      node: "draft",
      name: "Draft",
      kind: "prompt",
      entry: 2,
      status: "done",
      output: "draft two",
    }),
    wf(T0 + 7_000, "run_end", { stopReason: "done", durationMs: 7_000 }),
  ];
}

const fold = (events: RunEvent[]): RunTrack[] => events.reduce(foldRun, [] as RunTrack[]);

/** A graph file of the run: its labels are the node ids, as the runner writes them. */
const GRAPH = [
  {
    type: "graph_topology",
    schema_version: 1,
    entry: "brainstorm",
    nodes: NODES.map((n) => ({ id: n.id, label: n.id })),
    edges: [
      { from: "brainstorm", to: "spec_ok", kind: "direct" },
      { from: "spec_ok", to: "build", kind: "conditional", branch: "spec_ok" },
      { from: "build", to: "ship", kind: "direct" },
    ],
    branches: [{ name: "spec_ok", source: "spec_ok", targets: ["build"] }],
  },
  { type: "graph_start", runId: R, ts: T0 },
  { type: "node_start", runId: R, node: "brainstorm", superstep: 0, ts: T0 + 1_000 },
  { type: "node_end", runId: R, node: "brainstorm", superstep: 0, ts: T0 + 5_000 },
  { type: "node_start", runId: R, node: "spec_ok", superstep: 1, ts: T0 + 6_000 },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

type Calls = { jumps: RunEntry[]; paths: [string, string][]; small: number };

function props(runs: RunTrack[], calls: Calls = { jumps: [], paths: [], small: 0 }) {
  return {
    runs,
    sessionId: "20261013-120000-wide",
    live: true,
    onSmall: () => calls.small++,
    onJump: (e: RunEntry) => calls.jumps.push(e),
    onOpenPath: (run: RunTrack, path: string) => calls.paths.push([run.runId, path]),
  };
}

/** The visible text of the markup, tags dropped and entities read back. */
const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

/** The detail part of the markup: everything after the graph area. */
const detailOf = (markup: string): string => {
  const at = markup.indexOf('<section class="run-detail');
  return at < 0 ? "" : text(markup.slice(at));
};

/** The text of every host element of a driven tree, in tree order. */
function treeText(tree: El[]): string {
  return tree
    .flatMap((el) => {
      const kids = el.props.children;
      return (Array.isArray(kids) ? kids : [kids]).filter(
        (k) => typeof k === "string" || typeof k === "number",
      );
    })
    .join(" ");
}

/** The detail section of a driven tree, as text. */
function detailText(tree: El[]): string {
  const at = tree.findIndex((el) => String(el.props.className ?? "").startsWith("run-detail"));
  if (at < 0) throw new Error("no detail");
  return treeText(tree.slice(at));
}

const button = (tree: El[], className: string): El => {
  const found = tree.find((el) => el.type === "button" && String(el.props.className ?? "") === className);
  if (found === undefined) throw new Error(`no button ${className}`);
  return found;
};

beforeEach(() => {
  __resetRunPickForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 42_000);
  graph.text = GRAPH;
  graph.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
  setLang("en");
});

describe("the graph area of the wide view (card 586)", () => {
  it("draws a playbook run's graph with the names of its nodes on the cards", () => {
    const markup = renderToStaticMarkup(<RunWideView {...props(fold(runEvents()))} />);
    expect(markup).toContain('sg-card-name mono">Brainstorm<');
    expect(markup).toContain('sg-card-name mono">Review<');
    expect(markup).toContain('sg-card-name mono">Ship<');
    expect(markup).not.toContain('sg-card-name mono">brainstorm<');
    expect(markup).not.toContain('class="run-chain"');
  });

  it("asks the graph of the shown run in the shown session, and says whether the session is live", () => {
    const runs = fold(runEvents());
    renderToStaticMarkup(<RunWideView {...props(runs)} />);
    expect(graph.calls.at(-1)).toEqual(["20261013-120000-wide", runs[0], true]);
  });

  it("hands StateGraphView the run id as its source and a label per node", () => {
    const tree = drive(<RunWideView {...props(fold(runEvents()))} />, [RunWideView, RunHead], [() => {}]);
    const view = tree.find((el) => el.type === StateGraphView);
    expect(view?.props.source).toBe(R);
    expect(view?.props.stateJsonl).toBeNull();
    expect(view?.props.nodeLabels).toEqual({
      brainstorm: "Brainstorm",
      spec_ok: "Review",
      build: "Build",
      ship: "Ship",
    });
  });

  it("says a playbook run has no graph while its graph file is empty", () => {
    graph.text = "";
    const markup = renderToStaticMarkup(<RunWideView {...props(fold(runEvents()))} />);
    expect(text(markup)).toContain("This run has no graph.");
    expect(markup).not.toContain('class="sg"');
  });

  it("draws a workflow run as a chain, one link per node, and no graph", () => {
    const markup = renderToStaticMarkup(<RunWideView {...props(fold(workflowEvents()))} />);
    expect(markup).toContain('class="run-chain"');
    expect(markup.match(/class="run-link[ "]/g)).toHaveLength(2);
    expect(markup).not.toContain('class="sg"');
    expect(text(markup)).not.toContain("This run has no graph.");
  });
});

describe("RunChain (card 586)", () => {
  it("has one link per node with its mark and name, the selected one pressed", () => {
    const run = fold(workflowEvents())[0];
    const markup = renderToStaticMarkup(<RunChain run={run} selected="check" onSelect={() => {}} />);
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(text(markup)).toContain("[x] Draft");
    expect(text(markup)).toContain("[x] Check");
    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-node="check"|data-node="check"[^>]*aria-pressed="true"/,
    );
    expect(markup).toMatch(
      /aria-pressed="false"[^>]*data-node="draft"|data-node="draft"[^>]*aria-pressed="false"/,
    );
  });

  it("a press on a link selects its node", () => {
    const run = fold(workflowEvents())[0];
    const picked: string[] = [];
    const tree = drive(
      <RunChain run={run} selected={null} onSelect={(n) => picked.push(n)} />,
      [RunChain],
      [(t) => t.filter((el) => el.type === "button")[1].props.onClick?.()],
    );
    expect(tree.length).toBeGreaterThan(0);
    expect(picked).toEqual(["check"]);
  });
});

describe("the detail of the wide view (card 586)", () => {
  it("shows the current entry by default: who, the model, in, and the helpers of a fan-out", () => {
    const out = detailOf(renderToStaticMarkup(<RunWideView {...props(fold(runEvents()))} />));
    expect(out).toContain("Build");
    expect(out).toContain("Who");
    expect(out).toContain("helper-1, helper-2 (worker) · glm-5.3 · picked");
    expect(out).toContain("In");
    expect(out).toContain("Build the game");
    expect(out).toContain("Helpers");
    expect(out).toContain("helper-1");
    expect(out).toContain("helper-2");
    expect(out).toContain("linking the frog");
    expect(out).not.toContain("Write the spec for Frogger");
  });

  it("shows the last entry of an ended run", () => {
    const out = detailOf(renderToStaticMarkup(<RunWideView {...props(fold(workflowEvents()))} />));
    expect(out).toContain("second draft");
    expect(out).toContain("draft two");
    expect(out).not.toContain("first draft");
  });

  it("a pick in the graph shows that node's entry: in with the input and the reads, out with the output, documents and files", () => {
    const tree = drive(
      <RunWideView {...props(fold(runEvents()))} />,
      [RunWideView, RunHead],
      [
        (t) => {
          const view = t.find((el) => el.type === StateGraphView);
          (view?.props.onView as (v: unknown) => void)({ ...DEFAULT_VIEW, picked: "brainstorm" });
        },
      ],
    );
    const out = detailText(tree);
    expect(out).toContain("Chat · qwen2.5:7b");
    expect(out).toContain("Write the spec for Frogger");
    expect(out).toContain("brief");
    expect(out).toContain("docs/brief.md");
    expect(out).toContain("house rules");
    expect(out).toContain("Out");
    expect(out).toContain("The spec is written.");
    expect(out).toContain("spec");
    expect(out).toContain(".superpowers/spec.md");
    expect(out).toContain("new");
    expect(out).toContain("Files");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("1 shell commands, their files are not captured");
    expect(out).not.toContain("Build the game");
    const view = tree.find((el) => el.type === StateGraphView);
    expect((view?.props.view as { picked: string | null }).picked).toBe("brainstorm");
  });

  it("a pick in the chain shows the node's latest entry", () => {
    const tree = drive(
      <RunWideView {...props(fold(workflowEvents()))} />,
      [RunWideView, RunHead],
      [
        (t) => {
          const chain = t.find((el) => el.type === RunChain);
          (chain?.props.onSelect as (n: string) => void)("check");
        },
        (t) => {
          const chain = t.find((el) => el.type === RunChain);
          expect(chain?.props.selected).toBe("check");
          expect(detailText(t)).toContain("looks fine");
          (chain?.props.onSelect as (n: string) => void)("draft");
        },
      ],
    );
    const out = detailText(tree);
    expect(out).toContain("second draft");
    expect(out).not.toContain("first draft");
  });

  it("a pick of a node the run has not entered names it and says it has not started", () => {
    const tree = drive(
      <RunWideView {...props(fold(runEvents()))} />,
      [RunWideView, RunHead],
      [
        (t) => {
          const view = t.find((el) => el.type === StateGraphView);
          (view?.props.onView as (v: unknown) => void)({ ...DEFAULT_VIEW, picked: "ship" });
        },
      ],
    );
    const out = detailText(tree);
    expect(out).toContain("Ship");
    expect(out).toContain("not started");
    expect(out).not.toContain("Build the game");
  });

  it("a click on the empty canvas goes back to the current entry", () => {
    const tree = drive(
      <RunWideView {...props(fold(runEvents()))} />,
      [RunWideView, RunHead],
      [
        (t) => {
          const view = t.find((el) => el.type === StateGraphView);
          (view?.props.onView as (v: unknown) => void)({ ...DEFAULT_VIEW, picked: "brainstorm" });
        },
        (t) => {
          const view = t.find((el) => el.type === StateGraphView);
          (view?.props.onView as (v: unknown) => void)({ ...DEFAULT_VIEW, picked: null });
        },
      ],
    );
    expect(detailText(tree)).toContain("Build the game");
  });

  it("a path in the detail opens it", () => {
    const calls: Calls = { jumps: [], paths: [], small: 0 };
    drive(
      <RunWideView {...props(fold(runEvents()), calls)} />,
      [RunWideView, RunHead],
      [
        (t) => {
          const view = t.find((el) => el.type === StateGraphView);
          (view?.props.onView as (v: unknown) => void)({ ...DEFAULT_VIEW, picked: "brainstorm" });
        },
        (t) => {
          for (const el of t.filter((x) => x.type === "button" && x.props.className === "run-path")) {
            el.props.onClick?.();
          }
        },
      ],
    );
    expect(calls.paths).toEqual([
      [R, "docs/brief.md"],
      [R, ".superpowers/spec.md"],
      [R, "src/a.ts"],
    ]);
  });

  it("In the chat calls onJump with the shown entry; small calls onSmall", () => {
    const calls: Calls = { jumps: [], paths: [], small: 0 };
    drive(
      <RunWideView {...props(fold(runEvents()), calls)} />,
      [RunWideView, RunHead],
      [(t) => button(t, "run-in-chat").props.onClick?.(), (t) => button(t, "run-wide").props.onClick?.()],
    );
    expect(calls.jumps.map((e) => e.key)).toEqual([`${R}:build:1`]);
    expect(calls.small).toBe(1);
  });

  it("says its labels in German", () => {
    setLang("de");
    const markup = renderToStaticMarkup(<RunWideView {...props(fold(runEvents()))} />);
    const out = detailOf(markup);
    for (const word of ["Wer", "Rein", "Helfer", "Im Chat"]) expect(out).toContain(word);
    expect(text(markup)).toContain("klein");
    graph.text = "";
    expect(text(renderToStaticMarkup(<RunWideView {...props(fold(runEvents()))} />))).toContain(
      "Dieser Lauf hat keinen Graphen.",
    );
  });

  it("says Out and Files in German for an entry that wrote", () => {
    setLang("de");
    const tree = drive(
      <RunWideView {...props(fold(runEvents()))} />,
      [RunWideView, RunHead],
      [
        (t) => {
          const view = t.find((el) => el.type === StateGraphView);
          (view?.props.onView as (v: unknown) => void)({ ...DEFAULT_VIEW, picked: "brainstorm" });
        },
      ],
    );
    const out = detailText(tree);
    expect(out).toContain("Raus");
    expect(out).toContain("Dateien");
  });
});

describe("when the wide view takes the chat's place (card 586)", () => {
  const on = { ...DEFAULT_LAYOUT, runWide: true, rightPanelOpen: true, dockPlan: "open" as const };

  it("shows while wide is on, the dock is open and shows the plan panel, and the session has a run", () => {
    expect(showsRunWide(on, 1)).toBe(true);
    expect(showsRunWide({ ...on, dockPlan: "collapsed" }, 1)).toBe(true);
  });

  it("does not show without wide, with the dock closed, with the plan panel closed, or without a run", () => {
    expect(showsRunWide({ ...on, runWide: false }, 1)).toBe(false);
    expect(showsRunWide({ ...on, rightPanelOpen: false }, 1)).toBe(false);
    expect(showsRunWide({ ...on, dockPlan: "closed" }, 1)).toBe(false);
    expect(showsRunWide(on, 0)).toBe(false);
  });

  it("is wired in App: the dock's wide button, the view in the chat's place, small back", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/showsRunWide\(layout, view\.runs\.length\)/);
    expect(app).toMatch(/runWide=\{layout\.runWide\}/);
    expect(app).toMatch(/onToggleRunWide=\{\(\) => setRunWide\(!layout\.runWide\)\}/);
    expect(app).toMatch(/<RunWideView[\s\S]*?onSmall=\{\(\) => setRunWide\(false\)\}/);
  });

  it("loads the view from a chunk of its own, never statically with the entry", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const chunks = readFileSync(new URL("../state/surfaceChunks.ts", import.meta.url), "utf8");
    expect(app).not.toMatch(/from "\.\/components\/RunWideView"/);
    expect(chunks).toContain('chunk("components/RunWideView", () => import("../components/RunWideView"))');
    expect(chunks).toMatch(/export const RunWideView = lazy\(/);
  });
});

// Card 586, task 9: the graph in the wide view is a picture of the run. The
// document-wide keys (space, arrows) and the file picker of the State graph
// segment stay with that segment.
describe("the graph in the wide view leaves the keys and the file picker alone (card 586)", () => {
  it("hands StateGraphView keys off and no file loader", () => {
    const tree = drive(<RunWideView {...props(fold(runEvents()))} />, [RunWideView, RunHead], [() => {}]);
    const view = tree.find((el) => el.type === StateGraphView);
    expect(view, "premise: the graph is drawn").toBeDefined();
    expect(view?.props.keys).toBe(false);
    expect(view?.props.onLoadFile).toBeUndefined();
  });

  it("draws no Load button", () => {
    const markup = renderToStaticMarkup(<RunWideView {...props(fold(runEvents()))} />);
    expect(markup, "premise: the graph's header is drawn").toContain('class="sg-head-actions"');
    expect(text(markup)).not.toContain("Load");
  });
});

// Card 586, task 9: the compact panel and the wide view show the same run.
describe("one run pick for the panel and the wide view (card 586)", () => {
  const both = (): RunTrack[] => [...fold(runEvents()), ...fold(workflowEvents())];
  const title = (tree: El[]): string => {
    const h3 = tree.find((el) => el.type === "h3");
    return h3 === undefined ? "" : String(h3.props.children);
  };
  const panelProps = (runs: RunTrack[]) => ({
    runs,
    live: true,
    wide: false,
    onToggleWide: () => {},
    onJump: () => {},
    onOpenPath: () => {},
  });
  const pickFirst = (tree: El[]): void =>
    tree.find((el) => el.type === "select")?.props.onChange?.({ target: { value: "0" } });

  it("going wide keeps the run picked in the panel", () => {
    const runs = both();
    const unpicked = drive(<RunWideView {...props(runs)} />, [RunWideView, RunHead], [() => {}]);
    expect(title(unpicked), "premise: without a pick the newest run shows").toBe(
      title(
        drive(
          <RunHead runs={runs} index={1} live now={T0} wide onPick={() => {}} onToggleWide={() => {}} />,
          [RunHead],
          [() => {}],
        ),
      ),
    );
    drive(<RunPanel {...panelProps(runs)} />, [RunPanel, RunHead], [pickFirst]);
    const wide = drive(<RunWideView {...props(runs)} />, [RunWideView, RunHead], [() => {}]);
    const first = drive(
      <RunHead runs={runs} index={0} live now={T0} wide onPick={() => {}} onToggleWide={() => {}} />,
      [RunHead],
      [() => {}],
    );
    expect(title(wide)).toBe(title(first));
    expect(title(wide)).not.toBe(title(unpicked));
  });

  it("going small keeps the run picked in the wide view", () => {
    const runs = both();
    drive(<RunWideView {...props(runs)} />, [RunWideView, RunHead], [pickFirst]);
    const panel = drive(<RunPanel {...panelProps(runs)} />, [RunPanel, RunHead], [() => {}]);
    const entries = panel.filter((el) => el.type === "article").map((el) => String(el.props["data-entry"]));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((key) => key.startsWith(`${R}:`))).toBe(true);
  });

  it("another session's runs start on their newest run", () => {
    const runs = both();
    drive(<RunPanel {...panelProps(runs)} />, [RunPanel, RunHead], [pickFirst]);
    const other = [...fold(workflowEvents()), ...fold(runEvents())];
    const panel = drive(<RunPanel {...panelProps(other)} />, [RunPanel, RunHead], [() => {}]);
    const entries = panel.filter((el) => el.type === "article").map((el) => String(el.props["data-entry"]));
    expect(entries.every((key) => key.startsWith(`${R}:`))).toBe(true);
  });
});
