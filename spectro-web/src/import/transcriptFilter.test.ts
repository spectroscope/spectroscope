import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "./rowState";
import type { TranscriptFacts } from "./transcriptFacts";
import {
  applyFilter,
  emptyFilter,
  filterIsActive,
  modelFamily,
  selectionStats,
  type FactsFilter,
} from "./transcriptFilter";

function row(path: string, modifiedAt = 10, size = 100): TranscriptRow {
  return { path, project: "-Users-x-repo", file: path, size, modifiedAt };
}

function facts(path: string, over: Partial<TranscriptFacts> = {}): TranscriptFacts {
  return { path, models: [], workflowCalls: 0, subagents: 0, workflowAgents: 0, ...over };
}

function factsFor(known: Record<string, TranscriptFacts>) {
  return (r: TranscriptRow): TranscriptFacts | undefined => known[r.path];
}

function filter(over: Partial<FactsFilter>): FactsFilter {
  return { ...emptyFilter(), ...over };
}

describe("modelFamily", () => {
  it("reduces a claude wire id to the family the owner says out loud", () => {
    expect(modelFamily("claude-fable-5")).toBe("fable");
    expect(modelFamily("claude-opus-4-8")).toBe("opus");
    expect(modelFamily("claude-sonnet-5")).toBe("sonnet");
  });

  it("finds the family behind a leading version in the older id style", () => {
    expect(modelFamily("claude-3-5-sonnet-20241022")).toBe("sonnet");
  });

  it("keeps the synthetic marker visible rather than hiding it", () => {
    // Claude Code writes "<synthetic>" as the model on records it generated
    // itself (API errors, injected turns). It is in the data, so it is in the
    // filter: hiding it would make a session unfindable by the one marker that
    // says its API errored. Only the angle brackets go, because a chip is a
    // word, not markup.
    expect(modelFamily("<synthetic>")).toBe("synthetic");
  });

  it("takes the first spoken token of a non-claude id", () => {
    expect(modelFamily("qwen3.5:27b-q4_K_M")).toBe("qwen3");
    expect(modelFamily("gpt-oss")).toBe("gpt");
  });
});

describe("applyFilter", () => {
  const rows = [row("a.jsonl", 30), row("b.jsonl", 20), row("c.jsonl", 10)];
  const known = {
    "a.jsonl": facts("a.jsonl", { models: ["claude-fable-5"], workflowCalls: 3 }),
    "b.jsonl": facts("b.jsonl", { models: ["claude-opus-4-8"], subagents: 2 }),
    "c.jsonl": facts("c.jsonl", { models: ["claude-fable-5", "claude-opus-4-8"] }),
  };

  it("passes everything through when nothing is selected", () => {
    const verdict = applyFilter(rows, factsFor(known), emptyFilter());
    expect(verdict.rows.map((r) => r.path)).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
    expect(verdict.pending).toBe(0);
  });

  it("is the conjunction the owner asked for: a model AND a property", () => {
    const verdict = applyFilter(rows, factsFor(known), filter({ models: ["fable"], props: ["workflow"] }));
    expect(verdict.rows.map((r) => r.path)).toEqual(["a.jsonl"]);
  });

  it("finds opus with subagents", () => {
    const verdict = applyFilter(rows, factsFor(known), filter({ models: ["opus"], props: ["subagents"] }));
    expect(verdict.rows.map((r) => r.path)).toEqual(["b.jsonl"]);
  });

  it("treats two selected models as either-of, not both-of", () => {
    const verdict = applyFilter(rows, factsFor(known), filter({ models: ["fable", "opus"] }));
    expect(verdict.rows.map((r) => r.path)).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
  });

  it("counts workflow agents as agent activity for the subagents chip", () => {
    const wf = { "a.jsonl": facts("a.jsonl", { workflowAgents: 4 }) };
    const verdict = applyFilter([rows[0]], factsFor(wf), filter({ props: ["subagents"] }));
    expect(verdict.rows.map((r) => r.path)).toEqual(["a.jsonl"]);
  });

  it("holds a row whose facts are not in yet as pending, never as a no", () => {
    const verdict = applyFilter(
      rows,
      factsFor({ "a.jsonl": known["a.jsonl"] }),
      filter({ models: ["fable"] }),
    );
    expect(verdict.rows.map((r) => r.path)).toEqual(["a.jsonl"]);
    expect(verdict.pending).toBe(2);
  });

  it("matches typed text against the file name without waiting for facts", () => {
    const verdict = applyFilter(rows, factsFor({}), filter({ text: "b.jsonl" }));
    expect(verdict.rows.map((r) => r.path)).toEqual(["b.jsonl"]);
  });

  it("matches typed text against the opening prompt once facts are in", () => {
    const prompted = { "a.jsonl": facts("a.jsonl", { firstPrompt: "fix the flaky gate" }) };
    const verdict = applyFilter(rows, factsFor(prompted), filter({ text: "flaky" }));
    expect(verdict.rows.map((r) => r.path)).toEqual(["a.jsonl"]);
    // b and c have no facts yet; their prompts might still match.
    expect(verdict.pending).toBe(2);
  });

  it("rules a row out on the listing alone when text misses and facts are in", () => {
    const verdict = applyFilter(rows, factsFor(known), filter({ text: "no-such-thing" }));
    expect(verdict.rows).toEqual([]);
    expect(verdict.pending).toBe(0);
  });
});

describe("filterIsActive", () => {
  it("is quiet on the empty filter and loud on any selection", () => {
    expect(filterIsActive(emptyFilter())).toBe(false);
    expect(filterIsActive(filter({ models: ["fable"] }))).toBe(true);
    expect(filterIsActive(filter({ props: ["workflow"] }))).toBe(true);
    expect(filterIsActive(filter({ text: "x" }))).toBe(true);
  });
});

describe("selectionStats", () => {
  const rows = [row("a.jsonl", 30_000), row("b.jsonl", 10_000), row("c.jsonl", 20_000)];
  const known = {
    "a.jsonl": facts("a.jsonl", {
      models: ["claude-fable-5"],
      workflowCalls: 3,
      subagents: 1,
      workflowAgents: 4,
    }),
    "b.jsonl": facts("b.jsonl", { models: ["claude-opus-4-8", "claude-fable-5"], subagents: 2 }),
  };

  it("counts what the selection holds, numbers only", () => {
    const stats = selectionStats(rows, factsFor(known));
    expect(stats.count).toBe(3);
    expect(stats.newest).toBe(30_000);
    expect(stats.oldest).toBe(10_000);
    expect(stats.workflowCalls).toBe(3);
    expect(stats.subagents).toBe(3);
    expect(stats.workflowAgents).toBe(4);
  });

  it("counts sessions per model family, not mentions", () => {
    const stats = selectionStats(rows, factsFor(known));
    expect(stats.models).toEqual([
      ["fable", 2],
      ["opus", 1],
    ]);
  });

  it("says how many selected rows have not answered yet, so the totals stay honest", () => {
    expect(selectionStats(rows, factsFor(known)).unread).toBe(1);
    expect(selectionStats([], factsFor(known)).count).toBe(0);
  });
});

// Card 179. The picture axis: it holds off the fold's own count, and an older
// server that does not send the field must read as "did not say" rather than
// as a transcript with no pictures — otherwise the chip quietly hides rows.
describe("the images property", () => {
  const withImages: TranscriptFacts = { path: "a", models: [], workflowCalls: 0, subagents: 0, images: 3 };
  const without: TranscriptFacts = { path: "b", models: [], workflowCalls: 0, subagents: 0, images: 0 };
  const older: TranscriptFacts = { path: "a", models: [], workflowCalls: 0, subagents: 0 };

  it("keeps only the transcripts that carry pictures", () => {
    const rows = [row("a"), row("b")];
    const facts = (r: TranscriptRow) => (r.path === "a" ? withImages : without);
    const out = applyFilter(rows, facts, { models: [], props: ["images"], text: "" });
    expect(out.rows.map((r) => r.path)).toEqual(["a"]);
  });

  it("does not claim a silent server means no pictures", () => {
    const out = applyFilter([row("a")], () => older, { models: [], props: ["images"], text: "" });
    expect(out.rows).toEqual([]);
  });

  it("adds them up across the selection", () => {
    const rows = [row("a"), row("b")];
    expect(selectionStats(rows, (r) => (r.path === "a" ? withImages : without)).images).toBe(3);
  });
});
