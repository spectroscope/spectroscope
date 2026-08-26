import { describe, expect, it } from "vitest";
import { initialLoop, initialScene, type Scene, type SubagentInfo } from "../labScene";
import { stationUsers } from "./stationUsers";

const child = (id: string, task: string, patch: Partial<SubagentInfo> = {}): SubagentInfo => ({
  id,
  label: null,
  task,
  state: "working",
  lastStatus: null,
  ...initialLoop(),
  ...patch,
});

const sceneWith = (patch: Partial<Scene>): Scene => ({ ...initialScene(), ...patch });

describe("stationUsers", () => {
  it("names main when the main loop is on the station", () => {
    const s = sceneWith({ focus: "cmd" });
    expect(stationUsers(s, "cmd")).toEqual([{ tag: "main", name: "main" }]);
  });

  it("names a child by its task, tagged by spawn order, never by its id", () => {
    const s = sceneWith({
      subagents: [child("toolu_abc123", "Scout Flink checkout", { focus: "disk" })],
    });
    const users = stationUsers(s, "disk");
    expect(users).toEqual([{ tag: "w1", name: "Scout Flink checkout" }]);
    expect(JSON.stringify(users)).not.toContain("toolu_abc123");
  });

  it("orders two occupants main-first, then spawn order — the fold's own resolution", () => {
    const s = sceneWith({
      focus: "cmd",
      subagents: [child("a", "first"), child("b", "second", { focus: "cmd" })],
    });
    expect(stationUsers(s, "cmd").map((u) => u.tag)).toEqual(["main", "w2"]);
  });

  it("clips a long task to 24 with a middle ellipsis", () => {
    const s = sceneWith({
      subagents: [
        child("a", "a very long worker title that keeps going", {
          activeMcp: "notes · search",
        }),
      ],
    });
    const [u] = stationUsers(s, "mcp");
    expect(u.name.length).toBeLessThanOrEqual(24);
    expect(u.name).toContain("…");
  });

  it("the mcp station lists whoever HOLDS an active call, not focus alone", () => {
    const s = sceneWith({ subagents: [child("a", "t", { activeMcp: "notes · search" })] });
    expect(stationUsers(s, "mcp")).toHaveLength(1);
  });

  it("a child with an empty task falls back to its label, then to the tag", () => {
    const s = sceneWith({
      subagents: [child("a", "", { focus: "disk", label: "build_plan" }), child("b", "", { focus: "cmd" })],
    });
    expect(stationUsers(s, "disk")).toEqual([{ tag: "w1", name: "build_plan" }]);
    expect(stationUsers(s, "cmd")).toEqual([{ tag: "w2", name: "w2" }]);
  });

  it("returns empty when nobody is on the station", () => {
    expect(stationUsers(initialScene(), "disk")).toEqual([]);
  });
});
