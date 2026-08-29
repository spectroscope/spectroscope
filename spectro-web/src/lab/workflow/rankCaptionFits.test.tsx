// Card 303, defect A — the drawing half. layout.ts hands each caption the room
// it may use (rankCaptionRoom.test.ts); this pins that the overlay actually
// USES it, and that an over-long title is cut with an ellipsis instead of being
// allowed to run on into the column next door.
//
// The cut is real, and it takes the DETAIL half first — on the shipped scenario
// four of five captions are already clipped at the fit zoom. The recovery path
// is the phase box directly below: it carries the column's title as its heading
// and the column's detail on a second line of its own tooltip
// (`captionDetailRecoverable.test.tsx`). The caption adds no tooltip of its own,
// because the overlay is `pointer-events: none` on purpose (card 293: it
// swallowed pans and node clicks near the graph origin) and a 180x14 strip that
// takes the pointer back is a strip the reader can no longer grab.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ReactFlow: () => null,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
}));

import { layoutStateGraph, type Topology } from "../../stategraph/layout";
import { WorkflowOverlay } from "./WorkflowLens";

const LONG = "merge - one picture out of five, and a title nobody is going to shorten";

const topo: Topology = {
  entry: "p0",
  nodes: [
    { id: "p0", label: "p0" },
    { id: "p1", label: "p1" },
  ],
  edges: [{ from: "p0", to: "p1", kind: "spawn" }],
  ranks: new Map([
    ["p0", 0],
    ["p1", 1],
  ]),
  rankCaptions: new Map([
    [0, { title: LONG, detail: "the detail line" }],
    [1, { title: LONG, detail: null }],
  ]),
};

describe("the overlay draws a caption inside its own column", () => {
  const laid = layoutStateGraph(topo, "horizontal");
  const html = renderToStaticMarkup(<WorkflowOverlay laid={laid} />);

  it("gives every caption a box of the width the layout allowed it", () => {
    for (const l of laid.rankLabels) {
      expect(html).toContain(`width="${l.maxWidth}"`);
    }
    // Two captions, two boxes — not one box reused and not none.
    expect(html.match(/<foreignObject/g) ?? []).toHaveLength(2);
  });

  it("keeps the caption's own class, so the styling still reaches it", () => {
    expect(html).toContain("wf-ranklabel");
    expect(html).toContain("wf-rankdetail");
    expect(html).toContain(LONG);
  });

  it("stops drawing the caption as unbounded SVG text", () => {
    // The shipped shape: <text class="wf-ranklabel" x=… y=…> with no width at
    // all. SVG text cannot be truncated by a stylesheet, so as long as the
    // caption is a <text> node the box above is decoration.
    expect(html).not.toMatch(/<text[^>]*wf-ranklabel/);
  });

  it("says nothing at all about a column nobody named", () => {
    const bare = layoutStateGraph({ ...topo, rankCaptions: undefined }, "horizontal");
    const none = renderToStaticMarkup(<WorkflowOverlay laid={bare} />);
    expect(none).not.toContain("wf-ranklabel");
    expect(none).not.toContain("foreignObject");
  });
});
