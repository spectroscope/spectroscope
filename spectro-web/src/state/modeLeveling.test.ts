// Card 430, criterion 8: leveling and the mode are two axes, and where both
// speak the mode wins. For every level of the shipped ladder (0 to 6) and every
// leveling mode, a surface light closes stays closed in light: no tab, no nav
// row, no teaser, no address, no warm-up. The tutorial itself (the pill and the
// panel it opens) follows the owner's decision of 2026-09-25: reachable in
// light while the tutorial is on, gone while it is off.
//
// The ladder is read from the server's own resource, so a level that opens a
// new surface is checked the day it is added.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { navSegmentRows } from "../components/navRows";
import { isSurfaceOpen, LEVELING_MODES, type LevelingSnapshot } from "./leveling";
import { routeInMode } from "./modeRoute";
import { traceReachableIn } from "./modeWork";
import { parseAppRoute, VIEW_TABS, type ViewTab } from "./route";
import { isOpen, shownTab, SURFACES, tabsShown, tutorialOn, type SurfaceId } from "./surfaces";

const ladder = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../spectro-core/src/main/resources/leveling/levels.json", import.meta.url)),
    "utf8",
  ),
) as LevelingSnapshot["ladder"];

function snapshot(mode: LevelingSnapshot["mode"], level: number): LevelingSnapshot {
  return {
    mode,
    introSeen: true,
    level,
    levelId: ladder.levels[level].id,
    ladder,
    marks: {},
    remaining: [],
    history: [],
  };
}

/** Every surface the table closes in light, read off the table. */
const CLOSED = (Object.keys(SURFACES) as SurfaceId[]).filter((id) => SURFACES[id].modes.light === "gone");
const CLOSED_TABS = VIEW_TABS.filter((tab) => (CLOSED as string[]).includes(tab));

const EVERY = LEVELING_MODES.flatMap((mode) => [0, 1, 2, 3, 4, 5, 6].map((level) => snapshot(mode, level)));

describe("the ladder this test walks", () => {
  it("has the seven levels 0 to 6 and opens the surfaces light closes somewhere on it", () => {
    expect(ladder.levels.map((l) => l.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const tab of CLOSED_TABS) {
      expect(
        ladder.levels.some((l) => l.opens.includes(tab)),
        tab,
      ).toBe(true);
    }
    expect(CLOSED_TABS).toEqual(["spectrum", "graph", "trace", "text", "lab"]);
    expect(CLOSED).toEqual(
      expect.arrayContaining(["fleets", "stategraph", "liveTraceSwitch", "fleetSettings"]),
    );
  });
});

describe("the mode wins over every level and leveling mode (criterion 8)", () => {
  it("shows no closed tab in light, even where the level has opened it", () => {
    let openedByLevel = 0;
    for (const snap of EVERY) {
      const tabs = tabsShown("light", tutorialOn(snap));
      for (const tab of CLOSED_TABS) {
        if (isSurfaceOpen(snap, tab)) openedByLevel++;
        expect(tabs, `${snap.mode} ${snap.level} ${tab}`).not.toContain(tab);
      }
    }
    // A witness that the walk met levels that open these tabs at all.
    expect(openedByLevel).toBeGreaterThan(50);
  });

  it("shows the chat where a closed tab was chosen, so no teaser can stand for it", () => {
    for (const snap of EVERY) {
      for (const tab of CLOSED_TABS) {
        expect(shownTab(tab, "light"), `${snap.mode} ${snap.level} ${tab}`).toBe("chat");
      }
    }
  });

  it("lists no fleet or state graph row in light, locked or not", () => {
    for (const snap of EVERY) {
      const rows = navSegmentRows({
        active: "sessions",
        fleetsLocked: !isSurfaceOpen(snap, "fleets"),
        fleetCount: 2,
        mode: "light",
      }).map((r) => r.id);
      expect(rows, `${snap.mode} ${snap.level}`).toEqual(["sessions"]);
    }
  });

  it("rewrites every address into a closed tab, and arms no warm-up", () => {
    for (const snap of EVERY) {
      for (const tab of CLOSED_TABS) {
        expect(routeInMode(parseAppRoute(`#/${tab}`), "light")).toEqual({ kind: "live", tab: null });
      }
      expect(
        traceReachableIn({
          mode: "light",
          nav: "sessions",
          skillsOpen: false,
          enteredFleet: null,
          leveling: snap,
        }),
      ).toBe(false);
    }
  });

  it("keeps the tutorial reachable in light exactly while it is on", () => {
    for (const snap of EVERY) {
      const on = snap.mode !== "off";
      expect(isOpen("leveling", "light", tutorialOn(snap)), `${snap.mode} ${snap.level}`).toBe(on);
      expect(isOpen("tabRow", "light", tutorialOn(snap)), `${snap.mode} ${snap.level}`).toBe(on);
      expect(tabsShown("light", tutorialOn(snap))).toEqual(on ? ["chat"] : []);
    }
  });
});

describe("learn is unchanged (twin)", () => {
  it("shows the tab chosen, so the ladder's teaser decides as before", () => {
    for (const tab of VIEW_TABS as readonly ViewTab[]) expect(shownTab(tab, "learn")).toBe(tab);
    for (const snap of EVERY) expect(tabsShown("learn", tutorialOn(snap))).toEqual([...VIEW_TABS]);
  });

  it("keeps the fleets row, dimmed where the ladder locks it", () => {
    for (const snap of EVERY) {
      const rows = navSegmentRows({
        active: "sessions",
        fleetsLocked: !isSurfaceOpen(snap, "fleets"),
        fleetCount: 2,
        mode: "learn",
      });
      expect(rows.map((r) => r.id)).toEqual(["sessions", "fleets", "stategraph"]);
      expect(rows[1].disabled, `${snap.mode} ${snap.level}`).toBe(!isSurfaceOpen(snap, "fleets"));
    }
  });
});
