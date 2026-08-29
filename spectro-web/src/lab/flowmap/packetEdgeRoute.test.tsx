// The right-angled rail's contract (card 287): the class list and the
// `p-${id}` path id are what the comets and the stylesheet key on, the lane
// comes from the id hash (never an index), and a canvas that provides no
// obstacle boxes still renders — the helper's own trunk, no crash.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Position } from "@xyflow/react";
import { PacketEdge, railLane } from "./PacketEdge";
import { RailBoxes } from "./railBoxes";

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

const LANES = [-10, 0, 10];

describe("railLane", () => {
  it("is stable per id and lands in the three lanes", () => {
    const a = railLane("e-sub-w1-llm");
    expect(railLane("e-sub-w1-llm")).toBe(a);
    for (const id of ["e-agent-llm", "e-sub-x-osdisk", "e-osmcp-osnet"]) {
      expect(LANES).toContain(railLane(id));
    }
  });

  // The lane of a rail that CONVERGES on a station is not this hash's business —
  // it comes from the seat, in the edge's own data (see railRoute.stationLane
  // and the converging-rail tests there). The hash only serves the rails that
  // arrive somewhere alone, so three lanes are what it needs.
  it("stays three lanes, because the rails it serves do not converge", () => {
    const seen = new Set<number>();
    for (const id of ["e-user-agent", "e-agent-llm", "e-osmcp-osnet", "e-osnet-netz", "e-netz-mcpserver"]) {
      expect([-10, 0, 10]).toContain(railLane(id));
      seen.add(railLane(id));
    }
    expect(seen.size).toBeGreaterThan(1);
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

// The lane only reaches the geometry when the canvas provides obstacle boxes;
// without them the helper routes on its own trunk and no lane is read at all.
describe("PacketEdge with obstacle boxes", () => {
  const BOXES = [
    { id: "agent", x: 500, y: 150, w: 680, h: 359 },
    { id: "os-shell", x: 236, y: 1070, w: 200, h: 63 },
    { id: "w1", x: 1430, y: 110, w: 408, h: 324 },
  ];
  const render = (props: Record<string, unknown>, data: Record<string, unknown>) => {
    const Edge = PacketEdge as unknown as (p: Record<string, unknown>) => ReturnType<typeof PacketEdge>;
    return renderToStaticMarkup(
      <RailBoxes.Provider value={BOXES}>
        <svg>
          <Edge {...props} data={data} />
        </svg>
      </RailBoxes.Provider>,
    );
  };
  const dOf = (markup: string) => / d="([^"]+)"/.exec(markup)?.[1] ?? "";

  it("routes on the lane the emitter gave it, not on the hash of its id", () => {
    // This id hashes to +10, and in this box set a +10 nudge is one the router
    // actually spends — so both halves of the claim move the drawn path instead
    // of being swallowed by a nudge that was going to be dropped anyway.
    const props = { ...(edgeProps as Record<string, unknown>), id: "e-agent-osdisk" };
    expect(railLane("e-agent-osdisk")).toBe(10);
    const hashed = dOf(render(props, {}));
    expect(dOf(render(props, { lane: 10 }))).toBe(hashed);
    expect(dOf(render(props, { lane: 5 }))).not.toBe(hashed);
    expect(dOf(render(props, { lane: 20 }))).not.toBe(dOf(render(props, { lane: 5 })));
  });
});
