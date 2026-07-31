import { beforeEach, describe, expect, it } from "vitest";
import {
  closeSearch,
  findRanges,
  getSearch,
  isValidRegex,
  openSearch,
  reportCount,
  resetSearch,
  setQuery,
  setRegex,
  step,
} from "./search";

beforeEach(() => resetSearch());

describe("findRanges", () => {
  it("finds every occurrence, case-insensitively, in document order", () => {
    expect(findRanges("Alpha beta ALPHA", "alpha")).toEqual([
      [0, 5],
      [11, 16],
    ]);
  });

  it("matches literally rather than as a pattern", () => {
    // A user searching for a path or a regex-ish string must not have it
    // interpreted; ".*" is two characters here, not "everything".
    expect(findRanges("a.*b and axb", ".*")).toEqual([[1, 3]]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(findRanges("anything", "")).toEqual([]);
    expect(findRanges("anything", "   ")).toEqual([]);
  });

  it("does not overlap matches", () => {
    expect(findRanges("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});

describe("the store", () => {
  it("opens, closes and keeps the query across a close", () => {
    setQuery("ssh");
    openSearch();
    expect(getSearch().open).toBe(true);
    closeSearch();
    expect(getSearch().open).toBe(false);
    expect(getSearch().query).toBe("ssh");
  });

  it("drops the hit bookkeeping on close, since the next view may differ", () => {
    openSearch();
    setQuery("x");
    reportCount(5);
    step(2);
    closeSearch();
    expect(getSearch().count).toBe(0);
    expect(getSearch().index).toBe(0);
  });

  it("resets the position when the query changes", () => {
    setQuery("a");
    reportCount(10);
    step(3);
    expect(getSearch().index).toBe(3);
    setQuery("b");
    expect(getSearch().index).toBe(0);
    expect(getSearch().count).toBe(0);
  });

  it("wraps in both directions", () => {
    setQuery("x");
    reportCount(3);
    step(1);
    step(1);
    expect(getSearch().index).toBe(2);
    step(1);
    expect(getSearch().index).toBe(0);
    step(-1);
    expect(getSearch().index).toBe(2);
  });

  it("clamps rather than resets when the count shrinks under the reader", () => {
    // A live stream can remove matches while you are standing on one. Jumping
    // to the top would lose the reader's place for no reason.
    setQuery("x");
    reportCount(10);
    step(7);
    reportCount(3);
    expect(getSearch().index).toBe(2);
  });

  it("survives a count of zero", () => {
    setQuery("x");
    reportCount(0);
    step(1);
    expect(getSearch().index).toBe(0);
    expect(getSearch().count).toBe(0);
  });
});

describe("regex mode", () => {
  it("reads the query as a pattern when asked", () => {
    expect(findRanges("a1b22c", "\\d+", true)).toEqual([
      [1, 2],
      [3, 5],
    ]);
  });

  it("stays literal when not asked", () => {
    expect(findRanges("a.b axb", ".", false)).toEqual([[1, 2]]);
  });

  it("matches nothing for a half-typed pattern instead of throwing", () => {
    expect(() => findRanges("anything", "(\\d+", true)).not.toThrow();
    expect(findRanges("anything", "(\\d+", true)).toEqual([]);
    expect(isValidRegex("(\\d+")).toBe(false);
    expect(isValidRegex("\\d+")).toBe(true);
  });

  it("cannot spin on a zero-length match", () => {
    expect(findRanges("abc", "x*", true)).toEqual([]);
  });

  it("resets the position when the mode flips, since the hits change", () => {
    openSearch();
    setQuery("a");
    reportCount(9);
    step(4);
    setRegex(true);
    expect(getSearch().regex).toBe(true);
    expect(getSearch().index).toBe(0);
    expect(getSearch().count).toBe(0);
  });
});
