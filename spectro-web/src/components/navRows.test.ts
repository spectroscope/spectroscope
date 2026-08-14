// The rail's nav list, as a model rather than as JSX. Seven rows share one
// visual recipe, so what is worth pinning is not the markup but the decisions:
// which rows exist, what each one is called in both languages, which one is
// dimmed rather than dropped, and which row owns which row-level action.
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { navActionRows, navSegmentRows } from "./navRows";

describe("navActionRows", () => {
  const rows = navActionRows();

  it("keeps the three actions the rail has always opened with, in order", () => {
    expect(rows.map((r) => r.id)).toEqual(["newChat", "scenarios", "starters"]);
  });

  it("gives every row a label key that exists in both languages", () => {
    for (const row of rows) {
      expect(dict[row.labelKey], row.labelKey).toBeDefined();
      expect(dict[row.labelKey].de, `${row.labelKey}.de`).toBeTruthy();
      expect(dict[row.labelKey].en, `${row.labelKey}.en`).toBeTruthy();
      if (row.titleKey !== undefined) {
        expect(dict[row.titleKey], row.titleKey).toBeDefined();
        expect(dict[row.titleKey].de, `${row.titleKey}.de`).toBeTruthy();
        expect(dict[row.titleKey].en, `${row.titleKey}.en`).toBeTruthy();
      }
    }
  });

  it("names a distinct icon for every row, so no two read as the same control", () => {
    const icons = rows.map((r) => r.icon);
    expect(new Set(icons).size).toBe(rows.length);
  });

  it("carries no row-level action — those belong to the segments", () => {
    expect(rows.every((r) => r.trailing === null)).toBe(true);
  });
});

describe("navSegmentRows", () => {
  const at = (over: Partial<Parameters<typeof navSegmentRows>[0]> = {}) =>
    navSegmentRows({ active: "sessions", fleetsLocked: false, fleetCount: 0, ...over });

  it("keeps the segments in the order the strip had them, skills last", () => {
    // Browser joined as the fourth (card 201) rather than beside sessions: the
    // three that were here answer "what has run", and a browser the agent is
    // driving right now is a different question. Skills is the fifth (card
    // 225): the owner wants the installed capabilities one glance away, and a
    // catalogue is the furthest thing from "what has run", so it closes the
    // list.
    expect(at().map((r) => r.id)).toEqual(["sessions", "fleets", "stategraph", "browser", "skills"]);
  });

  it("lists the skills segment on every face, ungated and with no row action", () => {
    // The catalogue reads one endpoint and starts no process, so the fleet
    // lock has nothing to protect here — same reasoning as the state graph.
    // And it is the place you go to LOOK (card 225): the fast switches live
    // elsewhere, so the row carries no trailing affordance.
    const locked = at({ fleetsLocked: true });
    expect(locked.find((r) => r.id === "skills")?.disabled).toBe(false);
    expect(at({ active: "skills" }).find((r) => r.id === "skills")?.active).toBe(true);
    expect(at({ active: "skills" }).find((r) => r.id === "skills")?.trailing).toBe(null);
    expect(at().find((r) => r.id === "skills")?.trailing).toBe(null);
  });

  it("offers the browser row on every face, including the one with no pane", () => {
    // A row that vanished on the web face would leave a reader wondering
    // whether the product has a browser at all. The segment's own panel says
    // why there is nothing behind it.
    const browser = at().find((r) => r.id === "browser");
    expect(browser?.disabled).toBe(false);
    expect(at({ active: "browser" }).find((r) => r.id === "browser")?.active).toBe(true);
  });

  it("gives every row a label key that exists in both languages", () => {
    for (const row of at({ active: "fleets", fleetCount: 2 })) {
      expect(dict[row.labelKey], row.labelKey).toBeDefined();
      expect(dict[row.labelKey].de, `${row.labelKey}.de`).toBeTruthy();
      expect(dict[row.labelKey].en, `${row.labelKey}.en`).toBeTruthy();
    }
  });

  it("keeps fleets in the list, dimmed, when the ladder locks it", () => {
    // A feature nobody can see is a feature nobody adopts: the lock dims the
    // row, it does not remove it.
    const locked = at({ fleetsLocked: true });
    expect(locked.map((r) => r.id)).toContain("fleets");
    expect(locked.find((r) => r.id === "fleets")?.disabled).toBe(true);
    expect(at().find((r) => r.id === "fleets")?.disabled).toBe(false);
    // And the state graph is not gated on it — it reads two files off disk.
    expect(locked.find((r) => r.id === "stategraph")?.disabled).toBe(false);
  });

  it("hands Import to the sessions row and + node to the fleets row", () => {
    const onSessions = at({ active: "sessions" });
    expect(onSessions.find((r) => r.id === "sessions")?.trailing).toBe("import");
    expect(onSessions.find((r) => r.id === "fleets")?.trailing).not.toBe("spawn");

    const onFleets = at({ active: "fleets", fleetCount: 3 });
    expect(onFleets.find((r) => r.id === "fleets")?.trailing).toBe("spawn");
    expect(onFleets.find((r) => r.id === "sessions")?.trailing).not.toBe("import");
  });

  it("offers no second + node while the empty state carries its own", () => {
    // Two spawn affordances at once was the owner's complaint; with no fleets
    // the list's own empty state is the one that offers it.
    expect(at({ active: "fleets", fleetCount: 0 }).find((r) => r.id === "fleets")?.trailing).toBe(null);
  });

  it("counts the fleets on the row when the reader is looking elsewhere", () => {
    expect(at({ active: "sessions", fleetCount: 3 }).find((r) => r.id === "fleets")?.trailing).toBe("count");
  });

  it("marks exactly one segment active", () => {
    for (const active of ["sessions", "fleets", "stategraph", "skills"] as const) {
      const rows = at({ active });
      expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual([active]);
    }
  });
});
