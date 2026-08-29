// Card 302: the lighting fold is no longer welded to a StateGraphRun or to the
// three L1 type literals.
//
// A workflow run is the same PATTERN as a state graph — things that start,
// end and fail, read up to a cursor — but it is not the same artefact, and its
// records must not have to pretend to be `node_start` to be lit. So the fold
// takes the RECORDS and the three NAMES, and the L1 names become one constant
// among possible callers rather than the only vocabulary that exists.

import { describe, expect, it } from "vitest";
import {
  L1_EDGE_TAKEN,
  L1_LIFECYCLE,
  edgeStatsUpTo,
  lifecycleAt,
  takenUpTo,
  type TimelineRecord,
} from "./artifact";

/** A record list in a vocabulary the state graph has never heard of. */
const foreign: TimelineRecord[] = [
  { type: "agent_start", ts: 1, node: "a" },
  { type: "agent_start", ts: 2, node: "b" },
  { type: "agent_end", ts: 3, node: "a" },
  { type: "agent_error", ts: 4, node: "b" },
  { type: "hop", ts: 5, from: "a", to: "b" },
  { type: "hop", ts: 6, from: "a", to: "b" },
];

const FOREIGN = { start: "agent_start", end: "agent_end", error: "agent_error" } as const;

describe("the lighting fold takes records, not a run", () => {
  it("lights a foreign vocabulary when it is told the three names", () => {
    expect(lifecycleAt(foreign, foreign.length - 1, "a", FOREIGN)).toBe("done");
    expect(lifecycleAt(foreign, foreign.length - 1, "b", FOREIGN)).toBe("error");
    expect(lifecycleAt(foreign, 0, "b", FOREIGN)).toBe("pending");
    expect(lifecycleAt(foreign, 1, "b", FOREIGN)).toBe("active");
  });

  // Each name is bitten on its own: a fold that read only `type.endsWith`
  // or that ignored one of the three would still pass a single joint check.
  it("ignores a start name it was not given", () => {
    const types = { ...FOREIGN, start: "not_this" };
    expect(lifecycleAt(foreign, foreign.length - 1, "a", types)).toBe("done");
    expect(lifecycleAt(foreign, 1, "b", types)).toBe("pending");
  });

  it("ignores an end name it was not given", () => {
    const types = { ...FOREIGN, end: "not_this" };
    expect(lifecycleAt(foreign, foreign.length - 1, "a", types)).toBe("active");
  });

  it("ignores an error name it was not given", () => {
    const types = { ...FOREIGN, error: "not_this" };
    expect(lifecycleAt(foreign, foreign.length - 1, "b", types)).toBe("active");
  });

  it("counts a foreign edge name, and only that name", () => {
    expect(takenUpTo(foreign, foreign.length - 1, "hop")).toEqual(new Set(["a->b"]));
    expect(takenUpTo(foreign, foreign.length - 1, "not_this").size).toBe(0);
    const stats = edgeStatsUpTo(foreign, foreign.length - 1, "hop");
    expect(stats.counts.get("a->b")).toBe(2);
    expect(stats.last).toBe("a->b");
    expect(edgeStatsUpTo(foreign, foreign.length - 1, "not_this").last).toBeNull();
  });

  it("still speaks L1 through the exported constants", () => {
    const l1: TimelineRecord[] = [
      { type: "node_start", ts: 1, node: "n" },
      { type: "node_end", ts: 2, node: "n" },
      { type: "edge_taken", ts: 3, from: "n", to: "m" },
    ];
    expect(lifecycleAt(l1, 2, "n", L1_LIFECYCLE)).toBe("done");
    expect(takenUpTo(l1, 2, L1_EDGE_TAKEN)).toEqual(new Set(["n->m"]));
  });
});
