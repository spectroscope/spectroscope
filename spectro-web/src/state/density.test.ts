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
  it("offers exactly the three values, from the quietest to the fullest", () => {
    // Card 555, criterion 1: minimal, normal, extended, in this order. The
    // panel maps this list, so the order here is the order a reader sees.
    expect(DENSITIES).toEqual(["minimal", "normal", "extended"]);
  });

  it("defaults to normal for a reader who never touched it", () => {
    // Criterion 4. Nothing stored, nothing chosen: the rail starts quiet.
    expect(store).toEqual({});
    expect(currentDensity()).toBe("normal");
  });

  it("set + read round-trips", () => {
    setDensity("extended");
    expect(currentDensity()).toBe("extended");
    setDensity("minimal");
    expect(currentDensity()).toBe("minimal");
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

  it("reads every stored value back, the new one and the two that came before it", () => {
    // Card 555, criterion 1: a value written by 0.15.2 or earlier keeps working.
    for (const d of ["normal", "extended", "minimal"] as const) {
      store[DENSITY_KEY] = d;
      __resetForTests();
      expect(currentDensity(), d).toBe(d);
    }
  });

  it("falls back to normal when the stored value is not one of ours", () => {
    // A hand-edited key, or a value from a future card, must not blank the rail.
    store[DENSITY_KEY] = "compact";
    expect(readSaved()).toBe("normal");
  });
});

describe("what a stored row draws at each density", () => {
  it("shows the name and the state dot, and nothing else, at minimal", () => {
    // Card 555: the owner's "Name und Punkt". No live line, no comb, no meta.
    expect(rowParts("minimal")).toEqual({ dot: true, sigil: false, meta: false, liveLine: false });
  });

  it("adds the folder and state line of a live session at normal", () => {
    // Card 214 made normal the name and the dot; card 503 added the live line
    // under it, and card 555 puts that line under the density as well.
    expect(rowParts("normal")).toEqual({ dot: true, sigil: false, meta: false, liveLine: true });
  });

  it("shows everything a row shows at extended", () => {
    // Extended is the full row: the comb, the meta line and the live line.
    expect(rowParts("extended")).toEqual({ dot: true, sigil: true, meta: true, liveLine: true });
  });

  it("keeps the state dot at EVERY density", () => {
    // Criterion 6. With no metadata line, the dot is the only thing left that
    // can say a session is running, so it is the one part density may not cut.
    for (const d of DENSITIES) {
      expect(rowParts(d).dot, d).toBe(true);
    }
  });
});
