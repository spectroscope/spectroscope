// Card 298. The handle is the claim under test: it is SHORT, it is STABLE, and
// it never leaks an opaque agent id into anything a person reads. Every test
// below bites one of those three.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { AGENT_RAMP_SLOTS, agentDirectory, agentTagColor } from "./agentDirectory";

const start = (agentId: string, ts: number, model?: string): RunEvent => ({
  type: "run_start",
  runId: `r-${agentId}`,
  agentId,
  ...(agentId === "main" ? {} : { parentId: "main" }),
  prompt: "go",
  ...(model === undefined ? {} : { model }),
  ts,
});

const spawn = (agentId: string, task: string, ts: number, parentId = "main"): RunEvent => ({
  type: "agent_spawn",
  agentId,
  parentId,
  task,
  ts,
});

const delta = (agentId: string, ts: number): RunEvent => ({
  type: "text_delta",
  agentId,
  text: "…",
  ts,
});

const task = (to: string, text: string, ts: number, label?: string): RunEvent => ({
  type: "agent_message",
  from: "main",
  to,
  role: "task",
  text,
  ...(label === undefined ? {} : { label }),
  ts,
});

/** Root, then three children in a deliberate spawn order. */
function run(): RunEvent[] {
  return [
    start("main", 0),
    spawn("toolu_01aaa", "scout the checkout", 10),
    spawn("toolu_01bbb", "read the ledger", 20),
    delta("toolu_01aaa", 30),
    spawn("toolu_01ccc", "write the report", 40),
    delta("toolu_01ccc", 50),
  ];
}

describe("agentDirectory — every agent gets a handle", () => {
  it("tags the root main and the children w1..wN in first-appearance order", () => {
    const dir = agentDirectory(run());
    expect(dir.get("main")?.tag).toBe("main");
    expect(dir.get("toolu_01aaa")?.tag).toBe("w1");
    expect(dir.get("toolu_01bbb")?.tag).toBe("w2");
    expect(dir.get("toolu_01ccc")?.tag).toBe("w3");
  });

  it("names a child by the spawn task and never by its opaque id", () => {
    const dir = agentDirectory(run());
    expect(dir.get("toolu_01aaa")?.name).toBe("scout the checkout");
    expect(dir.get("toolu_01aaa")?.title).toBe("scout the checkout");
    expect(JSON.stringify([...dir.values()])).not.toContain("toolu_01aaa");
  });

  it("carries the parent and the child's own model", () => {
    const events = [...run(), start("toolu_01bbb", 60, "a-model")];
    const dir = agentDirectory(events);
    expect(dir.get("toolu_01bbb")?.parentId).toBe("main");
    expect(dir.get("toolu_01bbb")?.model).toBe("a-model");
    expect(dir.get("main")?.parentId).toBeNull();
  });

  it("nests: a grandchild names its real parent, and is still tagged in appearance order", () => {
    const events = [...run(), spawn("toolu_01ddd", "sub-scout", 60, "toolu_01aaa")];
    const dir = agentDirectory(events);
    expect(dir.get("toolu_01ddd")?.parentId).toBe("toolu_01aaa");
    expect(dir.get("toolu_01ddd")?.tag).toBe("w4");
  });

  // ---- determinism: the three properties a later panel will lean on --------
  it("is a function of the prefix: the same prefix yields the same tags twice", () => {
    const a = agentDirectory(run());
    const b = agentDirectory(run());
    expect(a.size).toBe(4);
    expect([...b].map(([id, h]) => [id, h.tag])).toEqual([...a].map(([id, h]) => [id, h.tag]));
  });

  it("a later child never renumbers an earlier one — every prefix agrees with the whole", () => {
    const events = run();
    const whole = agentDirectory(events);
    expect([...whole.values()].map((h) => h.tag)).toEqual(["main", "w1", "w2", "w3"]);
    for (let k = 0; k <= events.length; k++) {
      const early = agentDirectory(events, k);
      for (const [id, handle] of early) {
        expect(whole.get(id)?.tag, `prefix ${k}, agent ${id}`).toBe(handle.tag);
      }
    }
  });

  it("upto cuts the prefix: an agent past the cut is not in the directory yet", () => {
    const events = run();
    const early = agentDirectory(events, 3);
    expect(early.has("toolu_01aaa")).toBe(true);
    expect(early.has("toolu_01ccc")).toBe(false);
  });

  // ---- the honest placeholder ---------------------------------------------
  it("an agent with no spawn frame still gets a tag and an honest placeholder name", () => {
    const events: RunEvent[] = [start("main", 0), delta("toolu_01zzz", 10)];
    const dir = agentDirectory(events);
    const handle = dir.get("toolu_01zzz");
    expect(handle?.tag).toBe("w1");
    expect(handle?.title).toBeNull();
    expect(handle?.name).toBe("w1");
    expect(handle?.name).not.toContain("toolu_01zzz");
  });

  it("a child named only by a task message is named by that task, not by its id", () => {
    const events: RunEvent[] = [start("main", 0), task("toolu_01yyy", "check the premise", 10, "app-scout")];
    const dir = agentDirectory(events);
    expect(dir.get("toolu_01yyy")?.tag).toBe("w1");
    expect(dir.get("toolu_01yyy")?.name).toBe("check the premise");
  });

  it("falls back to the agent type when the task is empty, then to the tag", () => {
    const events: RunEvent[] = [start("main", 0), spawn("a", "", 10), task("a", "", 20, "build_plan"), spawn("b", "", 30)];
    const dir = agentDirectory(events);
    expect(dir.get("a")?.name).toBe("build_plan");
    expect(dir.get("b")?.name).toBe("w2");
  });

  it("clips a long name to the display width with a middle ellipsis, keeping the title whole", () => {
    const long = "a very long worker title that keeps going and going";
    const dir = agentDirectory([start("main", 0), spawn("a", long, 10)]);
    expect(dir.get("a")?.name.length).toBeLessThanOrEqual(24);
    expect(dir.get("a")?.name).toContain("…");
    expect(dir.get("a")?.title).toBe(long);
  });

  it("a root that does not call itself main is still tagged main", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r0", agentId: "sub-7", prompt: "go", ts: 0 },
      spawn("kid", "do it", 10, "sub-7"),
    ];
    const dir = agentDirectory(events);
    expect(dir.get("sub-7")?.tag).toBe("main");
    expect(dir.get("kid")?.tag).toBe("w1");
  });

  it("lists the root even when no event has named it yet", () => {
    const dir = agentDirectory([]);
    expect(dir.get("main")?.tag).toBe("main");
    expect(dir.get("main")?.firstSeen).toBe(-1);
  });

  it("firstSeen is the index of the first event naming the agent", () => {
    const dir = agentDirectory(run());
    expect(dir.get("main")?.firstSeen).toBe(0);
    expect(dir.get("toolu_01aaa")?.firstSeen).toBe(1);
    expect(dir.get("toolu_01ccc")?.firstSeen).toBe(4);
  });
});

describe("agentTagColor — one ramp slot per tag, the same in every surface", () => {
  it("gives the root the root accent", () => {
    expect(agentTagColor("main")).toBe("var(--agent-root)");
  });

  it("gives w1..w5 the five ramp slots, in order", () => {
    expect([1, 2, 3, 4, 5].map((i) => agentTagColor(`w${i}`))).toEqual([
      "var(--agent-w1)",
      "var(--agent-w2)",
      "var(--agent-w3)",
      "var(--agent-w4)",
      "var(--agent-w5)",
    ]);
  });

  it("wraps past the last slot instead of running out of colours", () => {
    expect(AGENT_RAMP_SLOTS).toBe(5);
    expect(agentTagColor("w6")).toBe("var(--agent-w1)");
    expect(agentTagColor("w11")).toBe("var(--agent-w1)");
  });

  it("returns a constant token name, never session data", () => {
    expect(agentTagColor("toolu_01aaa")).toBe("var(--agent-extra)");
  });
});
