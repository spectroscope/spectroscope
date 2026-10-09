// Card 490, criterion 4: a helper that waits for a free slot of its chat is
// shown as waiting.
//
// The server says it with an event the wire already has: an agent_message
// from the helper with role "status" and the A2A state "submitted", whose
// text names the limit. Both folds used to read every status message as
// "working", so a queued helper looked like one that had started. They now
// keep "submitted" for that message and show its text; the helper's own
// run_start, which comes when it gets its slot, moves it to "working".

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "./reducer";
import { foldWork } from "./work";

const WAITING = "Waiting for a free slot: this chat runs at most 2 subagents at the same time.";

const queued: RunEvent[] = [
  { type: "run_start", runId: "r-main", agentId: "main", prompt: "go", ts: 1 },
  { type: "agent_spawn", agentId: "worker-3", parentId: "main", task: "t3", ts: 2 },
  {
    type: "agent_message",
    from: "main",
    to: "worker-3",
    role: "task",
    state: "submitted",
    text: "t3",
    ts: 3,
  },
  {
    type: "agent_message",
    from: "worker-3",
    to: "main",
    role: "status",
    state: "submitted",
    text: WAITING,
    ts: 4,
  },
];

const started: RunEvent[] = [
  ...queued,
  { type: "run_start", runId: "r-3", agentId: "worker-3", parentId: "main", prompt: "t3", ts: 5 },
];

describe("a helper waiting for a slot", () => {
  it("is submitted, not working, in the agents roster, and says why", () => {
    const agent = reduceAll(initialState, queued).agents.find((a) => a.id === "worker-3");
    expect(agent?.state).toBe("submitted");
    expect(agent?.lastStatus).toBe(WAITING);
  });

  it("is submitted, not working, in the work panel, and says why", () => {
    const item = foldWork(queued).find((i) => i.id === "worker-3");
    expect(item?.state).toBe("submitted");
    expect(item?.lastStatus).toBe(WAITING);
  });

  it("is working once its own run starts", () => {
    const agent = reduceAll(initialState, started).agents.find((a) => a.id === "worker-3");
    expect(agent?.state).toBe("working");
    const item = foldWork(started).find((i) => i.id === "worker-3");
    expect(item?.state).toBe("working");
  });

  it("leaves a report_status message as working", () => {
    const reporting: RunEvent[] = [
      ...started,
      {
        type: "agent_message",
        from: "worker-3",
        to: "main",
        role: "status",
        state: "working",
        text: "reading the tests",
        ts: 6,
      },
    ];
    expect(reduceAll(initialState, reporting).agents.find((a) => a.id === "worker-3")?.state).toBe("working");
    expect(foldWork(reporting).find((i) => i.id === "worker-3")?.lastStatus).toBe("reading the tests");
  });
});
