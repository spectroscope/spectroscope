// Card 302: the lens picks its language honestly.
//
// Declared (the run had a state file) → SOLID edges and named phase columns.
// Recovered (a Task spawn tree, nothing declared) → DASHED and derived waves,
// exactly as card 293 shipped it. Both branches are pinned here, because a
// lens that only ever got tested on one of them would be free to draw the
// other any way at all.
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

import type { RunEvent } from "../../events";
import { layoutStateGraph } from "../../stategraph/layout";
import { spawnTree } from "../spawnTree";
import type { WorkflowDeclaration } from "../workflowGraph";
import { WorkflowLegend, WorkflowOverlay } from "./WorkflowLens";

const EVENTS: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
  { type: "agent_spawn", agentId: "wf", parentId: "main", task: "a run", ts: 10 },
  { type: "agent_spawn", agentId: "one", parentId: "wf", task: "first", ts: 20 },
  { type: "text_delta", agentId: "one", text: "…", ts: 90 },
  { type: "agent_spawn", agentId: "two", parentId: "wf", task: "second", ts: 30 },
  { type: "text_delta", agentId: "two", text: "…", ts: 95 },
];

const DECL: WorkflowDeclaration = new Map([
  [
    "wf",
    {
      phases: [
        { title: "plan", detail: "decide what to look at" },
        { title: "survey", detail: null },
      ],
      rankOf: new Map([
        ["one", 0],
        ["two", 1],
      ]),
    },
  ],
]);

const laidFor = (d?: WorkflowDeclaration) => layoutStateGraph(spawnTree(EVENTS, d).topo, "horizontal");

describe("the stroke says where the columns came from", () => {
  it("recovered: every edge dashed, as card 293 shipped it", () => {
    const laid = laidFor();
    const html = renderToStaticMarkup(<WorkflowOverlay laid={laid} />);
    expect(laid.edges.length).toBeGreaterThan(0);
    expect(html.match(/stroke-dasharray/g) ?? []).toHaveLength(laid.edges.length);
  });

  it("declared: every edge solid — no dash anywhere", () => {
    const laid = laidFor(DECL);
    const html = renderToStaticMarkup(<WorkflowOverlay laid={laid} declared />);
    expect(laid.edges.length).toBeGreaterThan(0);
    expect(html.match(/class="wf-arc"/g) ?? []).toHaveLength(laid.edges.length);
    expect(html).not.toContain("stroke-dasharray");
  });
});

describe("the columns carry the script's words", () => {
  it("declared: the phase title is drawn on its column, the detail beside it", () => {
    const html = renderToStaticMarkup(<WorkflowOverlay laid={laidFor(DECL)} declared />);
    expect(html).toContain("plan");
    expect(html).toContain("decide what to look at");
    expect(html).toContain("survey");
  });

  it("recovered: no column carries a name the run never gave one", () => {
    const html = renderToStaticMarkup(<WorkflowOverlay laid={laidFor()} />);
    expect(html).not.toContain("wf-ranklabel");
  });
});

describe("the legend says WHICH picture this is, in both locales", () => {
  it("declared, EN and DE", () => {
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={2} reported={2} declared />);
    expect(en).toContain("declared before it started");
    expect(en).toContain("solid");
    expect(en).toContain("declared");
    expect(en).not.toContain("dashed");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={2} reported={2} declared />);
    expect(de).toContain("vorher deklariert hat");
    expect(de).toContain("durchgezogen");
    expect(de).not.toContain("gestrichelt");
  });

  it("recovered, EN and DE — the card 293 sentence, unchanged", () => {
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={2} reported={2} />);
    expect(en).toContain("columns follow time");
    expect(en).toContain("dashed");
    expect(en).toContain("recovered");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={2} reported={2} />);
    expect(de).toContain("Spalten folgen der Zeit");
    expect(de).toContain("gestrichelt");
    expect(de).toContain("rekonstruiert");
  });
});
