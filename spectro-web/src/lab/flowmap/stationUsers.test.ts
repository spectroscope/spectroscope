import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { agentDirectory } from "../agentDirectory";
import { advanceScene, initialLoop, initialScene, type Scene, type SubagentInfo } from "../labScene";
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

// ---------------------------------------------------------------------------
// Card 298: the tag comes from the directory instead of a live array index.
// ---------------------------------------------------------------------------

const fold = (events: RunEvent[]): Scene => events.reduce((sc, e) => advanceScene(sc, e), initialScene());

/** A child spawned, then put on the disk station by a read. */
const onDisk = (id: string, task: string, ts: number): RunEvent[] => [
  { type: "agent_spawn", agentId: id, parentId: "main", task, ts },
  {
    type: "tool_call",
    agentId: id,
    callId: `c-${id}`,
    name: "Read",
    input: { file_path: "a.txt" },
    ts: ts + 1,
  },
];

describe("stationUsers reads its tag from the agent directory", () => {
  it("prints the same line the local derivation did, for an ordinary session", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      ...onDisk("toolu_01aaa", "scout the checkout", 10),
      ...onDisk("toolu_01bbb", "read the ledger", 20),
    ];
    const scene = fold(events);
    const withDir = stationUsers(scene, "disk", agentDirectory(events));
    expect(withDir).toEqual(stationUsers(scene, "disk"));
    expect(withDir.map((u) => u.tag)).toEqual(["w1", "w2"]);
    expect(JSON.stringify(withDir)).not.toContain("toolu_01aaa");
  });

  it("keeps the tag while the scene's array index moves under it", () => {
    // The tag is folded from the prefix, so it does not depend on where the
    // child sits in scene.subagents at the moment of the draw.
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "first", parentId: "main", task: "one", ts: 10 },
      ...onDisk("second", "two", 20),
    ];
    const dir = agentDirectory(events);
    const scene = fold(events);
    expect(stationUsers(scene, "disk", dir)).toEqual([{ tag: "w2", name: "two" }]);
    // Same child, same tag, from a scene that never saw the first sibling.
    const lonely = fold(events.filter((e) => !("agentId" in e) || e.agentId !== "first"));
    expect(stationUsers(lonely, "disk", dir)).toEqual([{ tag: "w2", name: "two" }]);
    expect(stationUsers(lonely, "disk")).toEqual([{ tag: "w1", name: "two" }]);
  });

  it("tags a sidecar transcript's OWN root main, where the index called it w1", () => {
    // A standalone subagent transcript roots at its own id and its run_start
    // carries no parentId (claudeCode.ts). labScene reads the literal "main",
    // so that root lands in scene.subagents and the index numbered it as a
    // worker. The directory knows it is the root.
    const events: RunEvent[] = [
      { type: "run_start", runId: "cc-import", agentId: "sub-7", prompt: "go", ts: 0 },
      {
        type: "tool_call",
        agentId: "sub-7",
        callId: "c1",
        name: "Read",
        input: { file_path: "a.txt" },
        ts: 1,
      },
    ];
    const scene = fold(events);
    expect(scene.subagents.map((c) => c.id)).toEqual(["sub-7"]);
    expect(stationUsers(scene, "disk")).toEqual([{ tag: "w1", name: "w1" }]);
    expect(stationUsers(scene, "disk", agentDirectory(events))).toEqual([{ tag: "main", name: "main" }]);
  });

  it("falls back to the local derivation for a scene with no event prefix", () => {
    // The edu sim drives the scene directly and has no events to fold.
    const s = sceneWith({ subagents: [child("a", "first", { focus: "disk" })] });
    expect(stationUsers(s, "disk", agentDirectory([]))).toEqual([{ tag: "w1", name: "first" }]);
  });
});
