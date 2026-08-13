// Pins for how quiet the session list is (card 214).
//
// The suite runs in plain Node (no jsdom), so the storage seam is injected the
// way designPrefs.test.ts and graduation.test.ts inject theirs. That is the
// point of the seam here and not only a convenience: criterion 5 is "the choice
// survives a reload", and a store that never writes would pass every in-memory
// round-trip test in this file.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetForTests,
  __setTestHooks,
  currentDensity,
  DENSITIES,
  DENSITY_KEY,
  readSaved,
  rowParts,
  setDensity,
} from "./density";

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  __setTestHooks({
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
  });
  __resetForTests();
});

describe("the session list's density", () => {
  it("offers exactly the two values the card names, normal first", () => {
    expect(DENSITIES).toEqual(["normal", "extended"]);
  });

  it("defaults to normal for a reader who never touched it", () => {
    // Criterion 4. Nothing stored, nothing chosen: the rail starts quiet.
    expect(store).toEqual({});
    expect(currentDensity()).toBe("normal");
  });

  it("set + read round-trips", () => {
    setDensity("extended");
    expect(currentDensity()).toBe("extended");
    setDensity("normal");
    expect(currentDensity()).toBe("normal");
  });

  it("writes the choice out, so a reload can find it", () => {
    setDensity("extended");
    expect(store[DENSITY_KEY]).toBe("extended");
  });

  it("reads a stored choice back — this is the reload", () => {
    // A fresh page load is exactly this: the module initialises from whatever
    // the previous visit left behind.
    store[DENSITY_KEY] = "extended";
    __resetForTests();
    expect(currentDensity()).toBe("extended");
  });

  it("falls back to normal when the stored value is not one of ours", () => {
    // A hand-edited key, or a value from a future card, must not blank the rail.
    store[DENSITY_KEY] = "compact";
    expect(readSaved()).toBe("normal");
  });
});

describe("what a stored row draws at each density", () => {
  it("shows the name and the state dot, and nothing else, at normal", () => {
    // Criterion 3, first half.
    expect(rowParts("normal")).toEqual({ dot: true, sigil: false, meta: false });
  });

  it("shows everything a row shows today at extended", () => {
    // Criterion 3, second half: extended is today's row, unchanged.
    expect(rowParts("extended")).toEqual({ dot: true, sigil: true, meta: true });
  });

  it("keeps the state dot at BOTH densities", () => {
    // Criterion 6. With no metadata line, the dot is the only thing left that
    // can say a session is running, so it is the one part density may not cut.
    for (const d of DENSITIES) {
      expect(rowParts(d).dot, d).toBe(true);
    }
  });
});
