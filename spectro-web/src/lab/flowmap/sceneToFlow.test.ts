import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
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

function build(events: RunEvent[], local: boolean, provider: string, model = "m") {
  const scene = events.reduce(advanceScene, initialScene());
  const detail = deriveDetail(events);
  return sceneToFlow(scene, detail, { local, provider, model });
}

const ids = (flow: { nodes: { id: string }[] }) => flow.nodes.map((n) => n.id);

describe("sceneToFlow", () => {
  it("emits the core agent-system, OS band and external nodes", () => {
    const flow = build([runStart("anthropic")], false, "anthropic");
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

  it("remote: the LLM sits BEYOND the network boundary, which is drawn", () => {
    const flow = build([runStart("anthropic")], false, "anthropic");
    expect(ids(flow)).toContain("z-boundary");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    // remote boundary is at x=1016; the LLM must be to the right of it.
    expect(llm.position.x).toBeGreaterThan(1016);
  });

  it("local: no boundary, and the LLM sits INSIDE 'Dein Mac'", () => {
    const flow = build([runStart("ollama")], true, "ollama");
    expect(ids(flow)).not.toContain("z-boundary");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    // local z-mac is 1100 wide from x=0; the LLM must fall inside it.
    expect(llm.position.x).toBeLessThan(1100);
  });

  it("lays out three subagents with equal, non-clumping vertical spacing inside the band", () => {
    const flow = build(
      [runStart("ollama"), spawn("worker-1"), spawn("worker-2"), spawn("worker-3")],
      true,
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
    const flow = build(
      [runStart("ollama"), spawn("w1"), spawn("w2"), spawn("w3"), spawn("w4")],
      true,
      "ollama",
    );
    const subs = flow.nodes.filter((n) => n.id.startsWith("sub-"));
    expect(subs).toHaveLength(4);
    // three rows deep, so the fourth opens column two at the first row's y
    expect(subs[3].position.x).toBeGreaterThan(subs[0].position.x);
    expect(subs[3].position.y).toBe(subs[0].position.y);
  });

  it("clamps compact at six cards — past the ceiling the chip confesses, the map stays readable", () => {
    const spawns = Array.from({ length: 8 }, (_, i) => spawn(`w${i + 1}`));
    const flow = build([runStart("ollama"), ...spawns], true, "ollama");
    expect(flow.nodes.filter((n) => n.id.startsWith("sub-"))).toHaveLength(6);
  });

  it("compact second column pushes the in-machine LLM clear instead of overlapping it", () => {
    const spawns = Array.from({ length: 4 }, (_, i) => spawn(`w${i + 1}`));
    const flow = build([runStart("ollama"), ...spawns], true, "ollama");
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
    const flow = build(events, true, "ollama");
    const disk = flow.nodes.find((n) => n.id === "os-disk")!;
    expect(disk.data.active).toBe(true); // a CHILD is writing, not main
    expect(disk.data.file).toBe("plan.md");
    // the child's own rail to the shared station exists and is lit
    const rail = flow.edges.find((e) => e.id === "e-sub-worker-1-osdisk")!;
    expect(rail).toBeTruthy();
    expect((rail.data as { active: boolean }).active).toBe(true);
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
    const flow = build(events, true, "ollama");
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
      local: false,
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
      local: true,
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
      local: true,
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
      local: true,
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
      local: provider === "ollama",
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

  it("compact: the hand-authored seats are untouched", () => {
    const flow = flowOf("anthropic", false);
    const at = (id: string) => flow.nodes.find((n) => n.id === id)!.position;
    expect(at("user")).toEqual({ x: 40, y: 380 });
    expect(at("agent")).toEqual({ x: 250, y: 150 });
    expect(at("llm")).toEqual({ x: 1092, y: 240 });
    expect(at("netz")).toEqual({ x: 1090, y: 660 });
    expect(at("mcpserver")).toEqual({ x: 1290, y: 660 });
    expect(at("os-disk")).toEqual({ x: 58, y: 748 });
    expect(at("os-shell")).toEqual({ x: 236, y: 748 });
    expect(at("os-mcp")).toEqual({ x: 462, y: 748 });
    expect(at("os-net")).toEqual({ x: 678, y: 748 });
    expect(zone(flow, "z-mac")).toEqual({ x: 0, y: 24, w: 1000, h: 900 });
    expect(zone(flow, "z-os")).toEqual({ x: 24, y: 668, w: 792, h: 236 });
    expect(zone(flow, "z-outside")).toEqual({ x: 1052, y: 24, w: 520, h: 900 });
    expect(at("z-boundary")).toEqual({ x: 1016, y: 24 });
    expect(at("sub-worker-1").x).toBe(685);
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
      local: provider === "ollama",
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
      local: false,
      provider: "anthropic",
      model: "m",
      expanded: true,
    });
    expect(flow.nodes.filter((n) => n.type === "subagent")).toHaveLength(12);
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
