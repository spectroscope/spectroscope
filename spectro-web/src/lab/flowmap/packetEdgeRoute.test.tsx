// The right-angled rail's contract (card 287): the class list and the
// `p-${id}` path id are what the comets and the stylesheet key on, the lane
// comes from the id hash (never an index), and a canvas that provides no
// obstacle boxes still renders — the helper's own trunk, no crash.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Position } from "@xyflow/react";
import { PacketEdge, railLane } from "./PacketEdge";

const edgeProps = {
  id: "e-agent-osshell",
  source: "agent",
  target: "os-shell",
  sourceX: 590,
  sourceY: 509,
  targetX: 336,
  targetY: 1070,
  sourcePosition: Position.Bottom,
  targetPosition: Position.Top,
} as never;

describe("railLane", () => {
  it("is stable per id and lands in the three lanes", () => {
    const a = railLane("e-sub-w1-llm");
    expect(railLane("e-sub-w1-llm")).toBe(a);
    for (const id of ["e-agent-llm", "e-sub-x-osdisk", "e-osmcp-osnet"]) {
      expect([-10, 0, 10]).toContain(railLane(id));
    }
  });
});

describe("PacketEdge without an obstacle provider", () => {
  it("renders the rail with its classes and path id — the fleet machine room's case", () => {
    const Edge = PacketEdge as unknown as (p: Record<string, unknown>) => ReturnType<typeof PacketEdge>;
    const active = renderToStaticMarkup(
      <svg>
        <Edge {...(edgeProps as Record<string, unknown>)} data={{ active: true, flow: true }} />
      </svg>,
    );
    expect(active).toContain('id="p-e-agent-osshell"');
    expect(active).toContain("pf-rail--active");
    expect(active).toContain("pf-comet");
    expect(active).toContain('d="');
    const dim = renderToStaticMarkup(
      <svg>
        <Edge {...(edgeProps as Record<string, unknown>)} data={{ dim: true }} />
      </svg>,
    );
    expect(dim).toContain("opacity:0.4");
    expect(dim).not.toContain("pf-comet");
  });
});
