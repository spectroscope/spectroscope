import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import type { FleetModel, FleetNode } from "../../spectrum/fleetModel";
import { buildFleetLabScene } from "../fleetLabScene";
import { deriveDetail, EXPANDED_CARD } from "./sceneToFlow";
import { fleetToFlow, FLEET_CARD_STEP_Y } from "./fleetToFlow";

const ts = 1;

function node(id: string, role: string, connected = true): FleetNode {
  return { id, role, capabilities: [], topic: "ctx.events", connected, lastSeen: ts };
}

function flowOf(roster: FleetNode[], events: RunEvent[]) {
  const model: FleetModel = { roster, events, frames: [], epochBySender: {} };
  const scene = buildFleetLabScene(model);
  return { scene, flow: fleetToFlow(scene, deriveDetail(events), { lang: "en" }) };
}

const byId = (flow: { nodes: { id: string }[] }, id: string) =>
  flow.nodes.find((n) => n.id === id) as
    | { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }
    | undefined;

describe("fleetToFlow — the machine-room layout", () => {
  it("renders one card per node in a single column for a small fleet", () => {
    const { flow } = flowOf(
      [node("main", "root"), node("worker-1", "worker"), node("explore-1", "explorer")],
      [],
    );
    const cards = flow.nodes.filter((n) => n.type === "subagent");
    expect(cards.map((c) => c.id)).toEqual(["card-main", "card-worker-1", "card-explore-1"]);
    const xs = new Set(cards.map((c) => c.position.x));
    expect(xs.size).toBe(1); // one column
    const ys = cards.map((c) => c.position.y);
    expect(ys[1] - ys[0]).toBe(FLEET_CARD_STEP_Y);
  });

  it("splits a big fleet into columns and grows the zones instead of overlapping the OS band", () => {
    const roster = [node("main", "root")];
    for (let i = 1; i <= 8; i++) roster.push(node(`worker-${i}`, "worker"));
    const { flow } = flowOf(roster, []);
    const cards = flow.nodes.filter((n) => n.type === "subagent");
    expect(cards.length).toBe(9);
    const xs = [...new Set(cards.map((c) => c.position.x))];
    expect(xs.length).toBeGreaterThan(1); // wrapped into more than one column
    // No card may reach into the OS band.
    const os = byId(flow, "z-os")!;
    for (const c of cards) {
      expect(c.position.y + 150).toBeLessThanOrEqual(os.position.y);
    }
    // The mac zone contains every card.
    const mac = byId(flow, "z-mac")!;
    const macW = (mac as unknown as { style: { width: number } }).style.width;
    for (const c of cards) {
      expect(c.position.x + 216).toBeLessThanOrEqual(macW);
    }
  });

  it("puts the remote LLM beyond the boundary and rails remote nodes to it", () => {
    const { flow } = flowOf(
      [node("main", "root")],
      [{ type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts }],
    );
    const llm = byId(flow, "llm")!;
    const boundary = byId(flow, "z-boundary")!;
    expect(llm.position.x).toBeGreaterThan(boundary.position.x);
    expect(byId(flow, "llm-local")).toBeUndefined(); // no local backend seen
    const rail = flow.edges.find((e) => e.id === "e-card-main-llm")!;
    expect(rail.target).toBe("llm");
    expect((rail.data as { net: boolean }).net).toBe(true);
  });

  it("draws ONE LLM station, outside, for every mix of providers (card 304)", () => {
    // The fleet used to split its cards into a local set and a remote set and
    // draw a station for each — so a pure-ollama fleet had no boundary traffic
    // at all and a mixed fleet had two model boxes. One station now, beyond the
    // boundary, and every card rails across it.
    const mixes: [string, RunEvent[]][] = [
      [
        "pure ollama",
        [{ type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts }],
      ],
      [
        "mixed",
        [
          { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts },
          { type: "run_start", runId: "r2", agentId: "worker-1", prompt: "sub", provider: "ollama", ts },
        ],
      ],
      ["no provider yet", []],
    ];
    for (const [name, events] of mixes) {
      const { flow } = flowOf([node("main", "root"), node("worker-1", "worker")], events);
      expect(byId(flow, "llm-local"), name).toBeUndefined();
      const llm = byId(flow, "llm")!;
      expect(llm, name).toBeDefined();
      expect(llm.position.x, name).toBeGreaterThan(byId(flow, "z-boundary")!.position.x);
      for (const id of ["main", "worker-1"]) {
        const rail = flow.edges.find((e) => e.id === `e-card-${id}-llm`)!;
        expect(rail.target, `${name}/${id}`).toBe("llm");
        expect((rail.data as { net: boolean }).net, `${name}/${id}`).toBe(true);
      }
    }
  });

  it("lights the shared disk station for whichever node is on it", () => {
    const { flow } = flowOf(
      [node("main", "root"), node("worker-1", "worker")],
      [
        {
          type: "tool_call",
          agentId: "worker-1",
          callId: "c1",
          name: "write_file",
          input: { path: "x/y.txt" },
          ts,
        },
      ],
    );
    const disk = byId(flow, "os-disk")!;
    expect(disk.data.active).toBe(true);
    expect(disk.data.disk).toBe("write");
    const rail = flow.edges.find((e) => e.id === "e-card-worker-1-osdisk")!;
    expect((rail.data as { active: boolean }).active).toBe(true);
  });

  it("shows the user station only when a main node exists, railed to main", () => {
    const withMain = flowOf([node("main", "root"), node("worker-1", "worker")], []);
    expect(byId(withMain.flow, "user")).toBeDefined();
    expect(withMain.flow.edges.some((e) => e.id === "e-user-main")).toBe(true);

    const noMain = flowOf([node("worker-1", "worker"), node("worker-2", "worker")], []);
    expect(byId(noMain.flow, "user")).toBeUndefined();
  });

  it("expanded: the card grid starts clear of the wide user card", () => {
    const model: FleetModel = { roster: [node("main", "root")], events: [], frames: [], epochBySender: {} };
    const scene = buildFleetLabScene(model);
    const flow = fleetToFlow(scene, deriveDetail([]), { lang: "en", expanded: true });
    const user = byId(flow, "user")!;
    const card = byId(flow, "card-main")!;
    expect(card.position.x).toBeGreaterThan(user.position.x + EXPANDED_CARD.user.w);
  });

  it("expanded: the OS band clears the last row of OPEN cards", () => {
    const roster = [node("main", "root")];
    for (let i = 1; i <= 3; i++) roster.push(node(`worker-${i}`, "worker"));
    const { flow } = flowOf(roster, []);
    const expanded = fleetToFlow(
      buildFleetLabScene({ roster, events: [], frames: [], epochBySender: {} }),
      deriveDetail([]),
      {
        lang: "en",
        expanded: true,
      },
    );
    const os = byId(expanded, "z-os")!;
    for (const card of expanded.nodes.filter((n) => n.type === "subagent")) {
      expect(card.position.y + EXPANDED_CARD["fleet-card"].h).toBeLessThanOrEqual(os.position.y);
    }
    // compact keeps its own, tighter reserve
    expect(byId(flow, "z-os")!.position.y).toBeLessThan(os.position.y);
  });

  it("expanded: the outside frame contains the OPEN LLM station, on a local backend too", () => {
    const roster = [node("main", "root")];
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts },
    ];
    const flow = fleetToFlow(
      buildFleetLabScene({ roster, events, frames: [], epochBySender: {} }),
      deriveDetail(events),
      {
        lang: "en",
        expanded: true,
      },
    );
    const llm = byId(flow, "llm")!;
    const outside = byId(flow, "z-outside")!;
    const style = outside as unknown as { style: { width: number; height: number } };
    expect(llm.position.y + EXPANDED_CARD.llm.h).toBeLessThanOrEqual(outside.position.y + style.style.height);
    expect(llm.position.x + EXPANDED_CARD.llm.w).toBeLessThanOrEqual(outside.position.x + style.style.width);
  });

  it("compact: the computed frame is untouched", () => {
    const roster = [node("main", "root"), node("worker-1", "worker")];
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts },
    ];
    const { flow } = flowOf(roster, events);
    expect(byId(flow, "user")!.position).toEqual({ x: 40, y: 150 });
    expect(byId(flow, "card-main")!.position).toEqual({ x: 250, y: 110 });
    expect(byId(flow, "card-worker-1")!.position).toEqual({ x: 250, y: 300 });
    expect(byId(flow, "z-os")!.position).toEqual({ x: 24, y: 668 });
    expect(byId(flow, "os-disk")!.position).toEqual({ x: 58, y: 748 });
    expect(byId(flow, "llm-local")!.position).toEqual({ x: 880, y: 676 });
    const mac = byId(flow, "z-mac")! as unknown as { style: { width: number; height: number } };
    expect(mac.style).toEqual({ width: 1344, height: 940 });
  });

  it("streams think/answer into the station the speaking node belongs to", () => {
    const { flow } = flowOf(
      [node("main", "root"), node("worker-1", "worker")],
      [
        { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts },
        { type: "run_start", runId: "r2", agentId: "worker-1", prompt: "sub", provider: "ollama", ts },
        { type: "thinking_delta", agentId: "main", text: "remote thought", ts },
        { type: "thinking_delta", agentId: "worker-1", text: "local thought", ts },
      ],
    );
    const remoteThink = byId(flow, "llm")!.data.think as { agent: string; text: string }[];
    const localThink = byId(flow, "llm-local")!.data.think as { agent: string; text: string }[];
    expect(remoteThink).toEqual([{ agent: "main", text: "remote thought" }]);
    expect(localThink).toEqual([{ agent: "worker-1", text: "local thought" }]);
  });
});
