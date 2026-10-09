// The rail's nav list, as a model rather than as JSX. The rows share one
// visual recipe, so what is worth pinning is not the markup but the decisions:
// which rows exist, what each one is called in both languages, which one is
// dimmed rather than dropped, and which row owns which row-level action.
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { navActionRows, navSegmentRows } from "./navRows";

describe("navActionRows", () => {
  const rows = navActionRows({ skillsOpen: false });

  it("opens with the three actions it always had, then Skills (card 409)", () => {
    // Skills joined the upper group on 2026-09-24: a thing you open beside the
    // session list, like Scenarios and Starters, not a segment that swaps it.
    expect(rows.map((r) => r.id)).toEqual(["newChat", "scenarios", "starters", "skills"]);
  });

  it("keeps the Skills row ungated and with no row action", () => {
    // The catalogue reads one endpoint and starts no process, so the fleet
    // lock has nothing to protect here, the same reasoning as the state graph.
    for (const skillsOpen of [false, true]) {
      const skills = navActionRows({ skillsOpen }).find((r) => r.id === "skills");
      expect(skills?.disabled, String(skillsOpen)).toBe(false);
      expect(skills?.trailing, String(skillsOpen)).toBe(null);
    }
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

  it("keeps the three segments in the order the strip had them", () => {
    // The browser left with card 228: the rail lists places you go, and the
    // browser is a thing a SESSION has (card 218's own rule). Skills left with
    // card 409: it opens beside the list instead of swapping it, so it sits in
    // the upper group now.
    expect(at().map((r) => r.id)).toEqual(["sessions", "fleets", "stategraph"]);
  });

  it("adds the playbook segment last in developer, and only there (card 481)", () => {
    expect(at({ mode: "developer" }).map((r) => r.id)).toEqual([
      "sessions",
      "fleets",
      "stategraph",
      "playbook",
    ]);
    expect(at({ mode: "learn" }).map((r) => r.id)).toEqual(["sessions", "fleets", "stategraph"]);
    expect(at({ mode: "light" }).map((r) => r.id)).toEqual(["sessions"]);
    const playbook = at({ mode: "developer", active: "playbook" }).find((r) => r.id === "playbook");
    expect(playbook).toMatchObject({
      labelKey: "nav.playbook",
      icon: "playbook",
      disabled: false,
      active: true,
    });
    expect(playbook?.trailing).toBe(null);
    expect(dict["nav.playbook"]?.de).toBeTruthy();
    expect(dict["nav.playbook"]?.en).toBeTruthy();
    const icons = at({ mode: "developer" }).map((r) => r.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("lists no browser segment — the browser belongs to a session, not the rail", () => {
    // The owner spotted the contradiction in three words: the rail's browser
    // door opened a browser that belongs to NO session. The session tab
    // `browser` and the workspace's browser card are the doors that remain.
    expect(at().some((r) => String(r.id) === "browser")).toBe(false);
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

  it("hands + node to the fleets row; Import left the sessions row for the list's head (card 464)", () => {
    const onSessions = at({ active: "sessions" });
    expect(onSessions.find((r) => r.id === "sessions")?.trailing).toBeNull();
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
    for (const active of ["sessions", "fleets", "stategraph"] as const) {
      const rows = at({ active });
      expect(rows.filter((r) => r.active).map((r) => r.id)).toEqual([active]);
    }
  });
});

// Card 430: the rows come from the surface table, so light leaves out what it closes.
describe("the rows in light", () => {
  it("keeps the four upper rows", () => {
    expect(navActionRows({ skillsOpen: false, mode: "light" }).map((r) => r.id)).toEqual([
      "newChat",
      "scenarios",
      "starters",
      "skills",
    ]);
  });

  it("keeps the sessions segment alone", () => {
    const rows = navSegmentRows({ active: "sessions", fleetsLocked: false, fleetCount: 3, mode: "light" });
    expect(rows.map((r) => r.id)).toEqual(["sessions"]);
  });

  it("keeps all three segments in learn, the mode a caller without one gets", () => {
    const input = { active: "sessions" as const, fleetsLocked: false, fleetCount: 0 };
    expect(navSegmentRows({ ...input, mode: "learn" }).map((r) => r.id)).toEqual([
      "sessions",
      "fleets",
      "stategraph",
    ]);
    expect(navSegmentRows(input).map((r) => r.id)).toEqual(["sessions", "fleets", "stategraph"]);
  });
});
