import { describe, it, expect } from "vitest";
import {
  TERM_OPEN_KEY,
  TERM_SPLIT_KEY,
  DEFAULT_TERM_SPLIT,
  MIN_TERM_SPLIT,
  MAX_TERM_SPLIT,
  clampTermPct,
  readStoredTermSplit,
  readStoredTermOpen,
} from "./shellPrefs";

describe("storage keys", () => {
  it("stays in the app's namespace", () => {
    expect(TERM_OPEN_KEY.startsWith("spectroscope:")).toBe(true);
    expect(TERM_SPLIT_KEY.startsWith("spectroscope:")).toBe(true);
  });
});

describe("clampTermPct", () => {
  it("keeps a usable value", () => {
    expect(clampTermPct(40)).toBe(40);
  });
  it("clamps a pane that would collapse", () => {
    expect(clampTermPct(1)).toBe(MIN_TERM_SPLIT);
  });
  it("clamps a pane that would swallow the tree", () => {
    expect(clampTermPct(99)).toBe(MAX_TERM_SPLIT);
  });
});

describe("readStoredTermSplit", () => {
  it("falls back when nothing is stored", () => {
    expect(readStoredTermSplit(null)).toBe(DEFAULT_TERM_SPLIT);
  });
  it("falls back for junk", () => {
    expect(readStoredTermSplit("wat")).toBe(DEFAULT_TERM_SPLIT);
  });
  it("falls back when out of range", () => {
    expect(readStoredTermSplit("2")).toBe(DEFAULT_TERM_SPLIT);
    expect(readStoredTermSplit("98")).toBe(DEFAULT_TERM_SPLIT);
  });
  it("keeps a stored value", () => {
    expect(readStoredTermSplit("55")).toBe(55);
  });
});

describe("readStoredTermOpen", () => {
  it("stays shut for a first-time operator", () => {
    expect(readStoredTermOpen(null)).toBe(false);
  });
  it("stays shut for junk, rather than spawning a shell on a bad read", () => {
    expect(readStoredTermOpen("yes please")).toBe(false);
  });
  it("reopens when it was left open", () => {
    expect(readStoredTermOpen("1")).toBe(true);
  });
  it("stays shut when it was left shut", () => {
    expect(readStoredTermOpen("0")).toBe(false);
  });
});
