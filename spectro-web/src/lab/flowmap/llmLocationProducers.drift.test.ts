// CARD 333, criterion 6 — the location reaches BOTH surfaces that draw an LLM.
//
// The single-run map (sceneToFlow) and the fleet machine room (fleetToFlow)
// each build their own `llm` node out of the same fold. Card 320's defect at
// the shell station was exactly one producer left behind, and card 327 had to
// say the same thing again about the lanes; this is the third time, so it gets
// a guard rather than a promise.
//
// It does not test the derivation — llmLocation.test.tsx does that — it tests
// that neither producer grew a second answer, or kept the old literal.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import type { FleetModel, FleetNode } from "../../spectrum/fleetModel";
import { buildFleetLabScene } from "../fleetLabScene";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";
import { fleetToFlow } from "./fleetToFlow";

const T = 1787148162959;

const roster: FleetNode[] = [
  { id: "main", role: "root", capabilities: [], topic: "ctx.events", connected: true, lastSeen: T },
];

const exchange = (url: string): RunEvent =>
  ({
    type: "llm_exchange",
    xid: "x1",
    agentId: "main",
    turn: 1,
    kind: "chat",
    provider: "lmstudio",
    model: "a-model",
    transport: "http",
    url,
    status: 200,
    requestBytes: 12,
    responseBytes: 34,
    responseLines: 1,
    aborted: false,
    fidelity: "full",
    durationMs: 9,
    ts: T + 1,
  }) as RunEvent;

const dataOf = (flow: { nodes: { id: string; data: unknown }[] }, id: string) =>
  flow.nodes.find((n) => n.id === id)?.data as Record<string, unknown> | undefined;

/** Both producers over the same events — the only thing that can disagree. */
function bothOn(events: RunEvent[]): { single: unknown; fleet: unknown } {
  const detail = deriveDetail(events);
  const single = sceneToFlow(events.reduce(advanceScene, initialScene()), detail, {
    provider: "lmstudio",
    model: "a-model",
  });
  const model: FleetModel = { roster, events, frames: [], epochBySender: {} };
  const fleet = fleetToFlow(buildFleetLabScene(model), detail, { lang: "en" });
  return { single: dataOf(single, "llm")?.loc, fleet: dataOf(fleet, "llm")?.loc };
}

describe("both producers say where the model is (card 333, criterion 6)", () => {
  const base: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: T } as RunEvent,
  ];

  it("agree that a loopback backend is local", () => {
    const { single, fleet } = bothOn([...base, exchange("http://localhost:11434/v1/chat")]);
    expect(single).toEqual({ kind: "local" });
    expect(fleet).toEqual(single);
  });

  it("agree on the host a call left for", () => {
    const { single, fleet } = bothOn([...base, exchange("https://api.anthropic.com/v1/messages")]);
    expect(single).toEqual({ kind: "host", host: "api.anthropic.com" });
    expect(fleet).toEqual(single);
  });

  it("agree that no recorded address is unknown — the 92.6 % case", () => {
    const { single, fleet } = bothOn(base);
    expect(single).toEqual({ kind: "unknown" });
    expect(fleet).toEqual(single);
  });
});
