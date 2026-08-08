// The trace filter's memory (card 184, owner: "ein filter auf solche messages
// wäre cool"). The chips existed; what they did not do was survive a tab
// change, and a control you re-set on every visit is a control you do not have.

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_FILTER,
  activeCategories,
  currentTraceFilter,
  parseTraceFilter,
  resetTraceFilter,
  setTraceCategories,
  setTraceLlmDir,
  toggleTraceCategory,
} from "./traceFilter";

const ALL = ["run", "turn", "text", "thinking", "tool", "llm", "usage", "other"];

describe("traceFilter", () => {
  beforeEach(() => {
    resetTraceFilter();
  });

  it("opens showing everything, so a first visit is never a blank pane", () => {
    expect(currentTraceFilter()).toEqual(DEFAULT_TRACE_FILTER);
    expect(activeCategories(currentTraceFilter().categories, ALL).size).toBe(ALL.length);
  });

  it("remembers the direction the reader picked", () => {
    setTraceLlmDir("to");
    expect(currentTraceFilter().llmDir).toBe("to");
  });

  // The whole point of the store. What is written down has to come back the
  // same, because the reader who benefits is the one arriving after a tab
  // change — the store is fresh for them and the record is all there is.
  it("survives the round trip through what gets written down", () => {
    setTraceLlmDir("from");
    toggleTraceCategory("thinking", ALL);
    const written = JSON.stringify(currentTraceFilter());
    expect(parseTraceFilter(written)).toEqual(currentTraceFilter());
  });

  it("remembers a single chip being switched off", () => {
    toggleTraceCategory("thinking", ALL);
    const on = activeCategories(currentTraceFilter().categories, ALL);
    expect(on.has("thinking")).toBe(false);
    expect(on.has("llm")).toBe(true);
  });

  it("keeps the row's order, so the chips never reshuffle after a click", () => {
    toggleTraceCategory("text", ALL);
    const stored = currentTraceFilter().categories ?? [];
    expect(stored).toEqual(ALL.filter((c) => c !== "text"));
  });

  // The reason "has not chosen" is null and not the full list: a category a
  // later build adds must appear for a reader who never touched a chip. A
  // stored full list would hide every future category forever, silently.
  it("shows a category this build did not know when the reader never chose", () => {
    const later = [...ALL, "brandNew"];
    expect(activeCategories(null, later).has("brandNew")).toBe(true);
  });

  it("does hide a new category once the reader HAS chosen, because that is a choice", () => {
    toggleTraceCategory("thinking", ALL);
    const later = [...ALL, "brandNew"];
    expect(activeCategories(currentTraceFilter().categories, later).has("brandNew")).toBe(false);
  });

  it("stores 'everything' as everything once it was chosen, not as never-chosen", () => {
    setTraceCategories(ALL);
    expect(currentTraceFilter().categories).toEqual(ALL);
  });

  it("stores 'nothing' honestly, and says so rather than falling back to all", () => {
    setTraceCategories([]);
    expect(activeCategories(currentTraceFilter().categories, ALL).size).toBe(0);
  });
});

describe("a stored record this build cannot trust", () => {
  it("falls back to everything for a torn string", () => {
    expect(parseTraceFilter("{not json")).toEqual(DEFAULT_TRACE_FILTER);
  });

  it("falls back to everything for a value that is not an object", () => {
    expect(parseTraceFilter("[1,2]")).toEqual(DEFAULT_TRACE_FILTER);
    expect(parseTraceFilter("7")).toEqual(DEFAULT_TRACE_FILTER);
  });

  it("keeps the half it can read", () => {
    const half = parseTraceFilter(JSON.stringify({ llmDir: "from", categories: "nonsense" }));
    expect(half.llmDir).toBe("from");
    expect(half.categories).toBeNull();
  });

  it("refuses a direction it does not offer rather than filtering to nothing", () => {
    expect(parseTraceFilter(JSON.stringify({ llmDir: "sideways" })).llmDir).toBe("all");
  });

  it("drops a foreign entry from the category list without dropping the list", () => {
    const mixed = parseTraceFilter(JSON.stringify({ categories: ["llm", 7, null, "run"] }));
    expect(mixed.categories).toEqual(["llm", "run"]);
  });
});
