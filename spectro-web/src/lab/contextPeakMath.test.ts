// Card 300: the join behind the lab's context-peak panel, and the three
// honesty rules it exists to keep. Each rule gets its own bite below.

import { describe, expect, it } from "vitest";
import { contextPeaks } from "./contextPeakMath";
import { contextDenominator } from "../components/contextRingMath";
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
    // kid-a's run_start named claude-haiku-4-5, and Java's ModelWindows has a
    // row for it. Reaching for that row would be inventing a per-child window
    // the harness never measured: children are built without introspection and
    // emit no context_info at all (SubagentConfig's own javadoc), so nothing on
    // the wire says what a child was measured against.
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
  // CARD 366 CHANGED WHERE "published" COMES FROM, not what it means. The panel
  // used to reach it by reading a vendor prefix table in the web for the root's
  // model name; the harness now says it itself, because the SAME table decides
  // the threshold in Java and the provenance rides the wire beside it.
  it("a threshold derived from the model's published window is named as published", () => {
    // A cloud run: no loaded instance to measure, a published 1,000,000, and a
    // threshold of 700,000 that is 600,000 tokens above the old constant.
    const t = table([start("main", "claude-opus-4-6"), usage("main", 350_000)], {
      threshold: 700_000,
      source: "model",
    });
    expect(t.rows[0].denominator).toEqual({ value: 700_000, of: "compaction" });
    expect(t.rows[0].pct).toBe(50);
    expect(t.notes).toContain("published");
    expect(t.notes).not.toContain("measured");
    expect(t.notes).not.toContain("fellBack");
  });

  it("a run whose backend MEASURED its window is not called published", () => {
    // The two are one keystroke apart on the wire and must never blur: a
    // loaded instance is a measurement of a running server, a published window
    // is a promise about a model.
    const t = table([start("main", "claude-opus-4-6"), usage("main", 100_000)], {
      threshold: 175_257,
      source: "window",
    });
    expect(t.notes).toContain("measured");
    expect(t.notes).not.toContain("published");
  });

  it("a run that reported nothing gets NO divisor, whatever its model is called", () => {
    // The web has no table to consult any more, and that is the point: a
    // transcript recorded before card 366 carries no window, and the panel says
    // so instead of dividing by a guess that looks measured. The model name
    // changes nothing here — it used to change everything.
    //
    // REPLACED, not loosened. This case asserted `{value: 100_000, of:
    // "fallback"}` and a percentage against it. Its own comment already said
    // the panel "says unknown INSTEAD of dividing", and the code divided; the
    // three spends chosen for it (64k, 25k, 25k) were all under the stand-in,
    // so the arithmetic looked plausible in every one. See the case below for
    // what it looks like when it does not.
    const known = table([start("main", "gpt-4o"), usage("main", 64_000)]);
    const local = table([start("main", "deepseek-v4-flash"), usage("main", 25_000)]);
    const unnamed = table([start("main"), usage("main", 25_000)]);
    for (const t of [known, local, unnamed]) {
      expect(t.rows[0].denominator).toBeNull();
      expect(t.rows[0].pct).toBeNull();
      expect(t.rows[0].frac).toBeNull();
      expect(t.notes).toContain("unknown");
      expect(t.notes).not.toContain("published");
      expect(t.notes).not.toContain("measured");
      // …and the row still has a bar, because relFrac is a share of a
      // measurement rather than of a number nobody stated.
      expect(t.rows[0].relFrac).toBe(1);
    }
  });
});

describe("HONESTY 4 — the constant stand-in is not a divisor on this panel", () => {
  // THE REGRESSION THIS DESCRIBE EXISTS FOR, in the reviewer's own arithmetic.
  // Card 366's first cut took the vendor table away and left the division
  // standing, so the root fell to contextDenominator's third tier. Every
  // pre-card-263 session and every imported foreign JSONL reaches this panel
  // with no context_info at all, which is what the panel is FOR.
  it("a replayed 859k run against a hosted model prints no percentage, not 859 %", () => {
    const t = table([start("main", "claude-opus-4-6"), usage("main", 859_000)]);

    expect(t.rows[0].peak).toBe(859_000);
    expect(t.rows[0].denominator).toBeNull();
    expect(t.rows[0].pct).toBeNull();
    // The two numbers this case has ever printed, both refused: 859 against the
    // 100,000 stand-in (card 366's first cut) and 86 against the 1,000,000 the
    // web's own table used to guess for this prefix (everything before it).
    expect(t.rows[0].pct).not.toBe(859);
    expect(t.rows[0].pct).not.toBe(86);
    expect(t.notes).toEqual(["unknown"]);
  });

  it("a spend far over the stand-in is refused as loudly as one under it", () => {
    // The old shape's tell was that it only looked wrong above 100,000. Both
    // sides of the constant now answer the same way, which is what makes the
    // rule a rule and not a range check.
    const under = table([start("main", "claude-opus-4-6"), usage("main", 12_000)]);
    const over = table([start("main", "claude-opus-4-6"), usage("main", 2_400_000)]);
    expect(under.rows[0].denominator).toBeNull();
    expect(over.rows[0].denominator).toBeNull();
    expect(over.rows[0].frac).toBeNull();
  });

  it("but a threshold the harness FELL BACK to is still a divisor, stand-in value and all", () => {
    // The distinction rule 3 bought, and rule 4 must not eat: 100,000 arriving
    // ON THE WIRE is where this run will really compact, and the panel divides
    // by it. 100,000 arriving from contextRingMath because nobody said anything
    // is not a fact about the run at all.
    const said = table([start("main", "claude-opus-4-6"), usage("main", 859_000)], {
      threshold: 100_000,
      source: "fallback",
    });
    const silent = table([start("main", "claude-opus-4-6"), usage("main", 859_000)]);
    expect(said.rows[0].denominator).toEqual({ value: 100_000, of: "compaction" });
    expect(said.rows[0].pct).toBe(859);
    expect(said.notes).toEqual(["fellBack"]);
    expect(silent.rows[0].denominator).toBeNull();
  });

  it("a zero threshold on the wire is silence, not a divisor of nothing", () => {
    // contextDenominator already reads a 0 as absent; this pins that the panel
    // lands on rule 4 rather than on a division by zero.
    const t = table([start("main", "claude-opus-4-6"), usage("main", 50_000)], { threshold: 0 });
    expect(t.rows[0].denominator).toBeNull();
    expect(t.rows[0].pct).toBeNull();
    expect(t.notes).toEqual(["unknown"]);
  });
});

describe("the lab and the header ring divide by the same number", () => {
  // The card's own words: use contextDenominator VERBATIM "so the lab and the
  // header ring cannot disagree". Same function is not enough — it has to be
  // the same ARGUMENT, or the guarantee is defeated in exactly the case the
  // provenance field was added for.
  it("the shape every Anthropic run had divides identically on both surfaces", () => {
    const reported = { threshold: 100_000, source: "fallback" as const };
    const lab = table([start("main", "claude-opus-4-6"), usage("main", 76_608)], reported);
    // what components/ContextRing.tsx computes, in its own words:
    // contextDenominator(context?.threshold, context?.contextWindow ?? null)
    const ring = contextDenominator(reported.threshold, null);
    expect(lab.rows[0].denominator).toEqual(ring);
    expect(lab.rows[0].pct).toBe(77);
  });

  it("and so does the cloud run that shape has become", () => {
    // The same run after card 366: 1M published, 700k threshold, and both
    // surfaces divide by the number the harness will actually compact at.
    const reported = { threshold: 700_000, source: "model" as const };
    const lab = table([start("main", "claude-opus-4-6"), usage("main", 350_000)], reported);
    expect(lab.rows[0].denominator).toEqual(contextDenominator(700_000, 1_000_000));
    expect(lab.rows[0].pct).toBe(50);
  });

  it("and so does a run whose threshold the operator typed", () => {
    const lab = table([start("main", "gpt-4o"), usage("main", 2_500)], {
      threshold: 5_000,
      source: "override",
    });
    expect(lab.rows[0].denominator).toEqual(contextDenominator(5_000, 128_000));
  });

  it("…and where the ring has nothing to divide by, the lab prints nothing", () => {
    // THE CLAIM IS NARROWED TO WHAT THE CODE DOES, on purpose. The case that
    // stood here asserted the lab equals `contextDenominator(undefined, null)`
    // — the 100,000 constant — and that is exactly the tier rule 4 refuses.
    //
    // The guarantee that mattered is the one above: whenever a run states a
    // threshold, both surfaces divide by the SAME number, which is every live
    // session, the only situation in which both are on screen at once. The ring
    // is a live gauge with a running harness behind it and keeps the stand-in;
    // this panel replays transcripts that will never state anything, and prints
    // no percentage there instead.
    const lab = table([start("main", "gpt-4o"), usage("main", 64_000)]);
    expect(contextDenominator(undefined, null)).toEqual({ value: 100_000, of: "fallback" });
    expect(lab.rows[0].denominator).toBeNull();
  });
});

describe("the divisor comes from the RECORDED run, never from what is selected now", () => {
  it("a transcript that named no model gets no divisor, not the operator's current pick", () => {
    // The lab's primary mode is replay and import. Dividing an imported
    // transcript by whatever model happens to be selected in the app would
    // print "a published limit for {model}" naming a model that never appears
    // anywhere in the events on screen.
    const t = table([start("main"), usage("main", 25_000)]);
    expect(t.rows[0].denominator).toBeNull();
    expect(t.notes).toContain("unknown");
  });

  it("the root's model is still read from the recorded run_start, and shown", () => {
    // The model no longer decides the divisor — card 366 took that job away
    // from the name and gave it to the run's own frame — but the row still
    // NAMES the model, and it may only name the one the transcript carries.
    const named = table([start("main", "gpt-4o"), usage("main", 64_000)]);
    const unnamed = table([start("main"), usage("main", 64_000)]);
    expect(named.rows[0].model).toBe("gpt-4o");
    expect(unnamed.rows[0].model).toBeUndefined();
    expect(named.rows[0].denominator).toEqual(unnamed.rows[0].denominator);
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
