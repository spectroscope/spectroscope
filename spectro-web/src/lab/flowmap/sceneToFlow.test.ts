import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { agentDirectory } from "../agentDirectory";
import { advanceScene, initialScene } from "../labScene";
import { foldSeatPool } from "./workerGrid";
import { SUB_CARD_TYPICAL_H, SUB_ROW_PITCH } from "./cardGeometry";
import { t } from "../../i18n/i18n";
import {
  activity,
  deriveDetail,
  EXPANDED_CARD,
  MAX_CARD_SHOTS,
  EXP_GAP,
  reportOversizeCards,
  sceneToFlow,
  seatCollisions,
} from "./sceneToFlow";

const T = 1700000000000;

const runStart = (provider: string): RunEvent =>
  ({ type: "run_start", runId: "r1", agentId: "main", prompt: "hi", provider, ts: T }) as RunEvent;
const spawn = (agentId: string): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task: `task ${agentId}`, ts: T }) as RunEvent;

function build(events: RunEvent[], provider: string, model = "m") {
  const scene = events.reduce(advanceScene, initialScene());
  const detail = deriveDetail(events);
  return sceneToFlow(scene, detail, { provider, model });
}

const ids = (flow: { nodes: { id: string }[] }) => flow.nodes.map((n) => n.id);

describe("sceneToFlow", () => {
  it("emits the core agent-system, OS band and external nodes", () => {
    const flow = build([runStart("anthropic")], "anthropic");
    for (const id of [
      "user",
      "agent",
      "os-disk",
      "os-shell",
      "os-mcp",
      "os-net",
      "llm",
      "netz",
      "mcpserver",
    ]) {
      expect(ids(flow)).toContain(id);
    }
    // background zones
    for (const id of ["z-mac", "z-os", "z-outside"]) expect(ids(flow)).toContain(id);
  });

  it("the LLM sits BEYOND the network boundary, which is drawn", () => {
    // Both halves used to depend on the provider — the boundary was not drawn
    // at all for a local one, and the LLM sat inside the machine. Card 304 made
    // this one statement; the block at the foot of this file pins the rest of
    // the geometry that follows from it.
    for (const provider of ["anthropic", "ollama"]) {
      const flow = build([runStart(provider)], provider);
      expect(ids(flow)).toContain("z-boundary");
      const boundary = flow.nodes.find((n) => n.id === "z-boundary")!;
      const llm = flow.nodes.find((n) => n.id === "llm")!;
      expect(llm.position.x, provider).toBeGreaterThan(boundary.position.x);
    }
  });

  it("lays out three subagents with equal, non-clumping vertical spacing inside the band", () => {
    const flow = build(
      [runStart("ollama"), spawn("worker-1"), spawn("worker-2"), spawn("worker-3")],
      "ollama",
    );
    const subs = flow.nodes
      .filter((n) => n.id.startsWith("sub-"))
      .sort((a, b) => a.position.y - b.position.y);
    expect(subs).toHaveLength(3);
    const gap1 = subs[1].position.y - subs[0].position.y;
    const gap2 = subs[2].position.y - subs[1].position.y;
    expect(gap1).toBe(gap2); // deterministic, evenly spaced — the anti-clump rule
    expect(gap1).toBeGreaterThanOrEqual(132 + 44); // >= card height + hard min gap
    expect(subs[0].position.y).toBeGreaterThanOrEqual(110); // top of the band
    expect(subs[2].position.y + 132).toBeLessThanOrEqual(632); // last card clears the OS band
  });

  it("seats a fourth compact worker in a second column instead of dropping it (card 287)", () => {
    const flow = build([runStart("ollama"), spawn("w1"), spawn("w2"), spawn("w3"), spawn("w4")], "ollama");
    const subs = flow.nodes.filter((n) => n.id.startsWith("sub-"));
    expect(subs).toHaveLength(4);
    // three rows deep, so the fourth opens column two at the first row's y
    expect(subs[3].position.x).toBeGreaterThan(subs[0].position.x);
    expect(subs[3].position.y).toBe(subs[0].position.y);
  });

  it("clamps compact at six cards — past the ceiling the chip confesses, the map stays readable", () => {
    const spawns = Array.from({ length: 8 }, (_, i) => spawn(`w${i + 1}`));
    const flow = build([runStart("ollama"), ...spawns], "ollama");
    expect(flow.nodes.filter((n) => n.id.startsWith("sub-"))).toHaveLength(6);
  });

  it("compact second column pushes the in-machine LLM clear instead of overlapping it", () => {
    const spawns = Array.from({ length: 4 }, (_, i) => spawn(`w${i + 1}`));
    const flow = build([runStart("ollama"), ...spawns], "ollama");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    const lastSub = flow.nodes.filter((n) => n.id.startsWith("sub-"))[3];
    expect(llm.position.x).toBeGreaterThanOrEqual(lastSub.position.x + 216 + 44);
  });

  it("shared stations light for WHICHEVER loop is on them (child at the disk)", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      {
        type: "tool_call",
        agentId: "worker-1",
        callId: "k1",
        name: "write_file",
        input: { path: "docs/plan.md" },
        ts: T,
      } as RunEvent,
    ];
    const flow = build(events, "ollama");
    const disk = flow.nodes.find((n) => n.id === "os-disk")!;
    expect(disk.data.active).toBe(true); // a CHILD is writing, not main
    expect(disk.data.file).toBe("plan.md");
    // the child's own rail to the shared station exists and is lit
    const rail = flow.edges.find((e) => e.id === "e-sub-worker-1-osdisk")!;
    expect(rail).toBeTruthy();
    expect((rail.data as { active: boolean }).active).toBe(true);
  });

  // ---- card 295: the child's line into the OS band -----------------------
  // The complaint was that worker cards float. They had a rail to a station
  // ONLY while standing on it, so between two tool calls — and, before the
  // fold fix, for the whole length of every gated one — there was no line at
  // all. The rails are structural now: always drawn, dimmed until used.
  const rails = (id: string) => [`e-${id}-osdisk`, `e-${id}-osshell`, `e-${id}-osmcp`];

  it("a spawned child is wired to all three stations before it touches any", () => {
    const flow = build([runStart("ollama"), spawn("worker-1")], "ollama");
    for (const id of rails("sub-worker-1")) {
      const e = flow.edges.find((x) => x.id === id);
      expect(e, id).toBeTruthy();
      const d = e!.data as { active: boolean; dim: boolean };
      expect(d.active, id).toBe(false);
      expect(d.dim, id).toBe(true); // structural, not hot — same treatment as the rail home to the agent
    }
  });

  it("a GATED child command keeps its shell rail and its station lit end to end", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      {
        type: "tool_call",
        agentId: "worker-1",
        callId: "k1",
        name: "run_command",
        input: { command: "npm ci" },
        ts: T,
      } as RunEvent,
      {
        type: "permission_request",
        agentId: "worker-1",
        callId: "k1",
        name: "run_command",
        input: {},
        ts: T,
      } as RunEvent,
      { type: "permission_decision", callId: "k1", allowed: true, ts: T } as RunEvent,
    ];
    const flow = build(events, "ollama");
    const shell = flow.nodes.find((n) => n.id === "os-shell")!;
    expect(shell.data.active).toBe(true);
    expect(shell.data.command).toBe("npm ci");
    const rail = flow.edges.find((e) => e.id === "e-sub-worker-1-osshell")!;
    const d = rail.data as { active: boolean; dim: boolean };
    expect(d.active).toBe(true);
    expect(d.dim).toBe(false);
  });

  it("a child's live station rail is marked as a worker's, main's is not", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      {
        type: "tool_call",
        agentId: "worker-1",
        callId: "k1",
        name: "write_file",
        input: { path: "a.md" },
        ts: T,
      } as RunEvent,
    ];
    const flow = build(events, "ollama");
    const child = flow.edges.find((e) => e.id === "e-sub-worker-1-osdisk")!;
    expect((child.data as { worker: boolean }).worker).toBe(true);
    const main = flow.edges.find((e) => e.id === "e-agent-osdisk")!;
    expect((main.data as { worker: boolean }).worker).toBe(false);
  });

  it("MEASURED cost: six workers add eighteen station rails, and every idle one is dimmed", () => {
    const events: RunEvent[] = [runStart("ollama"), ...[1, 2, 3, 4, 5, 6].map((i) => spawn(`worker-${i}`))];
    const flow = build(events, "ollama");
    const station = flow.edges.filter((e) => /^e-sub-.*-os(disk|shell|mcp)$/.test(e.id));
    expect(station).toHaveLength(18);
    expect(station.every((e) => (e.data as { dim: boolean }).dim)).toBe(true);
    expect(station.every((e) => !(e.data as { active: boolean }).active)).toBe(true);
  });

  it("every rail arriving at one station carries a lane of its own", () => {
    const events: RunEvent[] = [runStart("ollama"), ...[1, 2, 3, 4, 5, 6].map((i) => spawn(`worker-${i}`))];
    const flow = build(events, "ollama");
    for (const target of ["os-disk", "os-shell", "os-mcp"]) {
      // main plus one per seated worker — every rail that shares the handle
      const arriving = flow.edges.filter((e) => e.target === target);
      expect(arriving).toHaveLength(7);
      expect(new Set(arriving.map((e) => e.targetHandle)).size).toBe(1);
      const lanes = arriving.map((e) => (e.data as { lane: number | null }).lane);
      expect(lanes.every((l) => typeof l === "number")).toBe(true);
      expect(new Set(lanes).size).toBe(arriving.length);
    }
  });

  it("the OS node names the demoted occupant too, with its id available to address the rail", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      {
        type: "tool_call",
        agentId: "main",
        callId: "m1",
        name: "read_file",
        input: { path: "a" },
        ts: T,
      } as RunEvent,
      {
        type: "tool_call",
        agentId: "worker-1",
        callId: "k1",
        name: "read_file",
        input: { path: "b" },
        ts: T,
      } as RunEvent,
    ];
    const flow = build(events, "ollama");
    const disk = flow.nodes.find((n) => n.id === "os-disk")!;
    const by = disk.data.by as { tag: string; name: string; agentId: string }[];
    expect(by.map((u) => u.tag)).toEqual(["main", "w1"]);
    expect(by[1].agentId).toBe("worker-1");
    expect(by[1].name).toBe("task worker-1"); // demoted, but NAMED
    expect(disk.data.byTag).toBe("main"); // the occupant whose content is shown
  });

  it("the shared LLM animates and streams per agent when a child thinks", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      {
        type: "run_start",
        runId: "rc",
        agentId: "worker-1",
        parentId: "main",
        prompt: "task",
        ts: T,
      } as RunEvent,
      { type: "thinking_delta", agentId: "worker-1", text: "child reasoning", ts: T } as RunEvent,
    ];
    const flow = build(events, "ollama");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    expect(llm.data.active).toBe(true); // busy through the CHILD
    const think = llm.data.think as { agent: string; text: string }[];
    expect(think.some((s) => s.agent === "worker-1" && s.text.includes("child reasoning"))).toBe(true);
  });
});

describe("sceneToFlow — the edu-upstreamed flags (card 42)", () => {
  const T = 1;
  const start: RunEvent = {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "go",
    provider: "ollama",
    ts: T,
  };

  it("defaults exactly like before: all zones, boundary rule, ext services", () => {
    const scene = [start].reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail([start]), {
      provider: "anthropic",
      model: "m",
    });
    const nodeIds = flow.nodes.map((n) => n.id);
    expect(nodeIds).toContain("z-mac");
    expect(nodeIds).toContain("z-outside");
    expect(nodeIds).toContain("z-boundary");
    expect(nodeIds).toContain("netz");
    expect(nodeIds).toContain("mcpserver");
  });

  it("declutter keeps only the OS band frame and drops the outside world", () => {
    // The edu lessons' tighter camera — flag-gated, never the default.
    const scene = [start].reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail([start]), {
      provider: "ollama",
      model: "m",
      declutter: true,
    });
    const nodeIds = flow.nodes.map((n) => n.id);
    expect(nodeIds).toContain("z-os");
    expect(nodeIds).not.toContain("z-mac");
    expect(nodeIds).not.toContain("z-boundary");
    expect(nodeIds).not.toContain("netz");
    expect(nodeIds).not.toContain("mcpserver");
  });

  it("subSlots reserves fixed worker slots so early cards never slide", () => {
    const spawnOne: RunEvent[] = [
      start,
      { type: "agent_spawn", agentId: "worker-1", task: "t", ts: T } as RunEvent,
    ];
    const scene1 = spawnOne.reduce(advanceScene, initialScene());
    const one = sceneToFlow(scene1, deriveDetail(spawnOne), {
      provider: "ollama",
      model: "m",
      subSlots: 3,
    });
    const spawnTwo: RunEvent[] = [
      ...spawnOne,
      { type: "agent_spawn", agentId: "worker-2", task: "t", ts: T } as RunEvent,
    ];
    const scene2 = spawnTwo.reduce(advanceScene, initialScene());
    const two = sceneToFlow(scene2, deriveDetail(spawnTwo), {
      provider: "ollama",
      model: "m",
      subSlots: 3,
    });
    const yOf = (flow: { nodes: { id: string; position: { y: number } }[] }, id: string) =>
      flow.nodes.find((n) => n.id === id)!.position.y;
    expect(yOf(one, "sub-worker-1")).toBe(yOf(two, "sub-worker-1")); // slot pinned
  });
});

describe("sceneToFlow — the expanded seats (owner report: expanded is broken)", () => {
  const T = 1;
  // A run with three workers and a tool call in flight: every card type is on
  // the map at once, each with the panels an expanded shell opens.
  const busy = (provider: string): RunEvent[] => [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider, ts: T },
    { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "t1", ts: T } as RunEvent,
    { type: "agent_spawn", agentId: "worker-2", parentId: "main", task: "t2", ts: T } as RunEvent,
    { type: "agent_spawn", agentId: "worker-3", parentId: "main", task: "t3", ts: T } as RunEvent,
    {
      type: "tool_call",
      agentId: "main",
      callId: "c1",
      name: "run_command",
      input: { command: "echo one\necho two" },
      ts: T,
    } as RunEvent,
  ];
  const flowOf = (provider: string, expanded: boolean) => {
    const events = busy(provider);
    const scene = events.reduce(advanceScene, initialScene());
    return sceneToFlow(scene, deriveDetail(events), {
      provider,
      model: "m",
      expanded,
    });
  };
  interface Box {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  /**
   * Heights measured in the browser off the flow pane, session
   * 20260717-151355-0cfef768 (main plus three workers, every panel open).
   *
   * These numbers exist so the overlap check does not read the same table the
   * layout reads. A seat derived from EXPANDED_CARD and then checked against
   * EXPANDED_CARD only proves the table is self-consistent; the collision this
   * test is here to catch happens between the seat and the DOM, so the two
   * sides of the comparison have to come from different places. The three
   * workers differ because their orders differ — the tallest is the bound the
   * column has to be pitched for.
   *
   * Widths stay on the envelope: they are set outright by flowmap.css
   * (.pf-user--wide 400 · .pf-agent--wide 680 · .pf-sub 216) and content
   * cannot move them, which the measured 216-wide collisions confirmed.
   */
  const MEASURED_H: Record<string, number> = {
    user: 166,
    agent: 730,
    llm: 514,
    "os-shell": 201,
    "os-net": 92,
    "sub-worker-1": 394,
    "sub-worker-2": 377,
    "sub-worker-3": 377,
  };
  const envelopeOf = (id: string, type?: string) => EXPANDED_CARD[id] ?? EXPANDED_CARD[type ?? ""];
  /** Every card at the size the layout SEATS it for. */
  const cards = (flow: { nodes: { id: string; type?: string; position: { x: number; y: number } }[] }) =>
    flow.nodes
      .map((n) => {
        const env = envelopeOf(n.id, n.type);
        return env === undefined ? null : { id: n.id, ...n.position, ...env };
      })
      .filter((b): b is Box => b !== null);
  /** Every card at the size it RENDERED at, where that was measured. */
  const rendered = (flow: { nodes: { id: string; type?: string; position: { x: number; y: number } }[] }) =>
    cards(flow).map((b) => ({ ...b, h: MEASURED_H[b.id] ?? b.h }));
  const zone = (
    flow: { nodes: { id: string; position: { x: number; y: number }; style?: unknown }[] },
    id: string,
  ) => {
    const n = flow.nodes.find((z) => z.id === id)!;
    const s = n.style as { width: number; height: number };
    return { x: n.position.x, y: n.position.y, w: s.width, h: s.height };
  };
  const overlaps = (a: Box, b: Box) =>
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;

  for (const provider of ["anthropic", "ollama"]) {
    it(`expanded (${provider}): no two RENDERED cards overlap`, () => {
      const boxes = rendered(flowOf(provider, true));
      const hits: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (!overlaps(a, b)) continue;
          const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          hits.push(`${a.id}/${b.id} ${w}x${h}`);
        }
      }
      expect(hits).toEqual([]);
    });

    it(`expanded (${provider}): every open card stays inside a frame`, () => {
      const flow = flowOf(provider, true);
      const mac = zone(flow, "z-mac");
      const outside = zone(flow, "z-outside");
      const inside = (b: Box, z: { x: number; y: number; w: number; h: number }) =>
        b.x >= z.x && b.y >= z.y && b.x + b.w <= z.x + z.w && b.y + b.h <= z.y + z.h;
      const escaped = cards(flow)
        .filter((b) => !inside(b, mac) && !inside(b, outside))
        .map((b) => b.id);
      expect(escaped).toEqual([]);
    });
  }

  it("no card renders taller than the envelope its seat was derived from", () => {
    // The seats are only as good as this table, and nothing else in the suite
    // compares it against a real card. Every height recorded off the DOM belongs
    // here: an entry that exceeds its envelope means the seat below it is short
    // by that much, which is the collision, found before it reaches a screen.
    const over = Object.entries(MEASURED_H)
      .map(([id, h]) => {
        const type = id.startsWith("sub-") ? "subagent" : undefined;
        return { id, h, bound: envelopeOf(id, type).h };
      })
      .filter((c) => c.h > c.bound)
      .map((c) => `${c.id} ${c.h} > ${c.bound}`);
    expect(over).toEqual([]);
  });

  it("expanded: the worker column is pitched by the subagent envelope, not by a constant", () => {
    const flow = flowOf("anthropic", true);
    const subs = flow.nodes
      .filter((n) => n.id.startsWith("sub-"))
      .sort((a, b) => a.position.y - b.position.y);
    expect(subs).toHaveLength(3);
    const pitch = subs[1].position.y - subs[0].position.y;
    expect(pitch).toBe(subs[2].position.y - subs[1].position.y);
    // The one derivation that matters: pitch follows the card's own envelope the
    // way every other expanded seat follows the envelope beside it.
    expect(pitch).toBe(EXPANDED_CARD.subagent.h + EXP_GAP);
  });

  it("expanded: the seats the layout emits are collision-free by its own reckoning", () => {
    for (const provider of ["anthropic", "ollama"]) {
      expect(seatCollisions(flowOf(provider, true).nodes)).toEqual([]);
    }
  });

  it("seatCollisions can fail: two cards on one seat are reported with their overlap", () => {
    const nodes = [
      { id: "sub-a", type: "subagent", position: { x: 100, y: 100 } },
      { id: "sub-b", type: "subagent", position: { x: 100, y: 120 } },
    ];
    expect(seatCollisions(nodes)).toEqual([
      `sub-a/sub-b ${EXPANDED_CARD.subagent.w}x${EXPANDED_CARD.subagent.h - 20}`,
    ]);
  });

  it("a card measured taller than its envelope is reported, once, and names both numbers", () => {
    const said: string[] = [];
    const measured = [
      { id: "sub-worker-1", type: "subagent", h: EXPANDED_CARD.subagent.h + 12 },
      { id: "agent", h: EXPANDED_CARD.agent.h },
    ];
    reportOversizeCards(measured, (m) => said.push(m));
    reportOversizeCards(measured, (m) => said.push(m));
    expect(said).toHaveLength(1); // a per-frame layout may not shout per frame
    expect(said[0]).toContain("sub-worker-1");
    expect(said[0]).toContain(String(EXPANDED_CARD.subagent.h + 12));
    expect(said[0]).toContain(String(EXPANDED_CARD.subagent.h));
  });

  it("expanded: the agent seat clears the wide user card, so the prompt rail reads left to right", () => {
    const flow = flowOf("anthropic", true);
    const user = cards(flow).find((b) => b.id === "user")!;
    const agent = cards(flow).find((b) => b.id === "agent")!;
    expect(agent.x).toBeGreaterThan(user.x + user.w);
  });

  it("expanded: the OS band sits below the tall agent card", () => {
    const flow = flowOf("anthropic", true);
    const agent = cards(flow).find((b) => b.id === "agent")!;
    const band = zone(flow, "z-os");
    expect(band.y).toBeGreaterThanOrEqual(agent.y + agent.h);
    for (const station of cards(flow).filter((b) => b.id.startsWith("os-"))) {
      expect(station.y).toBeGreaterThanOrEqual(agent.y + agent.h);
    }
  });

  it("expanded: the outside stations sit below the tall LLM card", () => {
    const flow = flowOf("anthropic", true);
    const llm = cards(flow).find((b) => b.id === "llm")!;
    for (const id of ["netz", "mcpserver"]) {
      expect(cards(flow).find((b) => b.id === id)!.y).toBeGreaterThanOrEqual(llm.y + llm.h);
    }
  });

  it("compact: the whole seating, to the pixel, for either backend", () => {
    // The compact map in one place, so any drift anywhere in it lands here.
    // Card 304 rewrote the right-hand half of these numbers: the LLM moved out
    // of the machine into the outside frame, both external stations re-centred
    // under it, the boundary is drawn again, and the mac zone kept the WIDE
    // 1340 the workers live in (its base was 1000 on the old remote variant).
    // Everything right of the wall is derived from the card widths — the LLM
    // and station rows are centred in a frame sized for the wider of the two.
    for (const provider of ["anthropic", "ollama"]) {
      const flow = flowOf(provider, false);
      const at = (id: string) => flow.nodes.find((n) => n.id === id)!.position;
      expect(at("user"), provider).toEqual({ x: 40, y: 380 });
      expect(at("agent"), provider).toEqual({ x: 250, y: 150 });
      expect(at("llm"), provider).toEqual({ x: 1432, y: 240 });
      expect(at("netz"), provider).toEqual({ x: 1477, y: 660 });
      expect(at("mcpserver"), provider).toEqual({ x: 1677, y: 660 });
      expect(at("os-disk"), provider).toEqual({ x: 58, y: 748 });
      expect(at("os-shell"), provider).toEqual({ x: 236, y: 748 });
      expect(at("os-mcp"), provider).toEqual({ x: 462, y: 748 });
      expect(at("os-net"), provider).toEqual({ x: 678, y: 748 });
      expect(zone(flow, "z-mac"), provider).toEqual({ x: 0, y: 24, w: 1340, h: 900 });
      expect(zone(flow, "z-os"), provider).toEqual({ x: 24, y: 668, w: 792, h: 236 });
      expect(zone(flow, "z-outside"), provider).toEqual({ x: 1392, y: 24, w: 520, h: 900 });
      expect(at("z-boundary"), provider).toEqual({ x: 1356, y: 24 });
      expect(at("sub-worker-1").x, provider).toBe(610);
    }
  });

  // ---- the worker grid (card 287): eight in parallel is the acceptance floor
  const busyEight = (provider: string): RunEvent[] => [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider, ts: T },
    ...Array.from(
      { length: 8 },
      (_, i) =>
        ({
          type: "agent_spawn",
          agentId: `worker-${i + 1}`,
          parentId: "main",
          task: `t${i + 1}`,
          ts: T,
        }) as RunEvent,
    ),
  ];
  const flowOfEight = (provider: string) => {
    const events = busyEight(provider);
    const scene = events.reduce(advanceScene, initialScene());
    return sceneToFlow(scene, deriveDetail(events), {
      provider,
      model: "m",
      expanded: true,
    });
  };

  it("expanded: eight workers seat as a 4x2 grid with no seat collisions", () => {
    const flow = flowOfEight("anthropic");
    const subs = flow.nodes.filter((n) => n.type === "subagent");
    expect(subs).toHaveLength(8);
    expect(new Set(subs.map((n) => n.position.x)).size).toBe(2);
    expect(new Set(subs.map((n) => n.position.y)).size).toBe(4);
    expect(seatCollisions(flow.nodes as never)).toEqual([]);
  });

  it("expanded: the mac frame contains the whole grid, and the right world clears it", () => {
    const flow = flowOfEight("anthropic");
    const mac = zone(flow, "z-mac");
    const subs = flow.nodes.filter((n) => n.type === "subagent");
    const rightmost = Math.max(...subs.map((n) => n.position.x)) + EXPANDED_CARD.subagent.w;
    expect(rightmost).toBeLessThanOrEqual(mac.x + mac.w);
    const boundary = flow.nodes.find((n) => n.id === "z-boundary")!;
    expect(boundary.position.x).toBeGreaterThanOrEqual(rightmost);
  });

  it("expanded: the widened stations sit inside the band, and the band inside the mac frame", () => {
    const flow = flowOfEight("anthropic");
    const band = zone(flow, "z-os");
    const mac = zone(flow, "z-mac");
    for (const id of ["os-disk", "os-shell", "os-mcp", "os-net"]) {
      const n = flow.nodes.find((x) => x.id === id)!;
      const env = EXPANDED_CARD[id];
      expect(n.position.x).toBeGreaterThanOrEqual(band.x);
      expect(n.position.x + env.w).toBeLessThanOrEqual(band.x + band.w);
      expect(n.position.y + env.h).toBeLessThanOrEqual(band.y + band.h);
    }
    expect(band.x + band.w).toBeLessThanOrEqual(mac.x + mac.w);
    // and the worker column stands clear of the band's right edge
    const firstSub = flow.nodes.filter((n) => n.type === "subagent")[0];
    expect(firstSub.position.x).toBeGreaterThanOrEqual(band.x + band.w);
  });

  it("expanded: a run past the ceiling draws the ceiling, not the fleet", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts: T },
      ...Array.from(
        { length: 14 },
        (_, i) =>
          ({
            type: "agent_spawn",
            agentId: `w${i + 1}`,
            parentId: "main",
            task: `t${i + 1}`,
            ts: T,
          }) as RunEvent,
      ),
    ];
    const scene = events.reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail(events), {
      provider: "anthropic",
      model: "m",
      expanded: true,
    });
    expect(flow.nodes.filter((n) => n.type === "subagent")).toHaveLength(12);
  });
});

// Card 292, C1: the map draws the POOL's seating, not the lifetime index. A
// run whose children came and went shows the peak concurrency, and a later
// child sits down on a freed seat — in the exact position the ended child had.
describe("sceneToFlow — the seat pool on the map (card 292)", () => {
  const T = 1;
  const start: RunEvent = {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "go",
    provider: "anthropic",
    ts: T,
  };
  const spawnE = (id: string): RunEvent =>
    ({ type: "agent_spawn", agentId: id, parentId: "main", task: `t-${id}`, ts: T }) as RunEvent;
  const resultE = (id: string): RunEvent =>
    ({
      type: "agent_message",
      from: id,
      to: "main",
      role: "result",
      state: "completed",
      text: "",
      ts: T,
    }) as RunEvent;
  const flowOf = (events: RunEvent[], expanded: boolean) => {
    const scene = events.reduce(advanceScene, initialScene());
    return sceneToFlow(scene, deriveDetail(events), {
      provider: "anthropic",
      model: "m",
      expanded,
      pool: foldSeatPool(events),
    });
  };

  it("a later child reuses a freed seat — same position, and the ended child yields it", () => {
    const before = flowOf([start, spawnE("a"), spawnE("b")], true);
    const after = flowOf([start, spawnE("a"), spawnE("b"), resultE("a"), spawnE("c")], true);
    const at = (flow: { nodes: { id: string; position: { x: number; y: number } }[] }, id: string) =>
      flow.nodes.find((n) => n.id === id)?.position;
    // c sits exactly where a sat; a's card yielded the seat.
    expect(at(after, "sub-c")).toEqual(at(before, "sub-a"));
    expect(at(after, "sub-a")).toBeUndefined();
    // b never ended: its seat is untouched by the churn around it.
    expect(at(after, "sub-b")).toEqual(at(before, "sub-b"));
  });

  it("and its rails keep their lane through that churn, like its card keeps its seat", () => {
    const before = flowOf([start, spawnE("a"), spawnE("b")], true);
    const after = flowOf([start, spawnE("a"), spawnE("b"), resultE("a"), spawnE("c")], true);
    const laneOf = (flow: { edges: { id: string; data?: unknown }[] }, id: string) =>
      (flow.edges.find((e) => e.id === id)?.data as { lane: number | null } | undefined)?.lane;
    // b's rail into the disk is drawn from b's SEAT, not from its place in the
    // list of drawn children — a's departure shortens that list by one.
    expect(laneOf(after, "e-sub-b-osdisk")).toBe(laneOf(before, "e-sub-b-osdisk"));
    // and c, taking a's seat, takes the lane that went with it.
    expect(laneOf(after, "e-sub-c-osdisk")).toBe(laneOf(before, "e-sub-a-osdisk"));
  });

  it("nine sequential children draw the peak, not the lifetime — the grid stays small", () => {
    const events: RunEvent[] = [start];
    for (let i = 0; i < 9; i++) {
      events.push(spawnE(`w${i}`));
      if (i >= 2) events.push(resultE(`w${i - 2}`));
    }
    const flow = flowOf(events, true);
    const subs = flow.nodes.filter((n) => n.type === "subagent");
    // Peak concurrency 3 → three seats on the map, not nine.
    expect(subs).toHaveLength(3);
    expect(new Set(subs.map((n) => `${n.position.x}/${n.position.y}`)).size).toBe(3);
  });

  it("without a pool the legacy lifetime seating is untouched (edu / sim path)", () => {
    const events = [start, spawnE("a"), spawnE("b"), resultE("a"), spawnE("c")];
    const scene = events.reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail(events), {
      provider: "anthropic",
      model: "m",
      expanded: true,
    });
    // all three drawn, lifetime order — today's behaviour, byte for byte.
    expect(flow.nodes.filter((n) => n.type === "subagent")).toHaveLength(3);
  });
});

// Card 292, C2: the cliff. Measured before the fix (pane 1600x900, no
// padding): N=1..2 card 253 device px, N=3 → 192 (−24.1%), N=4 → 145
// (−24.5%) and FLAT to N=12 — the world saturated at 2530 tall while the
// pane stayed 900, and every card painted its 11px meta line at ~2 device
// px. Rows now derive from seat count and pane aspect, so the fitted card
// shrinks gently: the measured worst adjacent drop after the fix is 15.4%
// (N=2→3) and the floor at N=12 is 164 px. Thresholds pinned just under
// those measurements: no adjacent drop past 16%, never below 160 px.
describe("sceneToFlow — the fitted card never falls off a cliff (card 292)", () => {
  const T = 1;
  const start: RunEvent = {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "go",
    provider: "anthropic",
    ts: T,
  };
  const spawnN = (n: number): RunEvent[] => [
    start,
    ...Array.from(
      { length: n },
      (_, i) => ({ type: "agent_spawn", agentId: `w${i}`, parentId: "main", task: "t", ts: T }) as RunEvent,
    ),
  ];
  const envelopeOf = (id: string, type?: string) => EXPANDED_CARD[id] ?? EXPANDED_CARD[type ?? ""];
  const worldOf = (
    nodes: { id: string; type?: string; position: { x: number; y: number }; style?: unknown }[],
  ) => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const n of nodes) {
      const s = n.style as { width?: number; height?: number } | undefined;
      const env = envelopeOf(n.id, n.type);
      const w = s?.width ?? env?.w ?? 150;
      const h = s?.height ?? env?.h ?? 110;
      x0 = Math.min(x0, n.position.x);
      y0 = Math.min(y0, n.position.y);
      x1 = Math.max(x1, n.position.x + w);
      y1 = Math.max(y1, n.position.y + h);
    }
    return { w: x1 - x0, h: y1 - y0 };
  };
  const PANE = { w: 1600, h: 900 };
  /** The worker card's device-pixel width once the map is fitted to the pane. */
  const cardPx = (n: number): number => {
    const events = spawnN(n);
    const scene = events.reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail(events), {
      provider: "anthropic",
      model: "m",
      expanded: true,
      pool: foldSeatPool(events),
      paneAspect: PANE.w / PANE.h,
    });
    const world = worldOf(flow.nodes as never);
    const fit = Math.min(PANE.w / world.w, PANE.h / world.h);
    return EXPANDED_CARD.subagent.w * fit;
  };

  // Card 296 re-measured this on the corrected seat. The 16% / 160px pair was
  // a true reading of the 620-pitch world and is now slack: on the same pane
  // the fitted card runs 253.2, 253.2, 219.9, 214.3, 214.3, 214.3, 185.8,
  // 185.8, 185.8, 166.2, 166.2, 166.2 device px — worst adjacent drop 13.3%
  // (n=6→7), floor 166.2 at n=10..12. A test whose premise moved is replaced,
  // not loosened: the thresholds below sit just under the NEW measurement and
  // go red on the old geometry (which dropped 15.4% at n=2→3 and floored at
  // 163.9), so this can never be re-satisfied by putting 560 back.
  it("adjacent seat counts 1..12 never drop the card past 14%, and never under 165 px", () => {
    const sizes = Array.from({ length: 12 }, (_, i) => cardPx(i + 1));
    for (let i = 1; i < sizes.length; i++) {
      expect(
        sizes[i],
        `n=${i + 1} vs n=${i}: ${sizes.map((s) => s.toFixed(1)).join(", ")}`,
      ).toBeGreaterThanOrEqual(sizes[i - 1] * 0.86);
      expect(sizes[i], `n=${i + 1}: ${sizes.map((s) => s.toFixed(1)).join(", ")}`).toBeGreaterThanOrEqual(
        165,
      );
    }
  });

  // The owner's actual complaint, as a number the gate can hold: the row the
  // seat reserves must not be twice the card that usually stands in it. At
  // 560 + 60 it was — 620 against a card measured at 304.44 in the browser —
  // and that is what "more gap than card" meant on his screen.
  it("a row reserves less than twice the card it usually holds", () => {
    expect(SUB_ROW_PITCH).toBeLessThan(2 * SUB_CARD_TYPICAL_H);
  });

  it("expanded seats stay collision-free at every count the rows derivation can pick", () => {
    for (let n = 1; n <= 12; n++) {
      const events = spawnN(n);
      const scene = events.reduce(advanceScene, initialScene());
      const flow = sceneToFlow(scene, deriveDetail(events), {
        provider: "anthropic",
        model: "m",
        expanded: true,
        pool: foldSeatPool(events),
        paneAspect: PANE.w / PANE.h,
      });
      expect(seatCollisions(flow.nodes as never), `n=${n}`).toEqual([]);
    }
  });
});

describe("deriveDetail — the generated image (real blob, card 42 follow-up)", () => {
  it("folds the LAST image_generated per agent, with file name and prompt", () => {
    const events: RunEvent[] = [
      {
        type: "image_generated",
        agentId: "main",
        callId: "c1",
        prompt: "a beach cat",
        provider: "gemini",
        model: "m",
        mediaType: "image/png",
        blobPath: "/home/user/.spectro/images/img-1.png",
        sha256: "x",
        ts: 1,
      } as RunEvent,
      {
        type: "image_generated",
        agentId: "main",
        callId: "c2",
        prompt: "a mountain dog",
        provider: "gemini",
        model: "m",
        mediaType: "image/png",
        blobPath: "/home/user/.spectro/images/img-2.png",
        sha256: "y",
        ts: 2,
      } as RunEvent,
    ];
    const d = deriveDetail(events);
    expect(d.genImage["main"]).toEqual({ src: "/api/images/img-2.png", prompt: "a mountain dog" });
  });

  it("is empty when no image was generated", () => {
    expect(deriveDetail([]).genImage).toEqual({});
  });
});

// Card 179. The lab's expanded view was the "mega bomben feature" and it never
// went away — it was only ever fed by image_generated, which no import emits.
describe("pictures handed to an agent", () => {
  const shot = (agentId: string, note: string) =>
    ({
      type: "attachment_image",
      agentId,
      mediaType: "image/png",
      dataBase64: "AAA",
      note,
      ts: 1,
    }) as unknown as RunEvent;

  it("rides as a data URI, so a store that never held the file still shows it", () => {
    const d = deriveDetail([shot("main", "[image/png · 31.0 KB]")]);
    expect(d.attached["main"]).toEqual([{ src: "data:image/png;base64,AAA", note: "[image/png · 31.0 KB]" }]);
  });

  it("keeps all of them in order — the owner's own file opens with four", () => {
    const d = deriveDetail([
      shot("main", "one"),
      shot("main", "two"),
      shot("main", "three"),
      shot("main", "four"),
    ]);
    expect(d.attached["main"]?.map((s) => s.note)).toEqual(["one", "two", "three", "four"]);
  });

  it("bounds one card, because a card is drawn into a reserved seat", () => {
    const many = Array.from({ length: MAX_CARD_SHOTS + 4 }, (_, i) => shot("main", `s${i}`));
    expect(deriveDetail(many).attached["main"]).toHaveLength(MAX_CARD_SHOTS);
  });

  it("does not put one agent's pictures on another's card", () => {
    const d = deriveDetail([shot("main", "a"), shot("sub-1", "b")]);
    expect(d.attached["main"]?.length).toBe(1);
    expect(d.attached["sub-1"]?.length).toBe(1);
  });

  it("leaves the generated slot alone — different provenance, different label", () => {
    expect(deriveDetail([shot("main", "a")]).genImage["main"]).toBeUndefined();
  });
});

// Card 179, adversarial pass. The map read the literal "main" for the agent
// card's prompt, reasoning, answer, in-flight tool AND pictures — but a
// standalone subagent transcript roots at its OWN id, and 66% of the corpus's
// pictures live in those files. On two thirds of them the card asked for an
// agent that was not in the stream.
describe("a stream that is not rooted at main", () => {
  const T0 = 1700000000000;
  const events = [
    { type: "run_start", runId: "r", agentId: "a9075ad4", prompt: "read this shot", ts: T0 },
    {
      type: "attachment_image",
      agentId: "a9075ad4",
      mediaType: "image/png",
      dataBase64: "AAA",
      note: "[image/png · 1 KB]",
      ts: T0,
    },
  ] as unknown as RunEvent[];

  it("names its root off the first run_start", () => {
    expect(deriveDetail(events).root).toBe("a9075ad4");
  });

  it("still says main for an ordinary session file", () => {
    expect(
      deriveDetail([
        { type: "run_start", runId: "r", agentId: "main", prompt: "hi", ts: T0 },
      ] as unknown as RunEvent[]).root,
    ).toBe("main");
  });

  it("gives the root's prompt to the card rather than an empty string", () => {
    expect(deriveDetail(events).prompt).toBe("read this shot");
  });

  it("puts the root's pictures where the card looks for them", () => {
    const d = deriveDetail(events);
    expect(d.attached[d.root]).toHaveLength(1);
  });
});

describe("the agent hub stops claiming a named tool is planning (card 146)", () => {
  // The map has a station for six tools. Everything else — Workflow, Monitor,
  // TaskCreate, any MCP tool without a server prefix — fell to the agent hub,
  // and the hub's status line said "plans the next step" while that tool was in
  // flight. Measured over ~/.claude/projects on 2026-08-10: 97 Workflow calls
  // across 19 transcripts, each of them drawn as an agent thinking.
  it("names the tool instead of claiming the agent is between steps", () => {
    const said = activity("agent", "idle", null, null, null, "none", "en", "Workflow");
    expect(said.text).toBe("Workflow");
  });

  it("still says it plans when nothing is actually running", () => {
    const said = activity("agent", "idle", null, null, null, "none", "en", null);
    expect(said.text).toBe(t("en", "map.act.plans"));
  });

  it("truncates a long tool name rather than letting it push the card open", () => {
    const long = "mcp__some__extremely__long__tool__name__that__never__ends";
    expect(activity("agent", "idle", null, null, null, "none", "en", long).text.length).toBeLessThanOrEqual(
      26,
    );
  });
});

// ---------------------------------------------------------------------------
// Card 298: the OS stations name their occupant by its handle, not by its
// position in the live scene array. The fixture is a standalone subagent
// transcript, because that is where the two answers differ: it roots at its
// OWN id with no parentId (claudeCode.ts), labScene reads the literal "main"
// and so files that root under scene.subagents, and the index then numbered
// the transcript's own root as a worker.
// ---------------------------------------------------------------------------
describe("the OS stations take their occupant's tag from the directory", () => {
  const STATIONS = [
    { node: "os-disk", tool: "Read", input: { file_path: "a.txt" } },
    { node: "os-shell", tool: "Bash", input: { command: "ls" } },
    { node: "os-mcp", tool: "mcp__notes__search_notes", input: {} },
  ];

  for (const station of STATIONS) {
    const events: RunEvent[] = [
      { type: "run_start", runId: "cc-import", agentId: "sub-7", prompt: "hi", ts: T },
      {
        type: "tool_call",
        agentId: "sub-7",
        callId: "c1",
        name: station.tool,
        input: station.input,
        ts: T + 1,
      },
    ];
    const scene = events.reduce(advanceScene, initialScene());
    const detail = deriveDetail(events);
    const byOf = (dir?: ReturnType<typeof agentDirectory>) =>
      sceneToFlow(scene, detail, { provider: "p", model: "m", dir }).nodes.find((n) => n.id === station.node)
        ?.data.by;

    // The `agentId` rides along since card 295 merged: the station line is the
    // ONE occupancy derivation, and the rail keying addresses its occupant by
    // id. The tag/name — what card 298 is about — are unchanged by that.
    it(`${station.node}: hands the directory through to the station line`, () => {
      expect(byOf(agentDirectory(events))).toEqual([{ tag: "main", name: "main", agentId: "sub-7" }]);
    });

    it(`${station.node}: still draws the station with no directory at all`, () => {
      expect(byOf()).toEqual([{ tag: "w1", name: "w1", agentId: "sub-7" }]);
    });
  }
});

// ---------------------------------------------------------------------------
// Card 304 — ONE geometry. This block replaces a branch: the layout used to
// come in two variants picked by the provider, so the map drew a different
// machine depending on who served the tokens — the LLM inside "your mac" for
// ollama, outside it for everyone else, and no network boundary at all in the
// local one. The internal LLM now hangs behind the agents and ollama itself
// serves cloud models, so "local" stopped stating a fact worth drawing. The
// four pins below are what holds the single geometry that replaced it.
// ---------------------------------------------------------------------------
describe("sceneToFlow — one geometry, whoever serves the tokens", () => {
  const T = 1;
  /** The owner's number (card 304). It lives here as a literal ON PURPOSE: the
   *  point of the pin is that a future edit which narrows the mac zone fails
   *  loudly, and a test that reads the width out of the layout it checks would
   *  simply follow it down. The workers live in this width — card 287 gave them
   *  a grid up to twelve seats, card 296 tied the seating to the room. */
  const MAC_ZONE_W = 1340;

  const run = (provider: string, workers: number): RunEvent[] => [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider, ts: T } as RunEvent,
    ...Array.from(
      { length: workers },
      (_, i) =>
        ({ type: "agent_spawn", agentId: `w${i + 1}`, parentId: "main", task: `t${i}`, ts: T }) as RunEvent,
    ),
  ];
  const flowFor = (provider: string, workers = 0, expanded = false) => {
    const events = run(provider, workers);
    const scene = events.reduce(advanceScene, initialScene());
    return sceneToFlow(scene, deriveDetail(events), { provider, model: "m", expanded });
  };
  const box = (
    flow: { nodes: { id: string; type?: string; position: { x: number; y: number }; style?: unknown }[] },
    id: string,
  ) => {
    const n = flow.nodes.find((x) => x.id === id);
    if (n === undefined) return null;
    const s = n.style as { width?: number; height?: number } | undefined;
    // A zone carries its size in `style`; a card carries it in the envelope its
    // seat was derived from — by id where it has its own entry, by node type
    // for the two external stations, which share one.
    const env = EXPANDED_CARD[id] ?? EXPANDED_CARD[n.type ?? ""];
    return { x: n.position.x, y: n.position.y, w: s?.width ?? env.w, h: s?.height ?? env.h };
  };
  /** Everything about the map that the provider used to be able to move. */
  const geometry = (flow: {
    nodes: { id: string; type?: string; position: { x: number; y: number }; style?: unknown }[];
  }) => ({
    zones: flow.nodes
      .filter((n) => n.type === "zone")
      .map((n) => ({ id: n.id, ...box(flow, n.id)! }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    llm: box(flow, "llm"),
    netz: box(flow, "netz"),
    mcpserver: box(flow, "mcpserver"),
    subBase: flow.nodes.find((n) => n.id === "sub-w1")!.position,
  });

  it("an ollama run and an anthropic run draw the SAME map", () => {
    for (const expanded of [false, true]) {
      expect(geometry(flowFor("ollama", 3, expanded))).toEqual(geometry(flowFor("anthropic", 3, expanded)));
    }
  });

  it("the mac zone keeps its full width — the workers live in it", () => {
    for (const provider of ["ollama", "anthropic"]) {
      expect(box(flowFor(provider), "z-mac")!.w).toBe(MAC_ZONE_W);
    }
  });

  it("the LLM box lies inside the outside frame, clear of Netz and MCP-Server", () => {
    // Widest and narrowest content the map can be handed: an empty run and a
    // full worker grid, compact and expanded. The spread a deep grid pushes
    // onto the right-hand world is exactly what could shove the LLM out of the
    // frame it is meant to sit in, or down onto the two stations below it.
    //
    // The WIDTH is honest in both modes — flowmap.css sets `.pf-llm` to a flat
    // 440px and content cannot move it — so containment is checked everywhere.
    // The HEIGHT is only a reserve the layout seats against when the shells are
    // expanded; compact draws a short card with no tabulated height, so there
    // the pin is the weaker true thing (the card starts above the stations)
    // rather than a strong false one derived from the wrong number.
    const spans = (a: { x: number; w: number }, b: { x: number; w: number }) =>
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0;
    const escapes: string[] = [];
    for (const provider of ["ollama", "anthropic"]) {
      for (const expanded of [false, true]) {
        for (const workers of [0, 12]) {
          const flow = flowFor(provider, workers, expanded);
          const at = `${provider}/${expanded ? "expanded" : "compact"}/${workers}`;
          const llm = box(flow, "llm")!;
          const outside = box(flow, "z-outside")!;
          const held = (b: { x: number; w: number }) =>
            b.x >= outside.x && b.x + b.w <= outside.x + outside.w;
          const span = (b: { x: number; w: number }) => `${b.x}..${b.x + b.w}`;
          if (!held(llm)) escapes.push(`${at}: llm ${span(llm)} vs frame ${span(outside)}`);
          for (const id of ["netz", "mcpserver"]) {
            const ext = box(flow, id)!;
            if (!held(ext)) escapes.push(`${at}: ${id} ${span(ext)} vs frame ${span(outside)}`);
            if (!spans(llm, ext)) continue;
            const floor = expanded ? llm.y + llm.h : llm.y + 1;
            if (ext.y < floor) escapes.push(`${at}: ${id} at y${ext.y}, above a floor of y${floor}`);
          }
          const netz = box(flow, "netz")!;
          const mcp = box(flow, "mcpserver")!;
          if (spans(netz, mcp)) escapes.push(`${at}: netz ${span(netz)} runs into mcpserver ${span(mcp)}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it("the network boundary is drawn for every provider", () => {
    // The local variant set it to null, so a local backend silently lost the
    // one line on the map that says where your machine stops.
    for (const provider of ["ollama", "anthropic"]) {
      const boundary = box(flowFor(provider), "z-boundary");
      expect(boundary, provider).not.toBeNull();
      const mac = box(flowFor(provider), "z-mac")!;
      const outside = box(flowFor(provider), "z-outside")!;
      expect(boundary!.x).toBeGreaterThanOrEqual(mac.x + mac.w);
      expect(boundary!.x + boundary!.w).toBeLessThanOrEqual(outside.x);
    }
  });
});
