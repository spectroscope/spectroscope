// CARD 328 — the answer reaches BOTH surfaces that draw the MCP chain.
//
// The single-run map (sceneToFlow) and the fleet machine room (fleetToFlow)
// each build their own `os-mcp` and `mcpserver` nodes out of the same fold.
// A card wired into one of them ships half a feature: the owner opens Spectrum,
// sees the same two cards, and one of them is silently a version behind.
//
// So this file drives the SAME events through both producers and holds their
// two node datas against each other. It does not test the derivation — that is
// mcpAnswer.test.tsx — it tests that neither producer grew a second one.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import type { FleetModel, FleetNode } from "../../spectrum/fleetModel";
import { buildFleetLabScene } from "../fleetLabScene";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";
import { fleetToFlow } from "./fleetToFlow";

const T = 1784292223291;
const CALL = "toolu_01UHwCPaAYawCQPw9aaApGAo";
const ANSWER = "three notes matched the gate query.";

const events: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "search", ts: T } as RunEvent,
  {
    type: "tool_call",
    agentId: "main",
    callId: CALL,
    name: "mcp__notes__search_notes",
    input: { query: "gate" },
    ts: T + 1,
  } as RunEvent,
  {
    type: "tool_result",
    agentId: "main",
    callId: CALL,
    output: ANSWER,
    isError: false,
    durationMs: 23,
    ts: T + 24,
  } as RunEvent,
];

const roster: FleetNode[] = [
  { id: "main", role: "root", capabilities: [], topic: "ctx.events", connected: true, lastSeen: T },
];

const dataOf = (flow: { nodes: { id: string; data: unknown }[] }, id: string) =>
  flow.nodes.find((n) => n.id === id)?.data as Record<string, unknown> | undefined;

describe("both producers draw the same MCP exchange (card 328)", () => {
  const detail = deriveDetail(events);
  const single = sceneToFlow(events.reduce(advanceScene, initialScene()), detail, {
    provider: "anthropic",
    model: "claude-opus-5",
  });
  const model: FleetModel = { roster, events, frames: [], epochBySender: {} };
  const fleet = fleetToFlow(buildFleetLabScene(model), detail, { lang: "en" });

  it("the client card asks the same call on both surfaces", () => {
    expect(dataOf(fleet, "os-mcp")?.call).toEqual(dataOf(single, "os-mcp")?.call);
    expect((dataOf(single, "os-mcp")?.call as { callId: string }).callId).toBe(CALL);
  });

  it("the server card answers it on both surfaces", () => {
    expect(dataOf(fleet, "mcpserver")?.answer).toEqual(dataOf(single, "mcpserver")?.answer);
    expect((dataOf(single, "mcpserver")?.answer as { text: string }).text).toBe(ANSWER);
  });

  it("and both name the exchange on the MCP line", () => {
    expect(dataOf(fleet, "os-mcp")?.mcp).toEqual(dataOf(single, "os-mcp")?.mcp);
    expect(dataOf(single, "os-mcp")?.mcp).toBe("notes · search_notes");
  });
});

// ---------------------------------------------------------------------------
// ROUND 2 — the same guard for the other two cards.
//
// This file's own stated reason is that a card wired into ONE producer ships
// half a feature. Cards 329 and 330 changed `fleetToFlow` for exactly the same
// reason and neither left a guard behind: `grep -n fleetToFlow
// src/lab/flowmap/*.test.ts*` found this file and `fleetToFlow.test.ts`, and
// the latter mentions neither `netz` nor `os-browser`.
// ---------------------------------------------------------------------------
describe("both producers draw the same boundary and browser cards (cards 329/330)", () => {
  const reached: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: T } as RunEvent,
    {
      type: "llm_exchange",
      xid: "x-1",
      agentId: "main",
      turn: 1,
      kind: "chat",
      provider: "anthropic",
      model: "claude-opus-5",
      transport: "sdk",
      url: "https://api.anthropic.com/v1/messages",
      requestBytes: 9089,
      responseBytes: 2292,
      responseLines: 24,
      aborted: false,
      fidelity: "sdk-json",
      durationMs: 5030,
      ts: T + 1,
    } as RunEvent,
    {
      type: "browser_action",
      agentId: "main",
      callId: "toolu_013Sdr8vpiqu5sWsu1SwwucK",
      cid: "cc2f8e8e",
      epoch: 1,
      tool: "browser_navigate",
      url: "https://www.test.de/",
      ok: true,
      resultBytes: 237,
      durationMs: 28,
      ts: T + 2,
    } as RunEvent,
  ];
  const detail = deriveDetail(reached);
  const single = sceneToFlow(reached.reduce(advanceScene, initialScene()), detail, {
    provider: "anthropic",
    model: "claude-opus-5",
  });
  const fleet = fleetToFlow(
    buildFleetLabScene({ roster, events: reached, frames: [], epochBySender: {} }),
    detail,
    {
      lang: "en",
    },
  );

  it("the Net card carries the same hosts on both surfaces", () => {
    expect(dataOf(fleet, "netz")?.net).toEqual(dataOf(single, "netz")?.net);
    expect((dataOf(single, "netz")?.net as { hosts: unknown[] }).hosts).toHaveLength(2);
  });

  it("the browser station carries the same recorded page on both surfaces", () => {
    expect(dataOf(fleet, "os-browser")?.page).toEqual(dataOf(single, "os-browser")?.page);
    expect((dataOf(single, "os-browser")?.page as { url: string }).url).toBe("https://www.test.de/");
  });

  it("and a worker on the browser rails to it in the machine room too", () => {
    const busy: RunEvent[] = [
      ...reached,
      {
        type: "tool_call",
        agentId: "main",
        callId: "c-m",
        name: "browser_navigate",
        input: { url: "https://www.test.de/" },
        ts: T + 3,
      } as RunEvent,
    ];
    const room = fleetToFlow(
      buildFleetLabScene({ roster, events: busy, frames: [], epochBySender: {} }),
      deriveDetail(busy),
      {
        lang: "en",
      },
    );
    expect(room.edges.map((e) => e.id)).toContain("e-card-main-osbrowser");
  });
});
