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

const LANES = [-20, -10, 0, 10, 20];

describe("railLane", () => {
  it("is stable per id and lands in the five lanes", () => {
    const a = railLane("e-sub-w1-llm");
    expect(railLane("e-sub-w1-llm")).toBe(a);
    for (const id of ["e-agent-llm", "e-sub-x-osdisk", "e-osmcp-osnet"]) {
      expect(LANES).toContain(railLane(id));
    }
  });

  // Card 295 wired every worker to every station, so up to seven rails now
  // converge on ONE station handle. Three lanes could not hold them; five can.
  it("spreads the real converging rail ids over more than three lanes", () => {
    const lanes = new Set<number>();
    for (let i = 1; i <= 8; i++) {
      for (const s of ["osdisk", "osshell", "osmcp", "llm", "agent"]) {
        lanes.add(railLane(`e-sub-worker-${i}-${s}`));
      }
    }
    expect(lanes.size).toBeGreaterThan(3);
    for (const l of lanes) expect(LANES).toContain(l);
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

  it("a worker's live leg carries the worker classes; main's does not", () => {
    const Edge = PacketEdge as unknown as (p: Record<string, unknown>) => ReturnType<typeof PacketEdge>;
    const worker = renderToStaticMarkup(
      <svg>
        <Edge {...(edgeProps as Record<string, unknown>)} data={{ active: true, worker: true }} />
      </svg>,
    );
    expect(worker).toContain("pf-rail--worker");
    expect(worker).toContain("pf-comet--worker");
    const main = renderToStaticMarkup(
      <svg>
        <Edge {...(edgeProps as Record<string, unknown>)} data={{ active: true }} />
      </svg>,
    );
    expect(main).not.toContain("pf-rail--worker");
    expect(main).not.toContain("pf-comet--worker");
  });
});
