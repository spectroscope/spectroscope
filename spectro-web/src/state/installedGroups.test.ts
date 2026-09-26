// Card 411, rule C: the installed skills are grouped the way card 410 groups
// the catalogue. Owner, 2026-09-25: "mach alle installierten Skills, alle
// Skills, die ich installiert habe, möchte ich auch eingeklappt haben, so wie
// unten die Pakete." One group per namespace, plus one for the skills that
// have none, computed from the rows of the latest `/api/skills` read.

import { describe, expect, it } from "vitest";
import { installedGroups, type InstalledSkill } from "./skillPacks";

const skill = (name: string, source: "user" | "project" = "user", disabled = false): InstalledSkill => {
  const colon = name.indexOf(":");
  return {
    name,
    folder: colon < 0 ? name : name.slice(colon + 1),
    pack: colon < 0 ? null : name.slice(0, colon),
    description: `${name} does one thing.`,
    source,
    disabled,
  };
};

/** The server lists by name: bare names and namespaced ones interleave. */
const ROWS: InstalledSkill[] = [
  skill("brainstorming"),
  skill("matt-pocock:grill-me"),
  skill("matt-pocock:handoff", "user", true),
  skill("spectroscope:research"),
  skill("superpowers:brainstorming", "project"),
  skill("verification"),
];

describe("installedGroups", () => {
  it("makes one group per namespace and one for the skills without one", () => {
    const groups = installedGroups(ROWS);
    expect(groups.map((g) => g.namespace)).toEqual([null, "matt-pocock", "spectroscope", "superpowers"]);
  });

  it("puts the skills without a namespace first, then the namespaces by name", () => {
    const groups = installedGroups([skill("zeta:z"), skill("alpha:a"), skill("solo")]);
    expect(groups.map((g) => g.namespace)).toEqual([null, "alpha", "zeta"]);
  });

  it("counts every row of a group, on or off, user or project", () => {
    const groups = installedGroups(ROWS);
    expect(groups.map((g) => g.count)).toEqual([2, 2, 1, 1]);
  });

  it("keeps the rows of a group in the order the server listed them", () => {
    const [none, mattPocock] = installedGroups(ROWS);
    expect(none.rows.map((r) => r.name)).toEqual(["brainstorming", "verification"]);
    expect(mattPocock.rows.map((r) => r.name)).toEqual(["matt-pocock:grill-me", "matt-pocock:handoff"]);
  });

  it("has no group for the skills without a namespace when every skill has one", () => {
    expect(installedGroups([skill("alpha:a")]).map((g) => g.namespace)).toEqual(["alpha"]);
  });

  it("has no group at all for an empty list", () => {
    expect(installedGroups([])).toEqual([]);
  });
});
