import { describe, it, expect } from "vitest";
import { absences, besideReading, elapsedLabel, groupState, tokenLabel, workGroups } from "./workLevels";
import { NO_SIDECARS } from "../import/sidecarAgents";
import { foldWork } from "../state/work";
import type { WorkItem } from "../state/work";
import type { RunEvent } from "../events";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "x",
    parentId: "main",
    kind: "spawn",
    name: "x",
    intent: "",
    state: "completed",
    lastStatus: null,
    firstTs: 100,
    lastTs: 200,
    inTokens: 0,
    outTokens: 0,
    toolCalls: 0,
    gatesAsked: 0,
    gatesDenied: 0,
    gatePending: false,
    model: null,
    provider: null,
    opaque: null,
    runId: null,
    evidence: { start: null, tokens: null, firstCall: null, denial: null, end: null },
    children: [],
    ...over,
  };
}

describe("elapsedLabel", () => {
  it("is null when the stream never stamped a span — 0s would be a measurement", () => {
    expect(elapsedLabel(null, 200)).toBeNull();
    expect(elapsedLabel(100, null)).toBeNull();
  });

  it("formats a real span", () => {
    expect(elapsedLabel(1000, 3500)).toBe(elapsedLabel(0, 2500));
    expect(elapsedLabel(0, 0)).not.toBeNull();
  });
});

describe("tokenLabel", () => {
  it("keeps small numbers exact and compacts the rest", () => {
    expect(tokenLabel(999)).toBe("999");
    expect(tokenLabel(1234)).toBe("1.2k");
    expect(tokenLabel(512000)).toBe("512k");
  });
});

describe("groupState", () => {
  it("is worst-first", () => {
    expect(groupState([item({ state: "completed" }), item({ state: "failed" })])).toBe("failed");
    expect(groupState([item({ state: "completed" }), item({ state: "working" })])).toBe("working");
    expect(groupState([item({ state: "completed" })])).toBe("completed");
  });
});

describe("workGroups", () => {
  it("keeps kinds apart even when they overlap in time", () => {
    const groups = workGroups([
      item({ id: "a", kind: "spawn", firstTs: 0, lastTs: 100 }),
      item({ id: "b", kind: "launched", firstTs: 10, lastTs: 90 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.kind).sort()).toEqual(["launched", "spawn"]);
  });

  it("sums the members and counts how many settled", () => {
    const groups = workGroups([
      item({ id: "a", inTokens: 100, outTokens: 10, toolCalls: 2, state: "completed" }),
      item({ id: "b", inTokens: 200, outTokens: 20, toolCalls: 3, state: "working" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].inTokens).toBe(300);
    expect(groups[0].toolCalls).toBe(5);
    expect(groups[0].done).toBe(1);
    expect(groups[0].total).toBe(2);
    expect(groups[0].state).toBe("working");
  });

  it("names the group only when every member agrees", () => {
    expect(
      workGroups([item({ id: "a", name: "reviewer" }), item({ id: "b", name: "reviewer" })])[0].label,
    ).toBe("reviewer");
    expect(
      workGroups([item({ id: "a", name: "reviewer" }), item({ id: "b", name: "writer" })])[0].label,
    ).toBeNull();
  });

  it("a wave of one is still a group — hiding it would be a lie of omission", () => {
    const groups = workGroups([item({ id: "a" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(1);
  });

  it("carries a denial up to the group", () => {
    const groups = workGroups([item({ id: "a", gatesAsked: 2, gatesDenied: 1 })]);
    expect(groups[0].gatesDenied).toBe(1);
  });
});

/** A lane that actually left frames behind: a usage event and a tool call. */
const workedItem = (over: Partial<WorkItem> = {}): WorkItem =>
  item({
    toolCalls: 2,
    inTokens: 400,
    outTokens: 40,
    evidence: {
      start: null,
      tokens: { type: "usage", agentId: "x", inputTokens: 400, outputTokens: 40, ts: 150 },
      firstCall: null,
      denial: null,
      end: null,
    },
    ...over,
  });

// The `false` every call below carries is card 313's second argument: the
// agents panel lists no agent under these rows, which is the state every one
// of these assertions was written in. The other arm is pinned in
// workAgentsInStream.test.ts, apart, because it is a different claim.
describe("absences", () => {
  it("a lane with a span and its own frames hides nothing", () => {
    expect(absences(workedItem(), false)).toEqual([]);
  });

  it("a launched task always declares that its agent rows are missing", () => {
    const launched = item({
      kind: "launched",
      opaque: { agents: 24, agentsDone: 15, agentsError: 9, toolUses: 368, durationMs: 613990 },
    });
    expect(absences(launched, false)).toContain("agentRows");
    expect(absences(launched, false)).toContain("tokens");
    expect(absences(launched, false)).toContain("calls");
  });

  it("an item with no span says so", () => {
    expect(absences(workedItem({ firstTs: null, lastTs: null }), false)).toContain("span");
  });
});

// Card 313 folded opaqueLabel into besideReading: quoting the claim and
// deciding whether the claim is the right thing to say were two functions over
// one fact, and the panel held both. What it quoted is pinned here still, now
// through the reading that decides it.
describe("the claim a task reported, quoted and nothing else", () => {
  const launched = item({
    kind: "launched",
    opaque: { agents: 24, agentsDone: 15, agentsError: 9, toolUses: 368, durationMs: 613990 },
  });

  it("carries the two numbers the panel prints", () => {
    expect(besideReading(launched, [], NO_SIDECARS)).toEqual({
      kind: "claim",
      claimed: 24,
      toolUses: 368,
    });
  });

  it("says nothing when the task reported no counts", () => {
    expect(besideReading(item({ kind: "launched", opaque: null }), [], NO_SIDECARS)).toBeNull();
  });
});

describe("workGroups over a folded stream", () => {
  it("three concurrent lenses fold into one group of three", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "conductor", prompt: "review", ts: 0 },
    ];
    for (const lens of ["correctness", "security", "performance"]) {
      events.push({
        type: "agent_spawn",
        agentId: `worker-${lens}`,
        parentId: "conductor",
        task: lens,
        ts: 10,
      });
      events.push({
        type: "usage",
        agentId: `worker-${lens}`,
        inputTokens: 500,
        outputTokens: 50,
        ts: 100,
      });
      events.push({
        type: "agent_message",
        from: `worker-${lens}`,
        to: "conductor",
        role: "result",
        state: "completed",
        text: "done",
        ts: 120,
      });
    }
    const groups = workGroups(foldWork(events));
    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(3);
    expect(groups[0].done).toBe(3);
    expect(groups[0].inTokens).toBe(1500);
    expect(groups[0].label).toBeNull(); // three different ids, no shared label
  });
});

describe("absences · a lane the file names and never records", () => {
  // Measured on a real import (c8fefa6e…, five "Explore" children): a Claude
  // Code transcript whose subagent records are not sidechains announces its
  // children and carries not one frame of their work — the fold saw spawn and
  // result 17 ms apart and nothing in between.
  it("marks a lane with no usage frame and no calls", () => {
    const named = item({ firstTs: 500, lastTs: 517, inTokens: 0, outTokens: 0, toolCalls: 0 });
    expect(absences(named, false)).toEqual(["noWork"]);
  });

  it("a lane that did work is not marked, even if it was quick", () => {
    expect(absences(workedItem({ firstTs: 500, lastTs: 500 }), false)).toEqual([]);
  });

  it("a lane with a tool call but no usage is not marked — it left a frame", () => {
    expect(absences(item({ toolCalls: 1 }), false)).toEqual([]);
  });

  it("a launched task never gets the lane marker — it gets its own", () => {
    const launched = item({ kind: "launched", firstTs: 1, lastTs: 1 });
    expect(absences(launched, false)).not.toContain("noWork");
    expect(absences(launched, false)).toContain("agentRows");
  });
});
