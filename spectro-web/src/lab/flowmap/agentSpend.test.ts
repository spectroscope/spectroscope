import { describe, expect, it } from "vitest";
import { deriveDetail } from "./sceneToFlow";
import type { RunEvent } from "../../events";

const usage = (agentId: string, input: number, cr = 0, cc = 0): RunEvent =>
  ({
    type: "usage",
    agentId,
    inputTokens: input,
    outputTokens: 1,
    cacheReadTokens: cr,
    cacheCreationTokens: cc,
    ts: 1,
  }) as RunEvent;

describe("per-agent spend, brief and model (card 287)", () => {
  it("context size sums the cache columns — inputTokens is the uncached remainder", () => {
    const d = deriveDetail([usage("w", 2, 34654, 31385)]);
    expect(d.spend["w"]).toEqual({ peak: 66041, turns: 1 });
  });

  it("peak keeps the maximum, not the last — a window can compact downward", () => {
    const d = deriveDetail([usage("w", 50_000), usage("w", 10_000)]);
    expect(d.spend["w"].peak).toBe(50_000);
    expect(d.spend["w"].turns).toBe(2);
  });

  it("a provider that reports no cache columns still counts", () => {
    const d = deriveDetail([
      { type: "usage", agentId: "w", inputTokens: 9_000, outputTokens: 10, ts: 1 } as RunEvent,
    ]);
    expect(d.spend["w"]).toEqual({ peak: 9_000, turns: 1 });
  });

  it("each agent's brief and model come from its OWN run_start", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r", agentId: "main", prompt: "root brief", model: "opus", ts: 1 } as RunEvent,
      { type: "run_start", runId: "r", agentId: "w1id", prompt: "child brief", model: "sonnet", ts: 2 } as RunEvent,
    ];
    const d = deriveDetail(events);
    expect(d.briefs["w1id"]).toBe("child brief");
    expect(d.models["w1id"]).toBe("sonnet");
    expect(d.briefs["main"]).toBe("root brief");
    expect(d.models["main"]).toBe("opus");
  });

  it("an agent with no model on the wire stays absent — no inherited value", () => {
    const d = deriveDetail([
      { type: "run_start", runId: "r", agentId: "x", prompt: "p", ts: 1 } as RunEvent,
    ]);
    expect(d.models["x"]).toBeUndefined();
    expect(d.briefs["x"]).toBe("p");
  });
});
