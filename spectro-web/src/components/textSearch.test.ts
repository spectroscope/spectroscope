import { describe, expect, it } from "vitest";
import { NO_HITS, feedHits, markLine } from "./textSearch";

describe("feedHits", () => {
  it("numbers the occurrences continuously across the lines", () => {
    // The store steps through ONE global sequence, so line two's first hit has
    // to know how many came before it.
    const hits = feedHits(["ok ok", "nope", "ok"], "ok");
    expect(hits.total).toBe(3);
    expect(hits.byLine.get(0)).toEqual({
      ranges: [
        [0, 2],
        [3, 5],
      ],
      first: 0,
    });
    expect(hits.byLine.get(2)).toEqual({ ranges: [[0, 2]], first: 2 });
  });

  it("leaves lines without a hit out of the map", () => {
    // The feed is long and mostly misses; only matched lines get sliced at
    // render time, the rest stay the plain strings they already were.
    const hits = feedHits(["alpha", "beta", "gamma"], "beta");
    expect([...hits.byLine.keys()]).toEqual([1]);
  });

  it("finds nothing for an empty or whitespace query", () => {
    expect(feedHits(["anything"], "")).toEqual(NO_HITS);
    expect(feedHits(["anything"], "   ")).toEqual(NO_HITS);
  });

  it("matches case-insensitively and across newlines inside one line", () => {
    // A feed segment is a block, not a row: a tool output carries newlines and
    // a hit may sit on any of them.
    const hits = feedHits(["first\nSECOND"], "second");
    expect(hits.total).toBe(1);
    expect(hits.byLine.get(0)?.ranges).toEqual([[6, 12]]);
  });

  it("counts nothing when the query is absent", () => {
    expect(feedHits(["alpha", "beta"], "zeta")).toEqual(NO_HITS);
  });
});

describe("markLine", () => {
  it("puts the line back together byte for byte", () => {
    const text = "run ok, then ok again";
    const hits = feedHits([text], "ok").byLine.get(0);
    expect(hits).toBeDefined();
    expect(
      markLine(text, hits!)
        .map((run) => run.text)
        .join(""),
    ).toBe(text);
  });

  it("marks the hits with their global ordinals and the gaps with -1", () => {
    const hits = { ranges: [[4, 6] as [number, number]], first: 7 };
    expect(markLine("say ok now", hits)).toEqual([
      { text: "say ", ordinal: -1 },
      { text: "ok", ordinal: 7 },
      { text: " now", ordinal: -1 },
    ]);
  });

  it("keeps the reader's own casing", () => {
    const hits = feedHits(["Alpha"], "alpha").byLine.get(0)!;
    expect(markLine("Alpha", hits)).toEqual([{ text: "Alpha", ordinal: 0 }]);
  });

  it("emits no empty runs when a hit touches either end", () => {
    const hits = feedHits(["ok mid ok"], "ok").byLine.get(0)!;
    expect(markLine("ok mid ok", hits)).toEqual([
      { text: "ok", ordinal: 0 },
      { text: " mid ", ordinal: -1 },
      { text: "ok", ordinal: 1 },
    ]);
  });

  it("numbers several hits in one line consecutively from `first`", () => {
    const hits = { ranges: [[0, 1] as [number, number], [2, 3] as [number, number]], first: 5 };
    expect(markLine("a a", hits).map((run) => run.ordinal)).toEqual([5, -1, 6]);
  });
});

describe("regex mode reaches the feed too", () => {
  it("reads the query as a pattern when asked", () => {
    const hits = feedHits(["a1b", "cc", "d22"], "\\d+", true);
    expect(hits.total).toBe(2);
  });

  it("stays literal when not asked", () => {
    expect(feedHits(["a.b", "axb"], ".", false).total).toBe(1);
  });
});
