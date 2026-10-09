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
  it("answers the card's table, row by row, in all three modes", () => {
    // The card's table, 2026-09-25, plus the owner's decision of 17:25 that
    // the tab row itself is a surface that light shows only with the tutorial on.
    // Card 481: developer opens what learn opens, closes the tutorial the way
    // light does for the level pill, and adds the playbook module.
    const card: Record<SurfaceId, [string, string, string]> = {
      tabRow: ["open", "tutorial", "open"],
      chat: ["open", "open", "open"],
      spectrum: ["open", "gone", "open"],
      trace: ["open", "gone", "open"],
      graph: ["open", "gone", "open"],
      text: ["open", "gone", "open"],
      lab: ["open", "gone", "open"],
      newChat: ["open", "open", "open"],
      scenarios: ["open", "open", "open"],
      starters: ["open", "open", "open"],
      skills: ["open", "open", "open"],
      sessions: ["open", "open", "open"],
      fleets: ["open", "gone", "open"],
      stategraph: ["open", "gone", "open"],
      playbook: ["gone", "gone", "open"],
      dock: ["open", "open", "open"],
      leveling: ["open", "tutorial", "tutorial"],
      liveTraceSwitch: ["open", "gone", "open"],
      fleetSettings: ["open", "gone", "open"],
    };
    expect(Object.keys(SURFACES).sort()).toEqual(Object.keys(card).sort());
    for (const [id, [learn, light, developer]] of Object.entries(card) as [
      SurfaceId,
      [string, string, string],
    ][]) {
      expect(SURFACES[id].modes, id).toEqual({ learn, light, developer });
    }
  });

  it("opens the playbook in developer and nowhere else, in its own chunk", () => {
    expect(isOpen("playbook", "developer")).toBe(true);
    expect(isOpen("playbook", "learn")).toBe(false);
    expect(isOpen("playbook", "light")).toBe(false);
    expect(isOpen("playbook", "learn", true)).toBe(false);
    expect(SURFACES.playbook.chunks).toEqual(["playbook/PlaybookPane.tsx"]);
  });

  it("opens in developer every surface learn opens, except the level pill, which follows the tutorial", () => {
    for (const id of Object.keys(SURFACES) as SurfaceId[]) {
      if (SURFACES[id].modes.learn !== "open") continue;
      expect(isOpen(id, "developer", false), id).toBe(id !== "leveling");
    }
    expect(isOpen("leveling", "developer", false)).toBe(false);
    expect(isOpen("leveling", "developer", true)).toBe(true);
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

  it("shows the six tabs in developer, with the tutorial off as with it on", () => {
    expect(tabsShown("developer", false)).toEqual([...VIEW_TABS]);
    expect(tabsShown("developer", true)).toEqual([...VIEW_TABS]);
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
