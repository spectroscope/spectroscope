import { describe, expect, it } from "vitest";
import { formatViewState, isEmptyViewState, onlyClause, parseViewState } from "./viewState";

describe("the state inside a view, as an address", () => {
  it("says nothing when there is nothing to say", () => {
    expect(formatViewState(undefined)).toBe("");
    expect(formatViewState({})).toBe("");
    expect(isEmptyViewState({})).toBe(true);
  });

  it("carries a selected row, which is the commonest thing anybody sends", () => {
    expect(formatViewState({ row: 412 })).toBe("?row=412");
    expect(parseViewState("row=412")).toEqual({ row: 412 });
  });

  it("carries a spectrum window, rounded to something readable", () => {
    expect(formatViewState({ win: { a: 0.3141592, b: 0.4871 } })).toBe("?win=0.314,0.487");
    expect(parseViewState("win=0.314,0.487")).toEqual({ win: { a: 0.314, b: 0.487 } });
  });

  it("round-trips all three together", () => {
    const v = { row: 7, only: ["tool", "permission"], win: { a: 0.1, b: 0.9 } };
    expect(parseViewState(formatViewState(v).slice(1))).toEqual(v);
  });
});

// The rule that keeps a copied link short.
describe("the filter clause", () => {
  const all = ["run", "tool", "permission", "usage"];

  it("is absent when nothing is filtered out", () => {
    expect(onlyClause(new Set(all), all)).toBeUndefined();
  });

  it("names what is ON when some are off", () => {
    expect(onlyClause(new Set(["tool", "usage"]), all)).toEqual(["tool", "usage"]);
  });

  it("keeps the file's own order, not the click order", () => {
    expect(onlyClause(new Set(["usage", "run"]), all)).toEqual(["run", "usage"]);
  });

  it("writes everything-off as an empty selection rather than dropping it", () => {
    expect(onlyClause(new Set(), all)).toEqual([]);
    // …and an empty list writes no clause, because "?only=" says nothing.
    expect(formatViewState({ only: [] })).toBe("");
  });
});

// Forgiving in one direction: landing on the right view with the wrong zoom
// beats not landing at all.
describe("a malformed address", () => {
  it("drops a clause it cannot read, and keeps the rest", () => {
    expect(parseViewState("row=abc&win=0.2,0.8")).toEqual({ win: { a: 0.2, b: 0.8 } });
  });

  it("refuses a window that is not one", () => {
    expect(parseViewState("win=0.8,0.2")).toEqual({}); // backwards
    expect(parseViewState("win=-1,0.5")).toEqual({}); // outside the domain
    expect(parseViewState("win=0.5")).toEqual({}); // half a window
    expect(parseViewState("win=0.5,0.5")).toEqual({}); // no width
  });

  it("refuses a row that addresses nothing", () => {
    expect(parseViewState("row=-3")).toEqual({});
    expect(parseViewState("row=2.5")).toEqual({});
  });

  it("ignores a key it does not know", () => {
    expect(parseViewState("zoom=3&row=1")).toEqual({ row: 1 });
  });

  it("survives an empty or nonsense query", () => {
    expect(parseViewState("")).toEqual({});
    expect(parseViewState(undefined)).toEqual({});
    expect(parseViewState("&&=&x")).toEqual({});
  });
});
