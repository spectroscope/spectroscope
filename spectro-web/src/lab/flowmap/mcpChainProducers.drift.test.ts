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
