// The client half of the ladder. Two things carry real risk here and both are
// pinned below: what the six-slot spectrum strip shows at each level, and which
// surfaces a lock may cover. The second one is a safety question — the gate bar
// and the settings must render at every level, or a locked home could neither
// answer a permission request nor reach the key field that would unlock it.
import { describe, expect, it } from "vitest";
import { isSurfaceOpen, levelName, newlyOpened, slotKinds, type LevelingSnapshot } from "./leveling";

const LADDER: LevelingSnapshot["ladder"] = {
  schemaVersion: 1,
  levels: [
    {
      index: 0,
      id: "dark-frame",
      nameKey: "k",
      blurbKey: "k",
      opens: ["chat", "settings"],
      advanceWhen: ["provider-ready"],
    },
    {
      index: 1,
      id: "first-light",
      nameKey: "k",
      blurbKey: "k",
      opens: ["sessions", "files"],
      advanceWhen: ["first-run-complete"],
    },
    {
      index: 2,
      id: "the-trace",
      nameKey: "k",
      blurbKey: "k",
      opens: ["trace", "text"],
      advanceWhen: ["trace-opened"],
    },
    {
      index: 3,
      id: "the-gate",
      nameKey: "k",
      blurbKey: "k",
      opens: ["permission-mode"],
      advanceWhen: ["mode-set"],
    },
    {
      index: 4,
      id: "the-prism",
      nameKey: "k",
      blurbKey: "k",
      opens: ["spectrum", "lab", "graph"],
      advanceWhen: ["lens-used"],
    },
    {
      index: 5,
      id: "the-fleet",
      nameKey: "k",
      blurbKey: "k",
      opens: ["fleets"],
      advanceWhen: ["fleet-entered"],
    },
    { index: 6, id: "deep-field", nameKey: "k", blurbKey: "k", opens: ["explain"], advanceWhen: [] },
  ],
  criteria: [],
};

function snap(level: number, mode: LevelingSnapshot["mode"] = "ladder"): LevelingSnapshot {
  return {
    mode,
    level,
    levelId: LADDER.levels[level].id,
    ladder: LADDER,
    marks: {},
    remaining: [],
    history: [],
  };
}

describe("the spectrum strip", () => {
  it("is six slots at every level", () => {
    for (let level = 0; level <= 6; level++) {
      expect(slotKinds(level)).toHaveLength(6);
    }
  });

  it("is empty in the dark frame", () => {
    expect(slotKinds(0)).toEqual(["empty", "empty", "empty", "empty", "empty", "empty"]);
  });

  it("gains one line per level reached", () => {
    expect(slotKinds(1)).toEqual(["line", "empty", "empty", "empty", "empty", "empty"]);
    expect(slotKinds(3)).toEqual(["line", "line", "line", "empty", "empty", "empty"]);
    expect(slotKinds(5)).toEqual(["line", "line", "line", "line", "line", "empty"]);
  });

  it("holds the full band at the top of the ladder", () => {
    expect(slotKinds(6)).toEqual(["line", "line", "line", "line", "line", "band"]);
  });
});

describe("what a lock may cover", () => {
  it("opens everything that this level and the ones below it opened", () => {
    const at2 = snap(2);
    expect(isSurfaceOpen(at2, "chat")).toBe(true);
    expect(isSurfaceOpen(at2, "sessions")).toBe(true);
    expect(isSurfaceOpen(at2, "trace")).toBe(true);
  });

  it("closes what is still ahead", () => {
    const at2 = snap(2);
    expect(isSurfaceOpen(at2, "spectrum")).toBe(false);
    expect(isSurfaceOpen(at2, "fleets")).toBe(false);
    expect(isSurfaceOpen(at2, "explain")).toBe(false);
  });

  it("never locks the settings, at any level, in any mode", () => {
    // The keys live there. A home that cannot reach its settings cannot become
    // a home that has a provider, and the ladder would have locked its own exit.
    expect(isSurfaceOpen(snap(0), "settings")).toBe(true);
    expect(isSurfaceOpen(snap(0, "ladder"), "settings")).toBe(true);
  });

  it("never locks the gate, at any level, in any mode", () => {
    // A permission request is a safety surface. If one fires at level 0 it renders
    // and it works, or the agent sits blocked behind a teaser.
    expect(isSurfaceOpen(snap(0), "gate")).toBe(true);
    expect(isSurfaceOpen(snap(1), "gate")).toBe(true);
  });

  it("opens everything in checklist mode", () => {
    const list = snap(0, "checklist");
    for (const surface of ["trace", "spectrum", "fleets", "explain", "lab"]) {
      expect(isSurfaceOpen(list, surface)).toBe(true);
    }
  });

  it("opens everything when leveling is off", () => {
    const off = snap(0, "off");
    for (const surface of ["trace", "spectrum", "fleets", "explain"]) {
      expect(isSurfaceOpen(off, surface)).toBe(true);
    }
  });

  it("opens a surface the ladder has never heard of", () => {
    // A surface added by a newer build, or one that simply is not part of the
    // ladder, must render. Locks are an allow-list of seven, not a deny-all.
    expect(isSurfaceOpen(snap(0), "some-new-tab")).toBe(true);
  });

  it("treats a missing snapshot as fully open", () => {
    expect(isSurfaceOpen(null, "spectrum")).toBe(true);
  });
});

describe("what may be reported as seen", () => {
  it("a locked surface is not a shown surface", () => {
    // The beacon rule reads from the same function the renderer does. If a click
    // on a locked tab could report the surface, the tab would unlock itself and
    // the ladder would be a formality.
    const at1 = snap(1);
    expect(isSurfaceOpen(at1, "trace")).toBe(false);
    expect(isSurfaceOpen(at1, "sessions")).toBe(true);
  });
});

describe("the level-up moment", () => {
  it("names what a climb just opened", () => {
    expect(newlyOpened(LADDER, 1, 2)).toEqual(["trace", "text"]);
  });

  it("names everything opened across a multi-level climb", () => {
    expect(newlyOpened(LADDER, 2, 4)).toEqual(["permission-mode", "spectrum", "lab", "graph"]);
  });

  it("says nothing when the level did not move", () => {
    expect(newlyOpened(LADDER, 3, 3)).toEqual([]);
  });

  it("says nothing on a reset back down the ladder", () => {
    expect(newlyOpened(LADDER, 4, 0)).toEqual([]);
  });
});

describe("level names", () => {
  it("reads an id as its name so the terminal and the UI cannot drift", () => {
    expect(levelName("dark-frame")).toBe("dark frame");
    expect(levelName("the-gate")).toBe("the gate");
  });
});
