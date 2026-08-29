// Markup pins for the workflow lens (card 293), rendered with
// react-dom/server like the other panel tests — no DOM in this gate — with
// the canvas package stubbed (these pins are about OUR markup, not React
// Flow's store).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

interface MockNode {
  id: string;
  type: string;
  data: unknown;
}

vi.mock("@xyflow/react", () => ({
  // The stub renders the nodes it is handed through the given nodeTypes, so
  // the assembled-lens pin exercises the REAL card markup.
  ReactFlow: ({
    children,
    nodes = [],
    nodeTypes = {},
  }: {
    children?: ReactNode;
    nodes?: MockNode[];
    nodeTypes?: Record<string, (p: { data: unknown }) => ReactNode>;
  }) => (
    <div data-mock="reactflow">
      {nodes.map((n) => {
        const Card = nodeTypes[n.type];
        return Card === undefined ? null : <Card key={n.id} data={n.data} />;
      })}
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

import type { RunEvent } from "../../events";
import { layoutStateGraph } from "../../stategraph/layout";
import { spawnTree } from "../spawnTree";
import { advanceScene, initialScene } from "../labScene";
import { lensFrom, WorkflowLegend, WorkflowLens, WorkflowNode, WorkflowOverlay } from "./WorkflowLens";

const EVENTS: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
  { type: "agent_spawn", agentId: "worker", parentId: "main", task: "scout the target", ts: 10 },
  { type: "agent_spawn", agentId: "orphan", parentId: "ghost", task: "a stray child", ts: 20 },
];

describe("the lens choice", () => {
  it("defaults to the machine lens and only an explicit choice flips it", () => {
    expect(lensFrom(null)).toBe("machine");
    expect(lensFrom("workflow")).toBe("workflow");
    expect(lensFrom("machine")).toBe("machine");
    expect(lensFrom("nonsense")).toBe("machine");
  });
});

describe("every edge in this lens is dashed", () => {
  it("draws each routed edge as ONE dashed path, keyed by the edge's own id", () => {
    const laid = layoutStateGraph(spawnTree(EVENTS).topo, "horizontal");
    const html = renderToStaticMarkup(<WorkflowOverlay laid={laid} />);
    const dashed = html.match(/stroke-dasharray/g) ?? [];
    expect(laid.edges.length).toBeGreaterThan(0);
    expect(dashed).toHaveLength(laid.edges.length);
    // One arc per routed edge, and each edge's OWN routed path is drawn.
    // (Replaces a former `not.toContain('class="wf-arc" d=')`, which pinned
    // JSX attribute order and was vacuously green — the re-review's finding.)
    expect(html.match(/class="wf-arc"/g) ?? []).toHaveLength(laid.edges.length);
    for (const edge of laid.edges) {
      expect(html).toContain(`d="${edge.path}"`);
    }
  });
});

describe("the legend and the honesty chip", () => {
  it("says the variant-C rule once in words, in both locales", () => {
    // Owner call C (2026-08-28): edges show who started whom, columns follow
    // time — and dashed stays dashed: reconstructed, not declared.
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={9} reported={9} />);
    expect(en).toContain("who started whom");
    expect(en).toContain("columns follow time");
    expect(en).toContain("dashed");
    expect(en).toContain("reconstructed");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={9} reported={9} />);
    expect(de).toContain("wer wen gestartet hat");
    expect(de).toContain("Spalten folgen der Zeit");
    expect(de).toContain("gestrichelt");
    expect(de).toContain("rekonstruiert");
  });

  it("hints on the COUNT, not on a drawn edge", () => {
    // The hint describes what `resolved` counts (a parent that appears in
    // the run). It was written to be true under either edge encoding, and
    // owner call C (2026-08-28) has since settled on real parent edges.
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={7} reported={9} />);
    expect(en).toContain("9 reported spawns, 7 of them with a parent that appears in the run");
    expect(en).not.toContain("parent edge");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={7} reported={9} />);
    expect(de).toContain("9 gemeldete Spawns, 7 davon mit einem Elternteil, das im Lauf vorkommt");
    expect(de).not.toContain("Eltern-Kante");
  });

  it("pins the chip on VALUES: reconstructed from N of M agents in the run", () => {
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={7} reported={9} />);
    expect(en).toContain("reconstructed from 7 of 9 agents in the run");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={7} reported={9} />);
    expect(de).toContain("rekonstruiert aus 7 von 9 Agenten des Laufs");
  });

  it("counts agents, not the boxes standing beside it", () => {
    // CARD 303, the honest rewording. `resolved`/`reported` are statements
    // about the CHILDREN IN THE EVENT STREAM, and they stayed true — but the
    // chip sits beside a canvas holding one root box and five phase boxes, and
    // "reconstructed from 13 of 13 children" beside that picture reads as a
    // count of the boxes. It never was: the boxes are phases, the number is
    // agents. The word had to go, in both locales, and the noun that replaces
    // it has to name the thing the run has rather than the thing on screen.
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={13} reported={13} />);
    expect(en).toContain("13 of 13 agents");
    expect(en).not.toContain("13 of 13 children");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={13} reported={13} />);
    expect(de).toContain("13 von 13 Agenten");
    expect(de).not.toContain("13 von 13 Kind-Agenten");
  });
});

describe("the small node card", () => {
  const data = {
    label: "scout the target",
    agentType: "app-scout",
    model: "m-small",
    state: "active" as const,
    stateLabel: "active",
    w: 132,
    h: 46,
  };
  const Card = WorkflowNode as unknown as (p: { data: unknown }) => ReturnType<typeof WorkflowLegend>;

  it("shows label, type, model and state — and stays the topology size, not the machine envelope", () => {
    const html = renderToStaticMarkup(<Card data={data} />);
    expect(html).toContain("scout the target");
    expect(html).toContain("app-scout");
    expect(html).toContain("m-small");
    expect(html).toContain("wf-node--active");
    expect(html).toContain("width:132px");
    expect(html).not.toContain("408");
  });

  it("drops the meta parts it does not know instead of printing empty separators", () => {
    const html = renderToStaticMarkup(<Card data={{ ...data, agentType: null, model: null }} />);
    // The meta line holds only the state word — no dangling separators.
    expect(html).toContain('<span class="wf-node-meta mono">active</span>');
  });
});

describe("the analyze affordance (card 294)", () => {
  it("renders the analyze node it is handed, between legend and canvas", () => {
    const scene = EVENTS.reduce((s, e) => advanceScene(s, e), initialScene());
    const html = renderToStaticMarkup(
      <WorkflowLens
        events={EVENTS}
        applied={EVENTS}
        scene={scene}
        analyze={<div data-pin="analyze-affordance">analyze this run</div>}
      />,
    );
    expect(html).toContain("analyze-affordance");
  });

  it("renders no analyze bar when none is handed (the live run)", () => {
    const scene = EVENTS.reduce((s, e) => advanceScene(s, e), initialScene());
    const html = renderToStaticMarkup(<WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} />);
    expect(html).not.toContain("analyze-affordance");
  });
});

describe("the assembled lens", () => {
  it("feeds the chip from the reconstruction: one resolved of two reported", () => {
    const scene = EVENTS.reduce((s, e) => advanceScene(s, e), initialScene());
    const html = renderToStaticMarkup(<WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} />);
    expect(html).toContain("reconstructed from 1 of 2 agents in the run");
    // Both children render as nodes, the orphan included.
    expect(html).toContain("scout the target");
    expect(html).toContain("a stray child");
  });

  it("keeps a failed child failed at the imported run's resting cursor", () => {
    // The headline case of this card family: a COMPLETE (imported) run whose
    // cursor rests after run_end. The scene no longer carries the children,
    // so without the terminal-state fold every card would wear the green
    // done border and the failure would be erased.
    const ended: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "worker", parentId: "main", task: "scout the target", ts: 10 },
      {
        type: "agent_message",
        from: "worker",
        to: "main",
        role: "result",
        state: "failed",
        text: "gave up",
        ts: 20,
      },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 30 },
    ];
    const scene = ended.reduce((s, e) => advanceScene(s, e), initialScene());
    const html = renderToStaticMarkup(<WorkflowLens events={ended} applied={ended} scene={scene} />);
    // The root legitimately reads done; the worker must read failed.
    expect(html).toMatch(/wf-node--failed[^>]*scout the target/);
  });
});
