// Card 430, criterion 2: one table decides what is open in which mode. These
// tests read the table's answers; the guard that holds the RENDERED tab row
// and nav rows against the table is surfaces.guard.test.tsx.

import { describe, expect, it } from "vitest";
import { VIEW_TABS } from "./route";
import { SURFACES, isOpen, tabsShown, tutorialOn, type SurfaceId } from "./surfaces";
import type { LevelingSnapshot } from "./leveling";
import { VIEW_MODES } from "./viewMode";

/** A leveling snapshot in the given mode; nothing else in it matters here. */
function levelingIn(mode: LevelingSnapshot["mode"]): LevelingSnapshot {
  return {
    mode,
    introSeen: true,
    level: 0,
    levelId: "dark-frame",
    ladder: { schemaVersion: 1, levels: [], criteria: [] },
    marks: {},
    remaining: [],
    history: [],
  };
}

describe("the surface table (criterion 2)", () => {
  it("answers the card's table, row by row, in both modes", () => {
    // The card's table, 2026-09-25, plus the owner's decision of 17:25 that
    // the tab row itself is a surface that light shows only with the tutorial on.
    const card: Record<SurfaceId, [string, string]> = {
      tabRow: ["open", "tutorial"],
      chat: ["open", "open"],
      spectrum: ["open", "gone"],
      trace: ["open", "gone"],
      graph: ["open", "gone"],
      text: ["open", "gone"],
      lab: ["open", "gone"],
      newChat: ["open", "open"],
      scenarios: ["open", "open"],
      starters: ["open", "open"],
      skills: ["open", "open"],
      sessions: ["open", "open"],
      fleets: ["open", "gone"],
      stategraph: ["open", "gone"],
      dock: ["open", "open"],
      leveling: ["open", "tutorial"],
      liveTraceSwitch: ["open", "gone"],
      fleetSettings: ["open", "gone"],
    };
    expect(Object.keys(SURFACES).sort()).toEqual(Object.keys(card).sort());
    for (const [id, [learn, light]] of Object.entries(card) as [SurfaceId, [string, string]][]) {
      expect(SURFACES[id].modes, id).toEqual({ learn, light });
    }
  });

  it("holds every view tab", () => {
    for (const tab of VIEW_TABS) expect(SURFACES[tab], tab).toBeDefined();
  });

  it("opens a surface marked open in every mode, whatever the tutorial says", () => {
    for (const mode of VIEW_MODES) {
      for (const tutorial of [false, true]) {
        expect(isOpen("chat", mode, tutorial)).toBe(true);
        expect(isOpen("sessions", mode, tutorial)).toBe(true);
        expect(isOpen("dock", mode, tutorial)).toBe(true);
      }
    }
  });

  it("closes a surface marked gone in light, whatever the tutorial says", () => {
    for (const tutorial of [false, true]) {
      for (const id of ["spectrum", "trace", "graph", "text", "lab", "fleets", "stategraph"] as const) {
        expect(isOpen(id, "light", tutorial), `${id} ${tutorial}`).toBe(false);
        expect(isOpen(id, "learn", tutorial), `${id} ${tutorial}`).toBe(true);
      }
    }
  });

  it("opens a tutorial surface in light only while the tutorial is on", () => {
    expect(isOpen("tabRow", "light", false)).toBe(false);
    expect(isOpen("tabRow", "light", true)).toBe(true);
    expect(isOpen("leveling", "light", false)).toBe(false);
    expect(isOpen("leveling", "light", true)).toBe(true);
    expect(isOpen("tabRow", "learn", false)).toBe(true);
  });
});

describe("the tab row", () => {
  it("shows the six tabs in learn, in route order", () => {
    expect(tabsShown("learn", false)).toEqual([...VIEW_TABS]);
    expect(tabsShown("learn", true)).toEqual([...VIEW_TABS]);
  });

  it("is gone in light with the tutorial off, and holds the chat alone with it on", () => {
    expect(tabsShown("light", false)).toEqual([]);
    expect(tabsShown("light", true)).toEqual(["chat"]);
  });
});

describe("what counts as the tutorial being on", () => {
  it("is a leveling mode other than off, the state in which the level pill renders", () => {
    expect(tutorialOn(null)).toBe(false);
    expect(tutorialOn(undefined)).toBe(false);
    expect(tutorialOn(levelingIn("off"))).toBe(false);
    expect(tutorialOn(levelingIn("ladder"))).toBe(true);
    expect(tutorialOn(levelingIn("checklist"))).toBe(true);
  });
});
