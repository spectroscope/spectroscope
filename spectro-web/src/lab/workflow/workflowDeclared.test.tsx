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
import { advanceScene, initialScene } from "../labScene";
import { t } from "../../i18n/i18n";
import { currentLang } from "../../state/lang";
import type { WorkflowDeclaration } from "../workflowGraph";
import { WorkflowLegend, WorkflowLens, WorkflowOverlay } from "./WorkflowLens";

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
        {
          title: "plan",
          detail: "decide what to look at",
          members: [
            {
              agentId: "one",
              label: "",
              model: null,
              state: "pending" as const,
              startedAt: null,
              endedAt: null,
            },
          ],
        },
        {
          title: "survey",
          detail: null,
          members: [
            {
              agentId: "two",
              label: "",
              model: null,
              state: "pending" as const,
              startedAt: null,
              endedAt: null,
            },
          ],
        },
      ],
      unplaced: [],
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

  // REPLACED, not loosened. This used to assert that a declared tree draws
  // every edge solid, which was the whole-tree boolean talking: the workflow's
  // OWN spawn was reconstructed from the events like any other, and drawing it
  // solid said the script had declared it. The stroke is per edge.
  it("declared: the boxes the script placed go solid, the spawn of the run itself stays dashed", () => {
    const tree = spawnTree(EVENTS, DECL);
    const laid = layoutStateGraph(tree.topo, "horizontal");
    const html = renderToStaticMarkup(<WorkflowOverlay laid={laid} declared={tree.declaredNodes} />);
    // main → wf (a reconstruction), wf → plan, plan → survey (declared).
    expect(laid.edges).toHaveLength(3);
    expect(html.match(/class="wf-arc"/g) ?? []).toHaveLength(3);
    expect(html.match(/stroke-dasharray/g) ?? []).toHaveLength(1);
  });
});

describe("the columns carry the script's words", () => {
  it("declared: the phase title is drawn on its column, the detail beside it", () => {
    const tree = spawnTree(EVENTS, DECL);
    const html = renderToStaticMarkup(
      <WorkflowOverlay laid={layoutStateGraph(tree.topo, "horizontal")} declared={tree.declaredNodes} />,
    );
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
  // The `not.toContain("dashed")` this test used to carry has been REPLACED
  // rather than dropped: a declared tree really does hold both strokes — the
  // spawn of the run itself, and any plain Task child beside it, are still
  // reconstructions — so a legend that named only the solid one would leave
  // the dashed edges on screen unexplained.
  it("declared, EN and DE — and it says what the SOLID edge means, which is succession", () => {
    // Card 302 changed what a solid edge is. It used to be a spawn the script
    // had placed; it is now "this phase leads to the next one". A legend left
    // saying "who started whom" would describe the picture that was replaced.
    const en = renderToStaticMarkup(<WorkflowLegend lang="en" resolved={2} reported={2} declared />);
    expect(en).toContain("leads to the next");
    expect(en).toContain("solid");
    expect(en).toContain("dashed");
    expect(en).not.toContain("who started whom");
    const de = renderToStaticMarkup(<WorkflowLegend lang="de" resolved={2} reported={2} declared />);
    expect(de).toContain("führt zur nächsten");
    expect(de).toContain("durchgezogen");
    expect(de).toContain("gestrichelt");
    expect(de).not.toContain("wer wen gestartet hat");
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

/**
 * THE DELIVERY CHAIN. Every test above hands the presentational components
 * their booleans and sets BY HAND, which pins how they draw and nothing about
 * whether the lens ever computes or forwards the truth. Cut at either seam —
 * the overlay's set or the legend's flag — the whole suite stayed green, and a
 * declared workflow could draw dashed under a legend reading "recovered".
 * These render the ASSEMBLED lens instead.
 */
describe("the lens hands its own reconstruction down to both", () => {
  const scene = EVENTS.reduce((s, e) => advanceScene(s, e), initialScene());
  const lang = currentLang();

  it("declared: the legend says declared, the columns carry the words, the declared edges are solid", () => {
    const html = renderToStaticMarkup(
      <WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} declared={DECL} />,
    );
    expect(html).toContain(t(lang, "lab.lens.legendDeclared"));
    expect(html).toContain(t(lang, "lab.lens.sourceDeclared"));
    expect(html).toContain("wf-ranklabel");
    expect(html).toContain("plan");
    // Three edges on screen, one of them the run's own reconstructed spawn.
    expect(html.match(/class="wf-arc"/g) ?? []).toHaveLength(3);
    expect(html.match(/stroke-dasharray/g) ?? []).toHaveLength(1);
  });

  it("recovered: the legend says recovered, no column is named, every edge dashed", () => {
    const html = renderToStaticMarkup(<WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} />);
    expect(html).not.toContain(t(lang, "lab.lens.legendDeclared"));
    expect(html).toContain(t(lang, "lab.lens.sourceRecovered"));
    expect(html).not.toContain("wf-ranklabel");
    const arcs = (html.match(/class="wf-arc"/g) ?? []).length;
    expect(arcs).toBeGreaterThan(0);
    expect(html.match(/stroke-dasharray/g) ?? []).toHaveLength(arcs);
  });
});
