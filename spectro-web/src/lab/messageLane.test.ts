// Card 301A. The handovers between agents — what was actually SAID, which way
// it went, how big it was, and which task it answers.
//
// The three claims each test below bites one of:
//
//   1. DIRECTION COMES FROM THE SPAWN TREE, not from the role word. The role is
//      the fallback and only the fallback, because a stream may carry a role
//      that disagrees with who spawned whom — and the tree is the fact.
//   2. NOTHING IS RE-DERIVED. Handles come from agentDirectory (card 298), lane
//      numbers from foldWork (state/work.ts), phase rows from groupWaves.
//   3. EVERY ROW CARRIES ITS EVENT, so a click can land the trace on it.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { messageLanes } from "./messageLane";

const start = (agentId: string, ts: number, parentId?: string): RunEvent => ({
  type: "run_start",
  runId: `r-${agentId}`,
  agentId,
  ...(parentId === undefined ? {} : { parentId }),
  prompt: "go",
  ts,
});

const spawn = (agentId: string, task: string, ts: number, parentId = "main"): RunEvent => ({
  type: "agent_spawn",
  agentId,
  parentId,
  task,
  ts,
});

const msg = (
  from: string,
  to: string,
  role: string,
  text: string,
  ts: number,
  state = "working",
): RunEvent => ({ type: "agent_message", from, to, role, state, text, ts });

const usage = (agentId: string, i: number, o: number, ts: number): RunEvent =>
  ({ type: "usage", agentId, inputTokens: i, outputTokens: o, ts }) as unknown as RunEvent;

/** main spawns one child, tasks it, it reports status then a result. */
function conversation(): RunEvent[] {
  return [
    start("main", 0),
    spawn("kid", "scout the checkout", 10),
    msg("main", "kid", "task", "scout the checkout", 11, "submitted"),
    start("kid", 12, "main"),
    msg("kid", "main", "status", "halfway", 20),
    msg("kid", "main", "result", "found three", 30, "completed"),
  ];
}

describe("messageLanes — direction comes from the spawn tree", () => {
  it("calls parent -> child down and child -> parent up", () => {
    const { messages } = messageLanes(conversation());
    expect(messages.map((m) => m.direction)).toEqual(["down", "up", "up"]);
  });

  it("uses the TREE even when the role word disagrees with it", () => {
    // A "result" that in fact runs parent -> child. The spawn tree says down;
    // the role word would say up. The tree wins.
    const events = [start("main", 0), spawn("kid", "t", 10), msg("main", "kid", "result", "here you go", 20)];
    const { messages } = messageLanes(events);
    expect(messages[0].direction).toBe("down");
  });

  it("falls back to the role word only when the tree cannot say", () => {
    // Two agents with no spawn relation between them at all.
    const events = [
      start("main", 0),
      spawn("a", "ta", 5),
      spawn("b", "tb", 6),
      msg("a", "b", "task", "do this", 20),
      msg("a", "b", "result", "done", 30),
      msg("a", "b", "status", "mid", 40),
    ];
    const { messages } = messageLanes(events);
    expect(messages.map((m) => m.direction)).toEqual(["down", "up", "up"]);
    expect(messages.map((m) => m.fromTree)).toEqual([false, false, false]);
  });

  it("marks a direction the tree decided, so a reader can tell the two apart", () => {
    const { messages } = messageLanes(conversation());
    expect(messages.map((m) => m.fromTree)).toEqual([true, true, true]);
  });
});

describe("messageLanes — the text, the size and the task answered", () => {
  it("carries the text verbatim and its size", () => {
    const { messages } = messageLanes(conversation());
    expect(messages[2].text).toBe("found three");
    expect(messages[2].chars).toBe("found three".length);
  });

  it("points every answer back at the task message it answers", () => {
    const { messages } = messageLanes(conversation());
    // The task itself answers nothing.
    expect(messages[0].answers).toBeNull();
    // Both replies answer the task at prefix index 2.
    expect(messages[1].answers).toBe(2);
    expect(messages[2].answers).toBe(2);
  });

  it("answers the LATEST task to that agent, not the first", () => {
    const events = [
      start("main", 0),
      spawn("kid", "t", 5),
      msg("main", "kid", "task", "first job", 10),
      msg("kid", "main", "result", "one done", 20),
      msg("main", "kid", "task", "second job", 30),
      msg("kid", "main", "result", "two done", 40),
    ];
    const { messages } = messageLanes(events);
    expect(messages[1].answers).toBe(2);
    expect(messages[3].answers).toBe(4);
  });

  it("lets a tasked child task a grandchild without that task answering anything", () => {
    // The nested-dispatch case. w1 is tasked, and then hands work DOWN itself.
    // Its outgoing task is not a reply to the task it received, and saying so
    // would draw an answer edge that never happened.
    const events = [
      start("main", 0),
      spawn("kid", "outer", 5),
      msg("main", "kid", "task", "outer", 10),
      spawn("grandkid", "inner", 15, "kid"),
      msg("kid", "grandkid", "task", "inner", 20),
      msg("kid", "main", "result", "outer done", 30, "completed"),
    ];
    const { messages } = messageLanes(events);
    expect(messages[1].role).toBe("task");
    expect(messages[1].direction).toBe("down");
    expect(messages[1].answers).toBeNull();
    // The genuine reply still points back at the task it answers.
    expect(messages[2].answers).toBe(2);
  });

  it("carries the event itself, so a click can land the trace on it", () => {
    const events = conversation();
    const { messages } = messageLanes(events);
    expect(messages[2].event).toBe(events[5]);
    expect(messages[2].index).toBe(5);
  });
});

describe("messageLanes — handles come from the directory, never derived here", () => {
  it("tags the root main and a child w1, and names the lane by its task", () => {
    const { lanes } = messageLanes(conversation());
    expect(lanes).toHaveLength(1);
    expect(lanes[0].tag).toBe("w1");
    expect(lanes[0].name).toBe("scout the checkout");
    const { messages } = messageLanes(conversation());
    expect(messages[0].fromTag).toBe("main");
    expect(messages[0].toTag).toBe("w1");
  });

  it("never prints an opaque agent id as a handle", () => {
    const events = [
      start("main", 0),
      spawn("toolu_01xyzopaque", "read the ledger", 10),
      msg("main", "toolu_01xyzopaque", "task", "read the ledger", 11),
    ];
    const { lanes, messages } = messageLanes(events);
    expect(lanes[0].tag).toBe("w1");
    expect(messages[0].toTag).toBe("w1");
    expect(lanes[0].name).not.toContain("toolu_");
  });
});

describe("messageLanes — the numbers come from foldWork", () => {
  it("joins each lane to the work fold's own counters", () => {
    const events = [
      ...conversation(),
      usage("kid", 120, 34, 25),
      { type: "tool_call", agentId: "kid", callId: "c1", name: "Read", input: {}, ts: 26 } as RunEvent,
    ];
    const { lanes } = messageLanes(events);
    expect(lanes[0].inTokens).toBe(120);
    expect(lanes[0].outTokens).toBe(34);
    expect(lanes[0].toolCalls).toBe(1);
    expect(lanes[0].state).toBe("completed");
    expect(lanes[0].lastStatus).toBe("halfway");
    expect(lanes[0].intent).toBe("scout the checkout");
  });

  it("hands back the work fold's waves as phase rows", () => {
    const events = [
      start("main", 0),
      spawn("a", "ta", 10),
      msg("main", "a", "task", "ta", 11),
      msg("a", "main", "result", "done", 20, "completed"),
      // b starts after a finished: a second wave, not the same one.
      spawn("b", "tb", 60),
      msg("main", "b", "task", "tb", 61),
      msg("b", "main", "result", "done", 70, "completed"),
    ];
    const { waves } = messageLanes(events);
    expect(waves).toHaveLength(2);
    expect(waves[0].items.map((i) => i.id)).toEqual(["a"]);
    expect(waves[1].items.map((i) => i.id)).toEqual(["b"]);
  });
});

describe("messageLanes — lanes and grouping", () => {
  it("files a message under the CHILD side of the handover", () => {
    const { lanes } = messageLanes(conversation());
    expect(lanes[0].agentId).toBe("kid");
    expect(lanes[0].messages.map((m) => m.role)).toEqual(["task", "status", "result"]);
  });

  it("keeps one lane per child, in first-appearance order", () => {
    const events = [
      start("main", 0),
      spawn("a", "ta", 10),
      spawn("b", "tb", 20),
      msg("main", "b", "task", "tb", 21),
      msg("main", "a", "task", "ta", 22),
    ];
    const { lanes } = messageLanes(events);
    expect(lanes.map((l) => l.agentId)).toEqual(["a", "b"]);
    expect(lanes.map((l) => l.tag)).toEqual(["w1", "w2"]);
  });

  it("reports an empty lane list for a run that handed nothing over", () => {
    const { lanes, messages } = messageLanes([start("main", 0)]);
    expect(lanes).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe("messageLanes — the scrub cursor", () => {
  it("reads exactly the prefix, so upto is slice(0, upto)", () => {
    const events = conversation();
    expect(messageLanes(events, 3).messages).toHaveLength(1);
    expect(messageLanes(events, 5).messages).toHaveLength(2);
    expect(messageLanes(events, 6).messages).toHaveLength(3);
    expect(messageLanes(events, -1).messages).toEqual([]);
    // The handle a message carries is the handle at THAT cursor, and a tag
    // never moves once assigned.
    expect(messageLanes(events, 3).messages[0].toTag).toBe("w1");
  });
});
