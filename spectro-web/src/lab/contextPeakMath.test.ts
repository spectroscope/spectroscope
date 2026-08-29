// Card 300: the join behind the lab's context-peak panel, and the three
// honesty rules it exists to keep. Each rule gets its own bite below.

import { describe, expect, it } from "vitest";
import { contextPeaks } from "./contextPeakMath";
import { contextDenominator } from "../components/contextRingMath";
import { contextWindowFor } from "../components/contextWindow";
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

const CHILDREN = [
  start("main", "claude-opus-4-6"),
  spawn("kid-a", "read the docs"),
  start("kid-a", "claude-haiku-4-5", "main"),
];

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

  // REPLACED, not loosened. The test that stood here demanded the OPPOSITE:
  // that a `fallback` threshold be dropped and the model table divided by
  // instead. Its premise was measured false. On the shape every Anthropic run
  // has — AnthropicProvider does not override LlmProvider.contextWindow(), so
  // it answers 0 and CompactionThreshold.derive returns (100_000, FALLBACK) —
  // that rule made the header ring read 77 % and this panel 8 % of the same
  // spend, and the 8 % was the dishonest one: 100,000 is where the run WILL
  // compact, and the 1,000,000 came from the prefix table that already misread
  // claude-fable-5 as 379 %. So the divisor is the run's own threshold, always,
  // and the provenance decides the WORDS.
  it("a threshold the harness FELL BACK to is still the divisor, and is not called a measurement", () => {
    const t = table([...CHILDREN, usage("main", 76_608)], { threshold: 100_000, source: "fallback" });
    expect(t.rows[0].denominator).toEqual({ value: 100_000, of: "compaction" });
    expect(t.rows[0].pct).toBe(77);
    expect(t.notes).toContain("fellBack");
    expect(t.notes).not.toContain("measured");
    expect(t.notes).not.toContain("published");
  });

  it("a fallen-back threshold beside an UNKNOWN model still says what the run reported", () => {
    // The panel used to print "the run reported no threshold" here. The run
    // reported one — 100,000, provenance fallback. The number was accidentally
    // right and the sentence about the run's own data was false.
    const t = table([...CHILDREN, usage("main", 25_000)], { threshold: 100_000, source: "fallback" });
    const local = table([start("main", "some-local-build"), usage("main", 25_000)], {
      threshold: 100_000,
      source: "fallback",
    });
    expect(t.rows[0].denominator).toEqual({ value: 100_000, of: "compaction" });
    expect(local.rows[0].denominator).toEqual({ value: 100_000, of: "compaction" });
    expect(local.notes).toContain("fellBack");
    expect(local.notes).not.toContain("unknown");
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

describe("the lab and the header ring divide by the same number", () => {
  // The card's own words: use contextDenominator VERBATIM "so the lab and the
  // header ring cannot disagree". Same function is not enough — it has to be
  // the same ARGUMENT, or the guarantee is defeated in exactly the case the
  // provenance field was added for.
  it("the shape every Anthropic run has divides identically on both surfaces", () => {
    const model = "claude-opus-4-6";
    const reported = { threshold: 100_000, source: "fallback" as const };
    const lab = table([start("main", model), usage("main", 76_608)], reported);
    // what components/ContextRing.tsx computes, in its own words:
    // contextDenominator(context?.threshold, modelWindow)
    const ring = contextDenominator(reported.threshold, contextWindowFor(model));
    expect(lab.rows[0].denominator).toEqual(ring);
    expect(lab.rows[0].pct).toBe(77);
  });

  it("and so does a run whose threshold the operator typed", () => {
    const lab = table([start("main", "gpt-4o"), usage("main", 2_500)], {
      threshold: 5_000,
      source: "override",
    });
    expect(lab.rows[0].denominator).toEqual(contextDenominator(5_000, contextWindowFor("gpt-4o")));
  });

  it("and so does a run that reported no threshold at all", () => {
    const lab = table([start("main", "gpt-4o"), usage("main", 64_000)]);
    expect(lab.rows[0].denominator).toEqual(contextDenominator(undefined, contextWindowFor("gpt-4o")));
  });
});

describe("the divisor comes from the RECORDED run, never from what is selected now", () => {
  it("a transcript that named no model gets the stand-in, not the operator's current pick", () => {
    // The lab's primary mode is replay and import. Dividing an imported
    // transcript by whatever model happens to be selected in the app would
    // print "a published limit for {model}" naming a model that never appears
    // anywhere in the events on screen.
    const t = table([start("main"), usage("main", 25_000)]);
    expect(t.rows[0].denominator).toEqual({ value: 100_000, of: "fallback" });
    expect(t.notes).toContain("unknown");
  });

  it("the root's model is read from the recorded run_start, and from nowhere else", () => {
    const named = table([start("main", "gpt-4o"), usage("main", 64_000)]);
    const unnamed = table([start("main"), usage("main", 64_000)]);
    expect(named.rows[0].denominator).toEqual({ value: 128_000, of: "window" });
    expect(unnamed.rows[0].denominator).toEqual({ value: 100_000, of: "fallback" });
    expect(unnamed.rows[0].model).toBeUndefined();
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
