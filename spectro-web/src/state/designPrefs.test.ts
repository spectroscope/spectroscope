import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetForTests,
  __setTestHooks,
  applyAndSaveDesign,
  DEFAULT_PREFS,
  type DesignPrefs,
  isDirty,
  parsePrefs,
  readSaved,
  revertDesign,
  saveDesign,
  setDraft,
} from "./designPrefs";

// The suite runs in plain Node (no jsdom), so we inject in-memory seams instead
// of touching real localStorage / the DOM.
let store = new Map<string, string>();
let applied: DesignPrefs[] = [];
const KEY = "spectroscope:design";

beforeEach(() => {
  store = new Map();
  applied = [];
  __setTestHooks({
    get: () => store.get(KEY) ?? null,
    set: (v) => store.set(KEY, v),
    apply: (p) => applied.push({ ...p }),
  });
  __resetForTests();
});

const lastApplied = (): DesignPrefs => applied[applied.length - 1];

describe("designPrefs store", () => {
  it("defaults to the brand design with both effects on when storage is empty", () => {
    expect(DEFAULT_PREFS.design).toBe("spectroscope");
    expect(readSaved()).toEqual(DEFAULT_PREFS);
    expect(isDirty()).toBe(false);
    expect(lastApplied()).toEqual(DEFAULT_PREFS); // reset applied the default
  });

  it("setDraft applies the new prefs and marks the store dirty", () => {
    setDraft({ design: "paper", particles: false });
    expect(lastApplied()).toEqual({ design: "paper", scroll: true, particles: false, reasoningLens: false });
    expect(isDirty()).toBe(true);
  });

  it("save persists the draft and clears dirty", () => {
    setDraft({ design: "still" });
    saveDesign();
    expect(isDirty()).toBe(false);
    expect(JSON.parse(store.get(KEY) ?? "{}").design).toBe("still");
  });

  it("revert discards the draft back to the last saved look", () => {
    setDraft({ design: "still" });
    saveDesign();
    setDraft({ design: "paper", scroll: false });
    expect(isDirty()).toBe(true);
    revertDesign();
    expect(isDirty()).toBe(false);
    expect(lastApplied()).toEqual({ design: "still", scroll: true, particles: true, reasoningLens: false });
  });

  it("parsePrefs seeds from storage and rejects an unknown design id", () => {
    const p = parsePrefs(JSON.stringify({ design: "bogus", scroll: false, particles: false }));
    expect(p.design).toBe("spectroscope"); // unknown -> default
    expect(p.scroll).toBe(false);
    expect(p.particles).toBe(false);
  });

  it("accepts the two brand designs and round-trips the reasoning lens", () => {
    for (const brand of ["spectroscope", "paper"] as const) {
      expect(parsePrefs(JSON.stringify({ design: brand })).design).toBe(brand);
    }
    // Card 13: the lens is a persisted pref — settings-page path, one step.
    applyAndSaveDesign({ reasoningLens: true });
    expect(JSON.parse(store.get(KEY) ?? "{}").reasoningLens).toBe(true);
    expect(isDirty()).toBe(false);
    // A stored pref without the key (older browser state) defaults to off.
    expect(parsePrefs(JSON.stringify({ design: "paper" })).reasoningLens).toBe(false);
  });

  it("folds a retired skin id from older storage back to the default", () => {
    // 2026-07-20: the seven extra skins left the catalog. A browser that
    // still stores one must land on the brand default, other prefs intact.
    for (const retired of ["classic", "nebula", "nocturne", "obsidian", "staffwise", "neon-riot", "prisma"]) {
      const p = parsePrefs(JSON.stringify({ design: retired, particles: false }));
      expect(p.design).toBe("spectroscope");
      expect(p.particles).toBe(false);
    }
  });

  it("accepts the white light design (still) and round-trips it", () => {
    expect(parsePrefs(JSON.stringify({ design: "still" })).design).toBe("still");
    setDraft({ design: "still" });
    saveDesign();
    expect(JSON.parse(store.get(KEY) ?? "{}").design).toBe("still");
    expect(lastApplied().design).toBe("still");
  });

  it("applyAndSaveDesign persists in ONE step and leaves nothing dirty", () => {
    // The settings page contract (owner): a design choice must survive a
    // reload WITHOUT an extra save step — draft and saved move together.
    applyAndSaveDesign({ design: "still" });
    expect(JSON.parse(store.get(KEY) ?? "{}").design).toBe("still");
    expect(lastApplied().design).toBe("still");
    expect(isDirty()).toBe(false);

    applyAndSaveDesign({ particles: false });
    expect(JSON.parse(store.get(KEY) ?? "{}").particles).toBe(false);
    expect(isDirty()).toBe(false);
  });

  it("parsePrefs is null- and garbage-safe", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
  });
});
