// Card 300: the join behind the lab's context-peak panel, and the three
// honesty rules it exists to keep. Each rule gets its own bite below.

import { describe, expect, it } from "vitest";
import { contextPeaks } from "./contextPeak";
import { agentDirectory } from "./agentDirectory";
import { deriveDetail } from "./flowmap/sceneToFlow";
import type { RunEvent } from "../events";

const start = (agentId: string, model?: string, parentId?: string): RunEvent =>
  ({
    type: "run_start",
    runId: "r",
    agentId,
    prompt: `${agentId} brief`,
    ...(model === undefined ? {} : { model }),
    ...(parentId === undefined ? {} : { parentId }),
    ts: 1,
  }) as RunEvent;

const spawn = (agentId: string, task: string): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task, ts: 2 }) as RunEvent;

const usage = (agentId: string, input: number, cr = 0, cc = 0): RunEvent =>
  ({
    type: "usage",
    agentId,
    inputTokens: input,
    outputTokens: 1,
    cacheReadTokens: cr,
    cacheCreationTokens: cc,
    ts: 3,
  }) as RunEvent;

/** The whole join as a surface reads it: the canon's own spend, the canon's
 *  own directory, nothing derived twice. */
function table(events: RunEvent[], reported: Parameters<typeof contextPeaks>[0]["reported"] = null) {
  const detail = deriveDetail([...events]);
  return contextPeaks({
    spend: detail.spend,
    models: detail.models,
    directory: agentDirectory(events),
    reported,
  });
}

const CHILDREN = [start("main", "claude-opus-4-6"), spawn("kid-a", "read the docs"), start("kid-a", "claude-haiku-4-5", "main")];

describe("the peak comes from the canon's spend, the handle from the canon's directory", () => {
  it("one row per agent that actually reported usage, root first", () => {
    const t = table([...CHILDREN, usage("main", 2, 34654, 31385), usage("kid-a", 9_000)]);
    expect(t.rows.map((r) => r.tag)).toEqual(["main", "w1"]);
    expect(t.rows[0].peak).toBe(66_041); // the cache columns are part of the context
    expect(t.rows[1].peak).toBe(9_000);
    expect(t.rows[1].name).toBe("read the docs"); // the directory's name, not the id
  });

  it("an agent that never reported usage has no peak and therefore no row", () => {
    const t = table([...CHILDREN, usage("main", 5_000)]);
    expect(t.rows.map((r) => r.agentId)).toEqual(["main"]);
  });

  it("peak keeps the maximum across turns, and turns counts them", () => {
    const t = table([...CHILDREN, usage("main", 50_000), usage("main", 10_000)]);
    expect(t.rows[0].peak).toBe(50_000);
    expect(t.rows[0].turns).toBe(2);
  });

  it("bars scale against the biggest peak in the table, which is not a window", () => {
    const t = table([...CHILDREN, usage("main", 80_000), usage("kid-a", 20_000)]);
    expect(t.rows[0].relFrac).toBe(1);
    expect(t.rows[1].relFrac).toBeCloseTo(0.25, 5);
  });
});

describe("HONESTY 1 — a child never gets a percentage", () => {
  it("no denominator and no percentage for a child, even beside a measured root", () => {
    const t = table([...CHILDREN, usage("main", 40_000), usage("kid-a", 30_000)], {
      threshold: 153_216,
      source: "window",
    });
    const child = t.rows[1];
    expect(child.root).toBe(false);
    expect(child.denominator).toBeNull();
    expect(child.pct).toBeNull();
    expect(child.frac).toBeNull();
    // the root beside it DOES get one — the rule is about children, not about
    // the panel giving up
    expect(t.rows[0].pct).toBe(26);
  });

  it("a child's own model does not become a divisor either", () => {
    // kid-a's run_start named claude-haiku-4-5, and the published table has a
    // row for it. Reading that row would be inventing a per-child window the
    // harness never measured: children are built without introspection and
    // emit no context_info at all (SubagentConfig's own javadoc).
    const t = table([...CHILDREN, usage("main", 1_000), usage("kid-a", 30_000)]);
    expect(t.rows[1].model).toBe("claude-haiku-4-5");
    expect(t.rows[1].denominator).toBeNull();
  });

  it("the panel is told to say why, whenever a child is on it", () => {
    const withKid = table([...CHILDREN, usage("main", 1_000), usage("kid-a", 30_000)]);
    expect(withKid.notes).toContain("childrenNoWindow");
    const rootOnly = table([...CHILDREN, usage("main", 1_000)]);
    expect(rootOnly.notes).not.toContain("childrenNoWindow");
  });
});

describe("HONESTY 2 — a measured threshold wins over the published table", () => {
  it("the run's own threshold is the divisor, not the model's table row", () => {
    const t = table([...CHILDREN, usage("main", 76_608)], { threshold: 153_216, source: "window" });
    expect(t.rows[0].denominator).toEqual({ value: 153_216, of: "compaction" });
    expect(t.rows[0].pct).toBe(50); // against 1_000_000 it would have read 8
    expect(t.notes).toContain("measured");
    expect(t.notes).not.toContain("published");
  });

  it("an explicit compactionThreshold is a measurement of the operator's intent", () => {
    const t = table([...CHILDREN, usage("main", 2_500)], { threshold: 5_000, source: "override" });
    expect(t.rows[0].denominator).toEqual({ value: 5_000, of: "compaction" });
    expect(t.notes).toContain("measured");
  });

  it("a threshold the harness said it FELL BACK to is not a measurement", () => {
    // This is the whole reason thresholdSource had to reach TypeScript: the
    // number 100000 arrives on the wire either way, and only the provenance
    // says whether anything was learned. Falling to the model table here is
    // the honest move, and it must be LABELLED as the table.
    const t = table([...CHILDREN, usage("main", 100_000)], { threshold: 100_000, source: "fallback" });
    expect(t.rows[0].denominator).toEqual({ value: 1_000_000, of: "window" });
    expect(t.notes).toContain("published");
    expect(t.notes).not.toContain("measured");
  });

  it("a frame from before card 263 states no provenance and is taken at its word", () => {
    const t = table([...CHILDREN, usage("main", 50_000)], { threshold: 200_000 });
    expect(t.rows[0].denominator).toEqual({ value: 200_000, of: "compaction" });
    expect(t.notes).toContain("measured");
  });
});

describe("HONESTY 3 — a published divisor says it is published", () => {
  it("with no reported threshold the model table is used and named as such", () => {
    const t = table([start("main", "gpt-4o"), usage("main", 64_000)]);
    expect(t.rows[0].denominator).toEqual({ value: 128_000, of: "window" });
    expect(t.rows[0].pct).toBe(50);
    expect(t.notes).toContain("published");
    expect(t.notes).not.toContain("measured");
  });

  it("a model the table does not know falls to the constant, and says THAT", () => {
    const t = table([start("main", "deepseek-v4-flash"), usage("main", 25_000)]);
    expect(t.rows[0].denominator).toEqual({ value: 100_000, of: "fallback" });
    expect(t.notes).toContain("unknown");
    expect(t.notes).not.toContain("published");
    expect(t.notes).not.toContain("measured");
  });

  it("a run that never named a model at all falls to the constant too", () => {
    const t = table([start("main"), usage("main", 25_000)]);
    expect(t.rows[0].denominator).toEqual({ value: 100_000, of: "fallback" });
    expect(t.notes).toContain("unknown");
  });
});

describe("the shape at the edges", () => {
  it("an empty run is an empty table with nothing to explain", () => {
    const t = table([]);
    expect(t.rows).toEqual([]);
    expect(t.notes).toEqual([]);
  });

  it("children with no root usage still get rows, and no divisor note is invented", () => {
    const t = table([...CHILDREN, usage("kid-a", 12_000)]);
    expect(t.rows.map((r) => r.tag)).toEqual(["w1"]);
    expect(t.notes).toEqual(["childrenNoWindow"]);
  });
});
