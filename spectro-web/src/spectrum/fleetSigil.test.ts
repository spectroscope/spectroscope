import { describe, it, expect } from "vitest";
import { fleetSigil } from "./FleetSigil";
import type { FleetNode } from "./fleetModel";

function node(id: string, role = "worker", connected = true): FleetNode {
  return { id, role, capabilities: [], topic: "ctx.events", connected, lastSeen: 1 };
}

describe("fleetSigil", () => {
  it("emits one bar per roster node", () => {
    expect(fleetSigil([node("a"), node("b"), node("c")])).toHaveLength(3);
  });

  it("is deterministic — same roster, same bar positions", () => {
    const a = fleetSigil([node("root", "root"), node("w1"), node("w2")]);
    const b = fleetSigil([node("root", "root"), node("w1"), node("w2")]);
    expect(a).toEqual(b);
  });

  it("gives different fleets different barcodes", () => {
    const alpha = fleetSigil([node("alpha-1"), node("alpha-2")]).map((s) => s.x);
    const beta = fleetSigil([node("beta-1"), node("beta-2")]).map((s) => s.x);
    expect(alpha).not.toEqual(beta);
  });

  it("colors by role and dims a disconnected node", () => {
    const bars = fleetSigil([node("r", "root"), node("w", "worker", false)]);
    const root = bars.find((b) => b.token === "var(--agent-root)")!;
    expect(root).toBeDefined();
    expect(bars.some((b) => b.faint)).toBe(true);
  });

  it("positions are within the 0..1 axis and sorted", () => {
    const bars = fleetSigil([node("z"), node("a"), node("m")]);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(1);
    }
    const xs = bars.map((b) => b.x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
  });
});
