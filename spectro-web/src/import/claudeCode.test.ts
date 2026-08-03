// The Claude Code transcript adapter. Real Claude Code JSONL is a log of
// user/assistant message records with content blocks; the adapter maps them
// onto spectroscope's RunEvent stream so real sessions replay through the same
// reducers (chat, graph, flow, lab) as a spectroscope run.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
// Vite-native raw import: the fixture arrives as a plain string, no fs/paths.
import ccLinear from "./fixtures/cc-linear.jsonl?raw";
import ccSubagent from "./fixtures/cc-subagent.jsonl?raw";
import ccModern from "./fixtures/cc-modern.jsonl?raw";
import ccWorkflow from "./fixtures/cc-workflow.jsonl?raw";
import ccFollowup from "./fixtures/cc-followup.jsonl?raw";
import ccUserBlocks from "./fixtures/cc-user-blocks.jsonl?raw";
import { claudeCodeToRunEvents, parseTaskNotification, parseTranscript } from "./claudeCode";
import { detectAndLoad } from "./detect";
import { advanceScene, initialScene } from "../lab/labScene";
import { initialState, reduceAll } from "../state/reducer";
import { buildTextFeed } from "../state/textFeed";

describe("claudeCode adapter (linear)", () => {
  const events = parseTranscript(ccLinear);

  it("opens with run_start carrying the first user prompt", () => {
    expect(events[0]).toMatchObject({ type: "run_start", agentId: "main" });
    expect((events[0] as { prompt: string }).prompt).toMatch(/List the files/);
  });

  it("maps thinking, text, tool_use and tool_result", () => {
    expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(events.some((e) => e.type === "tool_call" && e.name === "Bash")).toBe(true);
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeTruthy();
    const callId = (call as { callId: string }).callId;
    expect(
      events.some((e) => e.type === "tool_result" && e.callId === callId && e.output.includes("config.json")),
    ).toBe(true);
  });

  it("maps usage", () => {
    expect(events.some((e) => e.type === "usage" && e.inputTokens === 1200)).toBe(true);
  });

  it("ends with run_end and folds to a clean scene", () => {
    expect(events.at(-1)).toMatchObject({ type: "run_end" });
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
  });
});

describe("claudeCode adapter (modern format)", () => {
  const events = parseTranscript(ccModern);

  // This used to read "skips leading metadata records and opens with the real
  // user prompt", and the skipping was the point of it. Card 141 removed the
  // premise rather than the assertion: the leading records are read now, so
  // the stream opens on the queue the user typed into and the run still starts
  // where it always did, on the first message record.
  it("reads the leading metadata records and still starts the run on the user prompt", () => {
    expect(events[0]).toMatchObject({ type: "queue_operation", operation: "enqueue" });
    const start = events.find((e) => e.type === "run_start");
    expect(start).toMatchObject({ type: "run_start", agentId: "main" });
    expect((start as { prompt: string }).prompt).toMatch(/check the tests/);
  });

  it("maps the Agent tool (the modern Task) to agent_spawn + result close", () => {
    const spawn = events.find((e) => e.type === "agent_spawn");
    expect(spawn).toBeTruthy();
    expect((spawn as { agentId: string }).agentId).toBe("agent-1");
    expect(
      events.some((e) => e.type === "agent_message" && e.role === "result" && e.from === "agent-1"),
    ).toBe(true);
  });

  it("folds to a clean terminal scene", () => {
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

describe("claudeCode adapter (Task subagents via sidechains)", () => {
  const events = parseTranscript(ccSubagent);
  const spawn = events.find((e) => e.type === "agent_spawn") as
    Extract<import("../events").RunEvent, { type: "agent_spawn" }> | undefined;

  it("emits agent_spawn for a Task tool_use", () => {
    expect(spawn).toBeTruthy();
    expect(spawn!.task).toMatch(/Review/);
  });

  it("routes sidechain text under the child agentId (with its own run_start)", () => {
    expect(events.some((e) => e.type === "run_start" && e.agentId === spawn!.agentId)).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.agentId === spawn!.agentId)).toBe(true);
  });

  it("closes the child with a result message and the parent tool_result", () => {
    expect(
      events.some((e) => e.type === "agent_message" && e.role === "result" && e.from === spawn!.agentId),
    ).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.callId === spawn!.agentId)).toBe(true);
  });

  it("folds to a clean terminal scene (no stranded subagents)", () => {
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

// A transcript's own clock: two dated records twenty hours apart with undated
// ones between them, and the model swapped halfway through. Real files look
// like this — the metadata is optional per record, not per file.
const T1 = "2026-07-26T21:12:00.000Z";
const T2 = "2026-07-27T17:23:00.000Z";
const mixedClock: unknown[] = [
  { type: "user", message: { role: "user", content: "start the run" }, uuid: "u1" },
  {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [
        { type: "text", text: "on it" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
    uuid: "a1",
    parentUuid: "u1",
    timestamp: T1,
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    uuid: "u2",
    parentUuid: "a1",
  },
  {
    type: "assistant",
    message: { role: "assistant", model: "claude-fable-5", content: [{ type: "text", text: "done" }] },
    uuid: "a2",
    parentUuid: "u2",
    timestamp: T2,
  },
];

describe("claudeCode adapter (the file's own clock)", () => {
  const events = claudeCodeToRunEvents(mixedClock);
  const stamps = events.map((e) => e.ts);

  it("never steps backwards, dated records or not", () => {
    expect(stamps.every((t) => Number.isFinite(t))).toBe(true);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
  });

  it("closes on the last real timestamp, never on the synthetic ladder", () => {
    const end = events[events.length - 1];
    expect(end.type).toBe("run_end");
    expect(end.ts).toBe(Date.parse(T2));
    expect(end.ts).toBe(Math.max(...stamps));
  });

  it("spans the twenty hours the file recorded, not a calendar of its own", () => {
    const recorded = Date.parse(T2) - Date.parse(T1);
    const span = Math.max(...stamps) - Math.min(...stamps);
    expect(span).toBeGreaterThanOrEqual(recorded);
    expect(span - recorded).toBeLessThan(10_000); // only the undated rungs add to it
  });
});

describe("claudeCode adapter (turns)", () => {
  it("opens one turn per assistant message, numbered in order", () => {
    const events = claudeCodeToRunEvents(mixedClock);
    const turns = events.filter((e) => e.type === "turn_start" && e.agentId === "main");
    expect(turns.map((e) => (e as { turn: number }).turn)).toEqual([1, 2]);
  });

  it("counts each agent's turns on its own", () => {
    const events = parseTranscript(ccSubagent);
    const turnsOf = (agentId: string): number[] =>
      events
        .filter((e) => e.type === "turn_start" && e.agentId === agentId)
        .map((e) => (e as { turn: number }).turn);
    expect(turnsOf("main")).toEqual([1, 2]);
    expect(turnsOf("task1")).toEqual([1, 2]);
  });
});

/** The socket-only backend announcement, as it leaves the adapter. */
interface EmittedProviderInfo {
  type: string;
  provider?: string;
  model?: string;
  host?: string;
  ts: number;
}
const providerInfos = (events: RunEvent[]): EmittedProviderInfo[] =>
  events.filter((e) => (e as { type: string }).type === "provider_info") as unknown as EmittedProviderInfo[];

describe("claudeCode adapter (which model ran)", () => {
  const events = claudeCodeToRunEvents(mixedClock);

  it("announces the model at the start and again on every change", () => {
    expect(providerInfos(events).map((p) => p.model)).toEqual(["claude-opus-5", "claude-fable-5"]);
  });

  it("announces the switch at the message that switched", () => {
    const [first, second] = providerInfos(events);
    expect(first.ts).toBeLessThanOrEqual(Date.parse(T1));
    expect(second.ts).toBe(Date.parse(T2));
  });

  it("stamps the run with the model that ran it", () => {
    const start = events.find((e) => e.type === "run_start");
    expect((start as { model?: string }).model).toBe("claude-opus-5");
  });

  it("invents neither host nor provider — a transcript records neither", () => {
    // A Claude model id names the model, not the endpoint that served it
    // (Anthropic API, Bedrock, Vertex). Unknown must read as unknown.
    for (const p of providerInfos(events)) {
      expect(p.host ?? "").toBe("");
      expect(p.provider ?? "").toBe("");
    }
    const start = events.find((e) => e.type === "run_start");
    expect((start as { provider?: string }).provider).toBeUndefined();
  });

  it("stays silent when the transcript names no model", () => {
    expect(providerInfos(parseTranscript(ccLinear))).toEqual([]);
  });
});

// A subagent that spawns a subagent: the inner Task lives in a sidechain
// record, and its own sidechain children hang off its tool-use id.
const nested: unknown[] = [
  { type: "user", message: { role: "user", content: "orchestrate" }, uuid: "u1" },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_outer",
          name: "Task",
          input: { description: "map the repo", subagent_type: "Explore" },
        },
      ],
    },
    uuid: "a1",
    parentUuid: "u1",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "delegating the read" },
        {
          type: "tool_use",
          id: "toolu_inner",
          name: "Task",
          input: { description: "read the config", subagent_type: "Read" },
        },
      ],
    },
    uuid: "s1",
    parentUuid: "toolu_outer",
    isSidechain: true,
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "config read" }] },
    uuid: "s2",
    parentUuid: "toolu_inner",
    isSidechain: true,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "8 keys" }],
    },
    uuid: "s3",
    parentUuid: "s1",
    isSidechain: true,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_outer", content: "mapped" }],
    },
    uuid: "u2",
    parentUuid: "a1",
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "all done" }] },
    uuid: "a2",
    parentUuid: "u2",
  },
];

describe("claudeCode adapter (subagent labels)", () => {
  const roster = (events: RunEvent[]) => reduceAll(initialState, events).agents;

  it("gives the top-level subagent its readable type", () => {
    const agents = roster(parseTranscript(ccSubagent));
    expect(agents.find((a) => a.id === "task1")?.label).toBe("code-reviewer");
  });

  it("labels a nested subagent too, instead of leaving its tool-use id alone", () => {
    const agents = roster(claudeCodeToRunEvents(nested));
    expect(agents.find((a) => a.id === "toolu_outer")?.label).toBe("Explore");
    expect(agents.find((a) => a.id === "toolu_inner")?.label).toBe("Read");
  });

  it("hangs a nested subagent under the agent that spawned it", () => {
    const agents = roster(claudeCodeToRunEvents(nested));
    expect(agents.find((a) => a.id === "toolu_inner")?.parentId).toBe("toolu_outer");
  });

  it("still folds to a clean terminal scene", () => {
    const scene = claudeCodeToRunEvents(nested).reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

describe("task-notification parse", () => {
  it("reads the fields a real notification carries", () => {
    const n = parseTaskNotification(
      "<task-notification>\n<task-id>w82qt1zg0</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n" +
        "<status>completed</status>\n<summary>done</summary>\n" +
        "<usage><agent_count>11</agent_count><duration_ms>1140752</duration_ms></usage>\n" +
        "</task-notification>",
    );
    expect(n).toMatchObject({ taskId: "w82qt1zg0", callId: "toolu_A", status: "completed" });
    expect(n?.fields).toContainEqual({ label: "summary", value: "done" });
    expect(n?.fields).toContainEqual({ label: "usage", value: "agent_count=11 duration_ms=1140752" });
  });

  // A half-eaten block is worse than an unread one: the record has to survive
  // intact for the reader who can still make sense of it.
  it("returns null rather than half-eating a block it cannot read", () => {
    expect(parseTaskNotification("plain user text")).toBeNull();
    expect(parseTaskNotification("<task-notification>\n<task-id>b1</task-id>\n<summary>no close")).toBeNull();
    expect(
      parseTaskNotification("<task-notification>\n<summary>no id</summary>\n</task-notification>"),
    ).toBeNull();
  });
});

describe("claudeCode adapter (background tasks)", () => {
  const events = parseTranscript(ccWorkflow);
  const resultsFor = (callId: string) =>
    events.filter((e) => e.type === "tool_result" && e.callId === callId) as Extract<
      RunEvent,
      { type: "tool_result" }
    >[];

  it("leaves the launch's own receipt where the launch put it", () => {
    const call = events.findIndex((e) => e.type === "tool_call" && e.callId === "toolu_A");
    const receipt = events.findIndex((e) => e.type === "tool_result" && e.callId === "toolu_A");
    const next = events.findIndex((e) => e.type === "text_delta" && e.text.includes("read the fence"));
    expect(call).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(call);
    expect(receipt).toBeLessThan(next);
    expect((events[receipt] as { output: string }).output).toContain("Task ID: w82qt1zg0");
  });

  // The outcome is that call's outcome, so it rides on that call's tool_result:
  // the reducer patches the card by callId and adds no turn, which is what keeps
  // a notification arriving eighteen minutes later from moving anything.
  it("joins the notification onto the launch by its tool-use id, in arrival order", () => {
    const rs = resultsFor("toolu_A");
    expect(rs.length).toBe(2);
    const interleaved = events.findIndex((e) => e.type === "text_delta" && e.text.includes("read the fence"));
    const joined = events.lastIndexOf(rs[1]);
    expect(joined).toBeGreaterThan(interleaved);
    expect(rs[1].output).toContain("Task ID: w82qt1zg0");
    expect(rs[1].output).toContain("Dynamic workflow");
    expect(rs[1].output).toContain("agent_count=11");
    expect(rs[1].isError).toBe(false);
    // 21:00:02 receipt -> 21:19:02 notification: the wait is measured, not zero.
    expect(rs[1].durationMs).toBe(19 * 60 * 1000);
  });

  it("joins by task id when the notification carries no tool-use id", () => {
    // receipt, two events, and the end-of-transcript marker: a monitor that
    // reported progress never reported an ending.
    const rs = resultsFor("toolu_C");
    expect(rs.length).toBe(4);
    expect(rs[1].output).toContain("both 0.4.0 POMs resolve");
    expect(rs[2].output).toContain("both 0.4.0 POMs resolve");
    expect(rs[2].output).toContain("0.4.1 POMs resolve too");
  });

  it("marks a launch that never reported back as still running", () => {
    const rs = resultsFor("toolu_B");
    expect(rs.length).toBe(2);
    expect(rs[1].output).toMatch(/no result/i);
    expect(rs[1].isError).toBe(false);
    // A progress event is not an ending: the monitor is unfinished too.
    expect(resultsFor("toolu_C").at(-1)?.output).toMatch(/no result/i);
    expect(resultsFor("toolu_A").at(-1)?.output).not.toMatch(/no result/i);
  });

  it("lets a notification whose launch is missing stand on its own", () => {
    const msgs = events.filter((e) => e.type === "agent_message" && e.from === "borphan99");
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ role: "result", state: "failed", to: "main" });
    expect((msgs[0] as { text: string }).text).toContain("codesign");
  });

  it("joins nothing from a block it could not parse, and loses nothing either", () => {
    // This test used to read "emits nothing at all", and the fix to the
    // follow-up user turn replaced its premise rather than its threshold. What
    // it was really guarding is the PARSER's defensiveness: an unterminated
    // block must not be half-read into a join — no task, no card, no outcome.
    // That still holds. What it also pinned, by accident, was the record
    // disappearing, which is the silence card 141 set out to end. The block
    // never closes, so it is not a notification; it is text in the user
    // channel, and it now reads as exactly that.
    const joined = events.filter((e) => e.type === "agent_message" || e.type === "tool_result");
    expect(joined.some((e) => JSON.stringify(e).includes("btruncat1"))).toBe(false);
    const said = events.filter((e) => (e as unknown as { type: string }).type === "user_message");
    expect(said.some((e) => (e as unknown as { text: string }).text.includes("btruncat1"))).toBe(true);
  });

  it("shows the outcome on the launch's own card", () => {
    const state = reduceAll(initialState, events);
    expect(state.cards["toolu_A"].output).toContain("Dynamic workflow");
    expect(state.cards["toolu_A"].durationMs).toBe(19 * 60 * 1000);
    expect(state.cards["toolu_B"].output).toMatch(/no result/i);
  });
});

// Both of these happened in the owner's own session, and both are silent: the
// first steals a task id, the second restarts a clock.
const hazards: unknown[] = [
  { type: "user", message: { role: "user", content: "count them" }, uuid: "u1" },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_grep", name: "Bash", input: { command: "grep -c Workflow" } }],
    },
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-07-26T21:00:00.000Z",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_grep",
          // The id is in the output, but this call started nothing.
          content: 'tool_result "Workflow launched": 39\nfirst: Task ID: wquoted01',
        },
      ],
    },
    uuid: "u2",
    parentUuid: "a1",
    timestamp: "2026-07-26T21:00:01.000Z",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { script: "x" } }],
    },
    uuid: "a2",
    parentUuid: "u2",
    timestamp: "2026-07-26T21:00:02.000Z",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wf",
          content: "Workflow launched in background. Task ID: wquoted01\nSummary: the real one",
        },
      ],
    },
    uuid: "u3",
    parentUuid: "a2",
    timestamp: "2026-07-26T21:00:03.000Z",
  },
  // The same receipt again, replayed after a compaction.
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wf",
          content: "Workflow launched in background. Task ID: wquoted01\nSummary: the real one",
        },
      ],
    },
    uuid: "u4",
    parentUuid: "u3",
    timestamp: "2026-07-26T21:10:03.000Z",
  },
  {
    type: "user",
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>wquoted01</task-id>\n<status>completed</status>\n<summary>the real one finished</summary>\n</task-notification>",
    },
    uuid: "u5",
    parentUuid: "u4",
    timestamp: "2026-07-26T21:20:03.000Z",
  },
];

describe("claudeCode adapter (background task hazards)", () => {
  const events = claudeCodeToRunEvents(hazards);
  const outcome = events.filter((e) => e.type === "tool_result" && /the real one finished/.test(e.output));

  it("does not let an output that merely quotes a task id claim it", () => {
    expect(outcome.length).toBe(1);
    expect((outcome[0] as { callId: string }).callId).toBe("toolu_wf");
  });

  it("measures the wait from the first receipt, not from a replayed copy", () => {
    expect((outcome[0] as { durationMs: number }).durationMs).toBe(20 * 60 * 1000);
  });
});

// Measured in the owner's session on toolu_01PpZ2wqdadw4CbiHSPG2AdC (task
// wgqx5s006, 11 agents): the launch record is replayed AFTER the outcome
// landed, not before it. The reducer patches by callId and the last write wins,
// so a re-emitted bare receipt erases the outcome the card had already earned.
const lateReplay: unknown[] = [
  {
    type: "user",
    message: { role: "user", content: "ground the forensic lens" },
    uuid: "u0",
    timestamp: "2026-07-27T19:00:00.000Z",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { script: "x" } }],
    },
    uuid: "a1",
    parentUuid: "u0",
    timestamp: "2026-07-27T19:00:00.000Z",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wf",
          content: "Workflow launched in background. Task ID: wgqx5s006",
        },
      ],
    },
    uuid: "u1",
    parentUuid: "a1",
    timestamp: "2026-07-27T19:00:01.000Z",
  },
  {
    type: "user",
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>wgqx5s006</task-id>\n<tool-use-id>toolu_wf</tool-use-id>\n" +
        "<status>completed</status>\n<summary>the forensic lens finished</summary>\n</task-notification>",
    },
    uuid: "u2",
    parentUuid: "u1",
    timestamp: "2026-07-27T19:19:01.000Z",
  },
  // The compaction replay of the SAME pair, verbatim and after the outcome —
  // in the owner's session both records come back under their original uuids.
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { script: "x" } }],
    },
    uuid: "a1",
    parentUuid: "u0",
    timestamp: "2026-07-27T19:29:59.000Z",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wf",
          content: "Workflow launched in background. Task ID: wgqx5s006",
        },
      ],
    },
    uuid: "u1",
    parentUuid: "a1",
    timestamp: "2026-07-27T19:30:00.000Z",
  },
];

describe("claudeCode adapter (a launch replayed after its outcome)", () => {
  const events = claudeCodeToRunEvents(lateReplay);
  const results = events.filter((e) => e.type === "tool_result" && e.callId === "toolu_wf") as Extract<
    RunEvent,
    { type: "tool_result" }
  >[];

  it("does not let the replayed receipt erase the outcome that already landed", () => {
    expect(results.at(-1)?.output).toContain("the forensic lens finished");
  });

  it("keeps the measured wait rather than resetting it to the replay", () => {
    expect(results.at(-1)?.durationMs).toBe(19 * 60 * 1000);
  });

  // The compaction replays the WHOLE record pair, so the launch call comes back
  // too. Re-creating the card is the same erasure by another route.
  it("does not re-create the card and strand it with no result", () => {
    const state = reduceAll(initialState, events);
    expect(state.cards["toolu_wf"].output).toContain("the forensic lens finished");
    expect(state.cards["toolu_wf"].durationMs).toBe(19 * 60 * 1000);
  });
});

// A transcript records how every assistant message stopped. The importer threw
// that away and stamped "end_turn" on both run_ends it emits, which is a false
// statement about somebody else's session, and the one class of defect this
// card exists to remove. Measured over 4496 real transcripts: 2113 of them end
// on tool_use, 219 on stop_sequence, 13 assistant messages in the corpus end on
// max_tokens. Only 1248 really ended on end_turn.
const STAMP = "2026-08-01T09:00:00.000Z";
const assistantSaying = (stop: string | null, uuid: string, parent: string, text: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text }],
    stop_reason: stop,
  },
  uuid,
  parentUuid: parent,
  timestamp: STAMP,
});

describe("how the run_end says the file stopped", () => {
  it("reports the last recorded stop_reason, not a hardcoded end_turn", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "write the whole book" }, uuid: "u1" },
      assistantSaying("max_tokens", "a1", "u1", "Chapter one. It was a"),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run_end", stopReason: "max_tokens" });
  });

  // 87567 assistant records in the corpus carry stop_reason null: a partial
  // message that never reported an ending. Reading it as the answer would hand
  // the reader "null" where the file has an answer one record earlier.
  it("skips a null stop_reason and keeps the last one the file recorded", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      assistantSaying("stop_sequence", "a1", "u1", "here it is"),
      assistantSaying(null, "a2", "a1", "and then"),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run_end", stopReason: "stop_sequence" });
  });

  // 248 files carry no assistant record at all and 28 more record nothing but
  // nulls. "end_turn" there is an invention, so the frame says what is true:
  // the file never recorded one.
  it("says the file recorded none rather than inventing end_turn", () => {
    const events = parseTranscript(ccLinear);
    expect(events.at(-1)).toMatchObject({ type: "run_end", stopReason: "unrecorded" });
  });

  // A subagent closes on its OWN last message, not on whatever the main run
  // said before or after it.
  it("closes a subagent on the subagent's own last stop_reason", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "delegate" }, uuid: "u1" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "task1", name: "Task", input: { description: "Review" } }],
          stop_reason: "tool_use",
        },
        uuid: "a1",
        parentUuid: "u1",
      },
      { ...assistantSaying("max_tokens", "s1", "task1", "I ran out of room"), isSidechain: true },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "task1", content: "done" }],
        },
        uuid: "u2",
        parentUuid: "a1",
      },
      assistantSaying("end_turn", "a2", "u2", "the reviewer is back"),
    ]);
    const child = events.find((e) => e.type === "run_end" && e.runId === "cc-task1");
    expect(child).toMatchObject({ stopReason: "max_tokens" });
    expect(events.at(-1)).toMatchObject({ runId: "cc-import", stopReason: "end_turn" });
  });
});

// The lines that carry no conversation (card 141).
//
// A real Claude Code transcript is not only messages. Around them it records
// the agent's todo list, the queue a user typed into while the model was
// working, and the file somebody edited. The importer built frames from
// `assistant` and `user` and from nothing else, so all of that arrived and
// went nowhere. These are import-only frames: they are not wire events, they
// are readings of another format, and wire/nonWire.ts keeps them out of every
// file this app writes.
//
// The counts in the comments below were measured over the 4,545 transcripts in
// ~/.claude/projects, not estimated.
describe("claudeCode adapter (the lines that carry no conversation)", () => {
  const attachment = (payload: Record<string, unknown>, i = 1): Record<string, unknown> => ({
    parentUuid: "u1",
    isSidechain: false,
    type: "attachment",
    attachment: payload,
    uuid: `att-${i}`,
    timestamp: "2026-07-23T12:15:24.919Z",
  });

  const framesOfType = (records: unknown[], type: string): Record<string, unknown>[] =>
    claudeCodeToRunEvents(records).filter(
      (e) => (e as unknown as { type: string }).type === type,
    ) as unknown as Record<string, unknown>[];

  it("frames a todo list as one frame carrying every item", () => {
    // 30,690 items across 4,544 records; statuses completed 24,711 / pending
    // 4,336 / in_progress 1,643.
    const frames = framesOfType(
      [
        attachment({
          type: "task_reminder",
          content: [
            {
              id: "1",
              subject: "read the card",
              description: "read the card in full",
              status: "completed",
              blocks: [],
              blockedBy: [],
            },
            {
              id: "2",
              subject: "write the test",
              description: "write the failing test first",
              status: "in_progress",
              blocks: [],
              blockedBy: [],
              activeForm: "Writing the test",
            },
            {
              id: "3",
              subject: "run the gate",
              description: "run the gate and report the numbers",
              status: "pending",
              blocks: [],
              blockedBy: ["2"],
            },
          ],
          itemCount: 3,
        }),
      ],
      "task_reminder",
    );
    expect(frames.length).toBe(1);
    expect(frames[0].itemCount).toBe(3);
    const items = frames[0].items as { status: string }[];
    expect(items.map((i) => i.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  it("keeps each item's description, which is the whole substance of it", () => {
    // This is the assertion that pins why the existing `plan` type was refused
    // for this: planRow reads only `text`, so a todo list arriving as a plan
    // would be stripped of five of its seven fields, the description first.
    const frames = framesOfType(
      [
        attachment({
          type: "task_reminder",
          content: [
            {
              id: "1",
              subject: "write the test",
              description: "write the failing test and see it fail",
              status: "pending",
              blocks: [],
              blockedBy: [],
            },
          ],
          itemCount: 1,
        }),
      ],
      "task_reminder",
    );
    const items = frames[0].items as { description: string; subject: string }[];
    expect(items[0].description).toBe("write the failing test and see it fail");
    expect(items[0].subject).toBe("write the test");
  });

  it("builds no frame for an empty todo list", () => {
    // 2,087 of the 4,544 task_reminder records (45.9%) carry content: [] and
    // itemCount: 0. A frame for one of those is a row saying nothing, which is
    // the blank the model column was turned down for in card 139.
    const events = claudeCodeToRunEvents([attachment({ type: "task_reminder", content: [], itemCount: 0 })]);
    expect(events.filter((e) => (e as unknown as { type: string }).type === "task_reminder").length).toBe(0);
  });

  it("names an edited file, and carries its snippet only when there is one", () => {
    // 940 records, filename and snippet always both present; the snippet runs
    // to 8,223 characters at the top and to 0 at the bottom.
    const withText = framesOfType(
      [
        attachment({
          type: "edited_text_file",
          filename: "/tmp/notes.md",
          snippet: "1\tthe first line\n2\tthe second",
        }),
      ],
      "edited_text_file",
    );
    expect(withText.length).toBe(1);
    expect(withText[0].filename).toBe("/tmp/notes.md");
    expect(withText[0].snippet).toBe("1\tthe first line\n2\tthe second");

    const bare = framesOfType(
      [attachment({ type: "edited_text_file", filename: "/tmp/notes.md", snippet: "" })],
      "edited_text_file",
    );
    expect(bare.length).toBe(1);
    expect(bare[0].filename).toBe("/tmp/notes.md");
    expect("snippet" in bare[0]).toBe(false);
  });

  it("frames a queued command whatever mode it was queued in", () => {
    // The design said to drop the 555 task-notification ones as already joined
    // by emitNotification. MEASURED AND WRONG: of those 555, exactly 0 appear
    // anywhere in the corpus as a user record with the same text, and only 21
    // share a task id with any user record in their own file. Dropping them
    // would put 534 real notifications on the floor, which is the loss this
    // card exists to end. Both are framed; commandMode says which is which.
    const frames = framesOfType(
      [
        attachment(
          {
            type: "queued_command",
            prompt: "run the gate",
            commandMode: "prompt",
            timestamp: "2026-07-23T12:15:24.919Z",
            origin: { kind: "human" },
          },
          1,
        ),
        attachment(
          {
            type: "queued_command",
            prompt: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
            commandMode: "task-notification",
            timestamp: "2026-07-23T12:16:00.000Z",
          },
          2,
        ),
      ],
      "queued_command",
    );
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({
      prompt: "run the gate",
      commandMode: "prompt",
      origin: { kind: "human" },
    });
    expect(frames[1].commandMode).toBe("task-notification");
    expect("origin" in frames[1]).toBe(false);
  });

  it("reads a queued command whose prompt is a block array", () => {
    // 159 of the 1,213 prompts are arrays, 142 of them with a text block; the
    // rest is a pasted image. String concatenation would render "[object
    // Object]" into the trace.
    const frames = framesOfType(
      [
        attachment({
          type: "queued_command",
          prompt: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
            { type: "text", text: "hold on" },
          ],
          commandMode: "prompt",
        }),
      ],
      "queued_command",
    );
    expect(frames.length).toBe(1);
    expect(frames[0].prompt).toBe("hold on");
  });

  it("says less about a queue operation that carries no content", () => {
    // 3,088 of 7,610 queue-operation records (40.6%) have no content field.
    const frames = framesOfType(
      [
        {
          type: "queue-operation",
          operation: "dequeue",
          timestamp: "2026-07-27T20:50:43.606Z",
          sessionId: "s1",
        },
      ],
      "queue_operation",
    );
    expect(frames.length).toBe(1);
    expect(frames[0].operation).toBe("dequeue");
    expect(frames[0].timestamp).toBe("2026-07-27T20:50:43.606Z");
    expect("content" in frames[0]).toBe(false);
  });

  it("puts a queue operation that ran before the first message ahead of run_start", () => {
    // 298 of the 7,610 (3.9%) sit before their file's first message record,
    // which is where cc-modern opens too. The run still starts exactly once,
    // and the user record is still what starts it.
    const events = parseTranscript(ccModern);
    const types = events.map((e) => (e as unknown as { type: string }).type);
    expect(types.filter((t) => t === "run_start").length).toBe(1);
    expect(types.indexOf("queue_operation")).toBeLessThan(types.indexOf("run_start"));
    expect(types.filter((t) => t === "queue_operation").length).toBe(2);
    const start = events.find((e) => e.type === "run_start") as { prompt: string };
    expect(start.prompt).toMatch(/check the tests/);
  });

  it("builds nothing for a mode record, because there is nothing in it", () => {
    // A PIN, not a red test: this passes today and must keep passing. All
    // 3,581 mode records in the corpus carry the value "normal", and the record
    // has no uuid and no timestamp. A frame repeating one word on every line of
    // every file is decoration, so `mode` stays on the no-conversation pile.
    const events = claudeCodeToRunEvents([{ type: "mode", mode: "normal", sessionId: "s1" }]);
    expect(events.filter((e) => (e as unknown as { type: string }).type === "mode").length).toBe(0);
    expect(events.length).toBe(0);
  });

  it("charges every new frame to the line it was read from", () => {
    const text = [
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-07-27T20:48:05.750Z",
        content: "wait",
      }),
      "",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "go" },
        uuid: "u1",
        timestamp: "2026-07-27T20:48:06.000Z",
      }),
      JSON.stringify({
        ...attachment({ type: "edited_text_file", filename: "/tmp/a.txt", snippet: "1\tx" }),
        timestamp: "2026-07-27T20:48:07.000Z",
      }),
    ].join("\n");
    const { events, source } = detectAndLoad(text);
    const lineOf = (type: string): number =>
      source.origin[events.findIndex((e) => (e as unknown as { type: string }).type === type)];
    expect(lineOf("queue_operation")).toBe(0);
    expect(lineOf("run_start")).toBe(2);
    expect(lineOf("edited_text_file")).toBe(3);
  });
});

// The user turns that are not the first one (card 141, stage 1 follow-up).
//
// A Claude Code transcript stores a user record's body EITHER as content blocks
// or as a plain string, and which one it uses says nothing about the record: the
// first prompt of a session and every later one are both strings. The importer
// read the first through `asText` into run_start.prompt and sent every later one
// down the block loop, where a string yields an empty array — so a follow-up
// prompt produced no frame at all and reached neither the chat nor the trace.
//
// Measured over the 151 transcripts in ~/.claude/projects: 1,985 user records
// are lost this way, in 120 of the 151 files. What they carry is NOT one kind of
// thing — 532 are marked `isMeta` (an "[Image: …]" note, a local-command
// caveat), and of the rest the commonest are slash commands, their
// `<local-command-stdout>`, and a compaction's "This session is being
// continued…", with typed prompts ("weiter") the long tail. That mix is the
// reason this is a `user_message` and not a second `run_start`: run_start opens
// a RUN, and buildGraph gives every one of them its own user node and restarts
// the t+ clock. Two thousand invented runs would be a larger untruth than the
// silence being fixed. `user_message` says only what the file says — the user
// channel carried this text — and the reducer renders it as the bubble it is.
describe("claudeCode adapter (a follow-up user turn)", () => {
  const events = parseTranscript(ccFollowup);
  const texts = (type: string): string[] =>
    events.filter((e) => e.type === type).map((e) => (e as unknown as { text: string }).text);

  it("carries a follow-up prompt stored as a plain string", () => {
    expect(texts("user_message")).toContain(
      "mache einen neuen order mit nummerierung, schreibe eine CLAUDE.md in dieses verzechniss und update die root CLAUDE.md und packe alle dokumente da rein die du bisher gemacht hast",
    );
    expect(texts("user_message")).toContain("die svg ist super");
  });

  it("does not repeat the first prompt, which run_start already carries", () => {
    // The two would double up in the chat: run_start builds the user bubble.
    const first = (events.find((e) => e.type === "run_start") as { prompt: string }).prompt;
    expect(first).toMatch(/^idee: claude code feature liste/);
    expect(texts("user_message")).not.toContain(first);
  });

  it("reads what the client wrote into the channel, not only what was typed", () => {
    // 532 of the 1,985 are `isMeta`. They are dropped today just as silently,
    // and they are why the model suddenly talks about a picture. The file put
    // them in the user channel; so does this.
    expect(texts("user_message").some((t) => t.startsWith("[Image: original 1200x2286"))).toBe(true);
  });

  it("leaves a task notification on the path that joins it to its launch", () => {
    // The notification branch is read FIRST and must keep winning: a
    // notification is an outcome to patch onto a card, not a thing the person
    // said. 507 of them in the corpus.
    const notification = [
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      {
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>t9</task-id>\n<status>completed</status>\n</task-notification>",
        },
        uuid: "u2",
      },
    ];
    const out = claudeCodeToRunEvents(notification);
    expect(out.some((e) => (e as unknown as { type: string }).type === "user_message")).toBe(false);
    expect(out.some((e) => e.type === "agent_message" && e.from === "t9")).toBe(true);
  });

  it("builds nothing for a body the file left empty", () => {
    const out = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      { type: "user", message: { role: "user", content: "" }, uuid: "u2" },
    ]);
    expect(out.some((e) => (e as unknown as { type: string }).type === "user_message")).toBe(false);
  });

  it("charges the frame to the line it was read from", () => {
    const { events: loaded, source } = detectAndLoad(ccFollowup);
    const at = loaded.findIndex((e) => (e as unknown as { type: string }).type === "user_message");
    expect(source.origin[at]).toBe(2); // the third line of the file, counted from zero
  });

  it("stops calling those lines silent", () => {
    // The bar's sentence is the point of the fix: three of these six lines
    // carried conversation and were counted as carrying none.
    const { source } = detectAndLoad(ccFollowup);
    const used = new Set([...source.origin].filter((i) => i >= 0));
    expect(source.lines.length - used.size).toBe(0);
  });
});

// The other half of the same silence, and the worse half: these records DID
// produce a frame, so they never counted toward the import bar's "carry no
// conversation" line and the fix to the string case left them alone. A user
// record whose body is an ARRAY sent every block through emitBlock("main", …),
// where a `text` block became a text_delta under agentId "main" — which the
// chat reducer folds into an ASSISTANT turn and the feed renders as `answer`.
// Text the person typed appeared on screen as if the model had said it.
//
// Measured over the 4,571 transcripts in ~/.claude/projects: 776 such blocks in
// 122 files, 509 records carrying nothing but text and 263 carrying an image
// beside it. NOT ONE of them mixes text with a tool_result — in the whole
// corpus `text` co-occurs only with `image` — but the split is still per block
// rather than per record, because a record is a bag of blocks and the rule
// "text is the person, a result is the machine" is a fact about each block.
describe("claudeCode adapter (text blocks in a user record)", () => {
  const events = parseTranscript(ccUserBlocks);
  const texts = (type: string): string[] =>
    events
      .filter((e) => (e as unknown as { type: string }).type === type)
      .map((e) => (e as unknown as { text: string }).text);

  it("reads a text block in a user record as the person talking", () => {
    expect(texts("user_message")).toContain("[Request interrupted by user]");
  });

  it("never lets that text reach the stream as an answer", () => {
    // The bug in one line: this is what put it in the assistant's mouth.
    expect(texts("text_delta").join("\n")).not.toContain("[Request interrupted by user]");
    expect(texts("text_delta").some((t) => t.startsWith("gibt es in kapitel sieben"))).toBe(false);
  });

  it("reads the text beside an image, which is how 263 of them arrive", () => {
    expect(texts("user_message").some((t) => t.startsWith("gibt es in kapitel sieben"))).toBe(true);
  });

  it("leaves a tool_result in the same record on the path that builds its card", () => {
    // Constructed, not measured: the corpus never mixes these two. It pins the
    // per-block split anyway, so a record that did carry both would not lose
    // the result to the prompt or the prompt to the result.
    const out = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
        uuid: "a1",
        parentUuid: "u1",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "hello.txt" },
            { type: "text", text: "[Request interrupted by user]" },
          ],
        },
        uuid: "u2",
        parentUuid: "a1",
      },
    ]);
    expect(out.some((e) => e.type === "tool_result" && e.callId === "t1")).toBe(true);
    expect(
      out.some(
        (e) =>
          (e as unknown as { type: string }).type === "user_message" &&
          (e as unknown as { text: string }).text === "[Request interrupted by user]",
      ),
    ).toBe(true);
  });

  it("puts the words in the person's bubble, not the model's", () => {
    const state = reduceAll(initialState, events);
    const said = state.turns.filter((t) => t.kind === "user").map((t) => t.text);
    const answered = state.turns.filter((t) => t.kind === "assistant").map((t) => t.text);
    expect(said).toContain("[Request interrupted by user]");
    expect(answered.join("\n")).not.toContain("[Request interrupted by user]");
  });

  it("reads as a prompt in the text feed, not as an answer", () => {
    const feed = buildTextFeed(events);
    const row = feed.find((s) => s.text === "[Request interrupted by user]");
    expect(row?.kind).toBe("prompt");
  });

  it("charges the frame to the line it was read from", () => {
    const { events: loaded, source } = detectAndLoad(ccUserBlocks);
    const at = loaded.findIndex(
      (e) =>
        (e as unknown as { type: string }).type === "user_message" &&
        (e as unknown as { text: string }).text === "[Request interrupted by user]",
    );
    expect(source.origin[at]).toBe(3); // the fourth line of the file, counted from zero
  });
});
