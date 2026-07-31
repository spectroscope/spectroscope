import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetForTests,
  __setTestHooks,
  applyAndSaveDesign,
  DEFAULT_PREFS,
  DESIGNS,
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
  it("defaults to spectro white, whose look carries no particles", () => {
    expect(DEFAULT_PREFS.design).toBe("still");
    // The default must not contradict its own design: still declares no
    // particles, so the toggle starts off rather than lighting the settings
    // note that says the effect is on and the design has none.
    expect(DEFAULT_PREFS.particles).toBe(false);
    expect(readSaved()).toEqual(DEFAULT_PREFS);
    expect(isDirty()).toBe(false);
    expect(lastApplied()).toEqual(DEFAULT_PREFS); // reset applied the default
  });

  it("setDraft applies the new prefs and marks the store dirty", () => {
    setDraft({ design: "paper", particles: false });
    expect(lastApplied()).toEqual({
      design: "paper",
      scroll: true,
      particles: false,
      reasoningLens: false,
      timelineLens: false,
      otelRows: false,
    });
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
    expect(lastApplied()).toEqual({
      design: "still",
      scroll: true,
      particles: false,
      reasoningLens: false,
      timelineLens: false,
      otelRows: false,
    });
  });

  it("parsePrefs seeds from storage and rejects an unknown design id", () => {
    const p = parsePrefs(JSON.stringify({ design: "bogus", scroll: false, particles: false }));
    expect(p.design).toBe("still"); // unknown -> default
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

  it("timeline lens defaults OFF and an explicit choice sticks either way", () => {
    // Owner call 2026-07-23: the timing bars are on out of the box — a browser
    // that never touched the toggle sees them, one that switched them off keeps
    // them off. The trace-toolbar chip stays the one switch.
    // Card 69 made it default ON; the owner reversed that on 2026-07-27 after
    // living with it. An explicit stored value still wins in both directions.
    expect(DEFAULT_PREFS.timelineLens).toBe(false);
    expect(parsePrefs(JSON.stringify({ design: "paper" })).timelineLens).toBe(false);
    expect(parsePrefs(JSON.stringify({ timelineLens: true })).timelineLens).toBe(true);
    expect(parsePrefs(JSON.stringify({ timelineLens: false })).timelineLens).toBe(false);
    applyAndSaveDesign({ timelineLens: false });
    expect(JSON.parse(store.get(KEY) ?? "{}").timelineLens).toBe(false);
    expect(readSaved().timelineLens).toBe(false);
  });

  it("otel rows default OFF and an explicit on sticks (card 86)", () => {
    // The otlp_export mirror frames sit in the trace ring either way; the
    // chip only reveals them — off out of the box, a saved on survives.
    expect(DEFAULT_PREFS.otelRows).toBe(false);
    expect(parsePrefs(JSON.stringify({ design: "paper" })).otelRows).toBe(false);
    expect(parsePrefs(JSON.stringify({ otelRows: true })).otelRows).toBe(true);
    applyAndSaveDesign({ otelRows: true });
    expect(JSON.parse(store.get(KEY) ?? "{}").otelRows).toBe(true);
    expect(readSaved().otelRows).toBe(true);
  });

  it("folds a retired skin id from older storage back to the default", () => {
    // 2026-07-20: the seven extra skins left the catalog. A browser that
    // still stores one must land on the brand default, other prefs intact.
    for (const retired of ["classic", "nebula", "nocturne", "obsidian", "staffwise", "neon-riot", "prisma"]) {
      const p = parsePrefs(JSON.stringify({ design: retired, particles: false }));
      expect(p.design).toBe("still");
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

  it("accepts the cool dark design (graphite) and round-trips it", () => {
    expect(parsePrefs(JSON.stringify({ design: "graphite" })).design).toBe("graphite");
    setDraft({ design: "graphite" });
    saveDesign();
    expect(JSON.parse(store.get(KEY) ?? "{}").design).toBe("graphite");
    expect(lastApplied().design).toBe("graphite");
  });
});

describe("the catalog is the one list every surface reads", () => {
  // The picker, the settings block and the export dialog all map over DESIGNS.
  // These hold the three places that CANNOT map over it — the id union, the
  // export table and the pre-paint guard in index.html — to the same catalog,
  // so a fifth design is one entry rather than four edits and a bug report.
  it("offers the four designs, white first-run default unchanged", () => {
    expect(DESIGNS.map((d) => d.id)).toEqual(["spectroscope", "paper", "still", "graphite"]);
    expect(DEFAULT_PREFS.design).toBe("still");
  });

  it("gives every design a distinct swatch, so the picker rows are told apart", () => {
    const grounds = DESIGNS.map((d) => d.bg.toLowerCase());
    expect(new Set(grounds).size).toBe(DESIGNS.length);
  });

  it("index.html's FOUC guard knows every id the catalog offers", () => {
    // The guard runs before the bundle and cannot import: it carries a literal
    // copy of the id list. An id missing there is not a crash — the design
    // paints as espresso for one frame and then swaps, which reads as a flash
    // rather than as the bug it is.
    const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
    const list = /var ids = \[([^\]]*)\]/.exec(html);
    expect(list, "index.html no longer declares `var ids = [...]`").not.toBeNull();
    const ids = (list?.[1] ?? "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    expect(ids).toEqual(DESIGNS.map((d) => d.id));
  });
});
