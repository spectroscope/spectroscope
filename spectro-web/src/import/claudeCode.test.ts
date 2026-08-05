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
import ccSplit from "./fixtures/cc-split-message.jsonl?raw";
import ccStandalone from "./fixtures/cc-standalone-subagent.jsonl?raw";
import ccStandaloneNested from "./fixtures/cc-standalone-nested.jsonl?raw";
import ccOrphanSidechain from "./fixtures/cc-orphan-sidechain.jsonl?raw";
import ccBlankCards from "./fixtures/cc-blank-cards.jsonl?raw";
import ccToolResult from "./fixtures/cc-tool-result.jsonl?raw";
import ccCompaction from "./fixtures/cc-compaction.jsonl?raw";
import ccApiError from "./fixtures/cc-api-error.jsonl?raw";
import {
  claudeCodeToRunEvents,
  claudeCodeWithOrigin,
  parseTaskNotification,
  parseTranscript,
} from "./claudeCode";
import { detectAndLoad } from "./detect";
import { advanceScene, initialScene } from "../lab/labScene";
import { initialState, reduceAll } from "../state/reducer";
import { sourceStats } from "../state/traceSource";
import { buildTextFeed } from "../state/textFeed";
import { isWireEvent } from "../wire/nonWire";

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

/**
 * ONE API response, written down as SEVERAL records.
 *
 * Claude Code does not write one record per response. It writes one per content
 * block: the thinking lands, then the text, then each tool_use, and all of them
 * carry the SAME `message.id`. Measured over the 4977 transcripts in
 * ~/.claude/projects: 265,009 assistant records collapse to 143,025 responses,
 * and only 60,098 responses were ever a single record. Reading a record as a
 * turn therefore counted 1.85 turns for every turn that happened, and — because
 * every piece repeats the whole `message.usage` — counted the tokens again on
 * each piece: 226,873,474 output tokens where the file says 142,811,312.
 *
 * The key is ADJACENCY, not the id alone. The same message.id reappears far
 * later in a file when a compaction replays the record verbatim, and merging
 * those would fuse two turns that are minutes apart. So a run is a maximal
 * stretch of CONSECUTIVE assistant records sharing a non-empty message.id, and
 * anything at all between them ends it. Measured: requestId agrees with that
 * grouping on all 82,927 multi-piece runs, and 0 disagree.
 */
describe("claudeCode adapter (one response, several records)", () => {
  const events = parseTranscript(ccSplit);
  const mainTurns = events.filter((e) => e.type === "turn_start" && e.agentId === "main");
  const usages = events.filter((e) => e.type === "usage");

  it("opens ONE turn for the three records of one response", () => {
    // msg_1 as thinking / text / tool_use; then msg_2; then the replayed msg_1;
    // then msg_3, whose pieces straddle a tool_result.
    expect(mainTurns.map((e) => (e as { turn: number }).turn)).toEqual([1, 2, 3, 4]);
  });

  it("still emits every block of every piece", () => {
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(2);
    expect(events.some((e) => e.type === "tool_call" && e.name === "Bash")).toBe(true);
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(3);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(3);
  });

  it("holds the response open across the tool results coming back", () => {
    // msg_3 asks for one file, the result lands, and its SECOND tool_use is
    // still the same response. Measured: 18,892 of the 19,298 messages whose
    // pieces are separated by anything are separated by nothing but
    // tool_results, so a rule that broke on them would leave most of the
    // over-counting in place.
    const reads = events.filter((e) => e.type === "tool_call" && e.name === "Read");
    expect(reads).toHaveLength(2);
    // ...and both sit inside turn 4, with no turn opening between them.
    const at = (p: (e: RunEvent) => boolean): number => events.findIndex(p);
    const first = at((e) => e.type === "tool_call" && (e as { callId: string }).callId === "t2");
    const second = at((e) => e.type === "tool_call" && (e as { callId: string }).callId === "t3");
    expect(events.slice(first, second).some((e) => e.type === "turn_start")).toBe(false);
  });

  it("counts the response's tokens once, from the piece that finished the accounting", () => {
    // The three pieces of msg_1 report 1, 1 and 140 output tokens; the last is
    // the complete accounting, and the only one carrying the cache fields.
    // Measured: the last piece holds the maximum on all 85,369 multi-piece
    // runs, with no exception.
    expect(usages).toHaveLength(4);
    expect(usages[0]).toMatchObject({
      inputTokens: 9,
      outputTokens: 140,
      cacheReadTokens: 20000,
      cacheCreationTokens: 300,
    });
    expect(usages[1]).toMatchObject({ outputTokens: 25 });
    // The interleaved response reports once too, off its last piece.
    expect(usages[3]).toMatchObject({ inputTokens: 40, outputTokens: 310, cacheReadTokens: 900 });
  });

  it("does not fuse a record that a compaction replayed later", () => {
    // msg_1 comes back after msg_2 has spoken. ANOTHER assistant message is
    // exactly what ends a run, so the copy is its own turn rather than being
    // welded onto a response that finished four records earlier.
    expect(mainTurns).toHaveLength(4);
  });

  it("charges the turn to the line the response STARTED on", () => {
    const { events: evs, origin } = claudeCodeWithOrigin(
      ccSplit
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l)),
    );
    const at = evs.findIndex((e) => e.type === "turn_start" && (e as { turn: number }).turn === 1);
    expect(origin[at]).toBe(1); // the thinking piece, line 2 of the file
    // ...and each block still names the line it was actually read from.
    const call = evs.findIndex((e) => e.type === "tool_call");
    expect(origin[call]).toBe(3);
  });
});

describe("claudeCode adapter (records that must NOT be merged)", () => {
  it("keeps a record with no message.id as a turn of its own", () => {
    // Every fixture written before this card, and every older transcript, has
    // no message.id at all. No id is no evidence that two records belong
    // together, so each stays a turn — the behaviour those files always had.
    const events = parseTranscript(ccLinear);
    const turns = events.filter((e) => e.type === "turn_start" && e.agentId === "main");
    expect(turns).toHaveLength(2);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
  });

  it("never merges across the sidechain boundary", () => {
    // Measured: 0 messages in the corpus mix isSidechain across their pieces.
    // The guard is here because merging a subagent's record into the main
    // agent's turn would move somebody else's tokens onto the main run.
    const line = (over: Record<string, unknown>): unknown => ({
      type: "assistant",
      message: {
        id: "msg_same",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      ...over,
    });
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      line({ uuid: "a1", parentUuid: "u1" }),
      line({ uuid: "a2", parentUuid: "a1", isSidechain: true }),
    ]);
    // The sidechain record is orphaned (no Task owns it) and drops out; what
    // matters is that it did not silently continue main's turn.
    expect(events.filter((e) => e.type === "turn_start" && e.agentId === "main")).toHaveLength(1);
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

  it("reads a queued command whose prompt is a block array, image included", () => {
    // 159 of the 1,213 prompts are arrays, 142 of them with a text block; the
    // rest is a pasted image. String concatenation would render "[object
    // Object]" into the trace.
    //
    // The image line is card 167: this used to read "hold on" and nothing else,
    // and on the 17 array prompts that are an image ALONE it read as no prompt
    // at all. A queued command with a screenshot in it now says so.
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
    expect(frames[0].prompt).toBe("[image/png · 3 B]\nhold on");
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

// A standalone subagent transcript is a session (card 152).
//
// ~/.claude/projects holds far more subagent transcripts than session
// transcripts, and every one of them imported to nothing: the per-record rule
// at the top of the sidechain branch drops a sidechain record whose owner is
// not in the file, and in one of these files no record has an owner in the
// file, because the owner is in another file entirely.
//
// The rule stays right where it is right. What was missing is the question one
// level up: a file whose records are ALL sidechain is not a session with
// orphans in it, it is one agent's transcript, and it names that agent on every
// line. Reading that name is reading. The parent is the part that really is
// absent, and run_start.parentId was already optional, so the root can stand
// without one.
describe("claudeCode adapter (a standalone subagent transcript)", () => {
  const events = parseTranscript(ccStandalone);
  const AGENT = "a0b476c3c018";

  it("opens a root run under the agent the file names, with no parent", () => {
    expect(events[0]).toMatchObject({ type: "provider_info" });
    const start = events.find((e) => e.type === "run_start");
    expect(start).toMatchObject({ type: "run_start", runId: "cc-import", agentId: AGENT });
    // The absence is the claim: a parentId here would point at a `main` this
    // file does not hold.
    expect(start).not.toHaveProperty("parentId");
  });

  it("takes the prompt from the first record, which is the task it was given", () => {
    const start = events.find((e) => e.type === "run_start") as { prompt: string };
    expect(start.prompt).toBe(
      "Build ONE large dark poster and a deterministic stdlib Python generator for it.",
    );
  });

  it("gives the reader the thinking, the tools and the usage under that agent", () => {
    expect(events.some((e) => e.type === "thinking_delta" && e.agentId === AGENT)).toBe(true);
    expect(events.some((e) => e.type === "tool_call" && e.agentId === AGENT && e.name === "Read")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.agentId === AGENT)).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.agentId === AGENT)).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.agentId === AGENT && e.outputTokens === 220)).toBe(
      true,
    );
    expect(events.filter((e) => e.type === "turn_start").every((e) => e.agentId === AGENT)).toBe(true);
  });

  // THE TESTS THAT WOULD HAVE CAUGHT A BAD MERGE.
  //
  // This branch and card 167 rewrote the same sidechain branch hours apart, and
  // both test files conflicted too — so the merged suite could not catch a bad
  // resolution by itself. The specific trap: `emitBlock` gained two OPTIONAL
  // parameters on main, `detail` and `agent`. A resolution that keeps this
  // branch's three-argument call sites compiles, and nothing fails; the import
  // just quietly renders less. On a standalone transcript that would be EVERY
  // tool result losing its detail, and an outage record announcing a model
  // named `<synthetic>` — the exact defect card 167 had just removed.
  //
  // So the arguments are pinned here, where they can only be dropped loudly.
  it("carries what the tool returned, the way a session file does", () => {
    const detail = events.find(
      (e) => (e as unknown as { type: string }).type === "tool_result_detail",
    ) as unknown as { callId: string; detail: { numLines?: number; startLine?: number } } | undefined;
    expect(detail).toBeDefined();
    expect(detail?.callId).toBe("call_read");
    // The record's own reading of the read: which slice of the file it was.
    expect(detail?.detail).toMatchObject({ numLines: 1, startLine: 42 });
  });

  it("never announces the model an outage record names", () => {
    // `isApiErrorMessage` records carry model "<synthetic>". Announcing it made
    // the trace claim the run had switched to a model by that name.
    const outage = parseTranscript(
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "do the thing" },
          uuid: "u1",
          isSidechain: true,
          agentId: "a0b476c3c018",
          timestamp: "2026-08-03T09:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            id: "m1",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: Connection error." }],
          },
          uuid: "a1",
          parentUuid: "u1",
          isSidechain: true,
          agentId: "a0b476c3c018",
          isApiErrorMessage: true,
          timestamp: "2026-08-03T09:00:01.000Z",
        }),
      ].join("\n"),
    );
    const models = outage
      .filter((e) => (e as unknown as { model?: string }).model !== undefined)
      .map((e) => (e as unknown as { model: string }).model);
    expect(models).not.toContain("<synthetic>");
    // And the outage still reaches the reader, as an error rather than as prose
    // the model is credited with.
    expect(outage.some((e) => e.type === "error")).toBe(true);
  });

  it("bills the file's own agent once per response, not twice", () => {
    // Both paths existed for a moment: this branch pushed a usage frame for the
    // root itself, and main bills every sidechain owner generically. The
    // reducer folds usage ADDITIVELY, so keeping both would have doubled the
    // footer, the agents panel and the context ring with nothing to fail.
    const usage = events.filter((e) => e.type === "usage" && e.agentId === AGENT) as unknown as {
      ts: number;
      outputTokens: number;
    }[];
    // The file records its cost on two responses, so two frames — and each
    // response appears once. A second path would repeat a (ts, tokens) pair
    // rather than add a new one, which is why the pairs are what is pinned.
    expect(usage).toHaveLength(2);
    expect(usage.map((e) => `${e.ts}:${e.outputTokens}`)).toEqual([
      `${usage[0].ts}:140`,
      `${usage[1].ts}:220`,
    ]);
    expect(new Set(usage.map((e) => e.ts)).size).toBe(usage.length);
  });

  it("closes on the file's own stop reason", () => {
    expect(events.at(-1)).toMatchObject({ type: "run_end", runId: "cc-import", stopReason: "end_turn" });
  });

  it("lets a mid-run message to the agent reach the stream", () => {
    // The coordinator writing to a working subagent arrives as a plain string
    // in the user channel. A string yields no blocks, so the block loop turned
    // a real turn of the conversation into silence.
    const said = events.filter((e) => (e as unknown as { type: string }).type === "user_message");
    expect(said.map((e) => (e as unknown as { text: string }).text)).toEqual([
      "The coordinator sent a message while you were working: make the accent amber.",
      "[Request interrupted by user]",
    ]);
  });

  it("stops reading an interruption back as the model's own words", () => {
    // A `text` block in the user channel was emitted as a text_delta under the
    // agent, so the trace showed the model announcing its own interruption.
    // This is what card 141 fixed on the main path, one branch over.
    const spoken = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as unknown as { text: string }).text);
    expect(spoken).not.toContain("[Request interrupted by user]");
  });

  it("leaves no line of the file on the no-conversation pile", () => {
    const { source } = detectAndLoad(ccStandalone);
    const stats = sourceStats(source);
    expect(stats.lines).toBe(7);
    expect(stats.zeroLines).toBe(0);
    expect(stats.frames).toBeGreaterThan(10);
  });

  it("hands the reader what the file says it is, and nothing it does not", () => {
    const { subagent } = detectAndLoad(ccStandalone);
    expect(subagent).toEqual({
      agentId: AGENT,
      sessionId: "902488ae-c4cf-49ef-a57c-cd914740bee2",
      attributionAgent: "general-purpose",
    });
  });

  it("says nothing of the kind about an ordinary session", () => {
    expect(detectAndLoad(ccLinear).subagent).toBeUndefined();
    expect(detectAndLoad(ccSubagent).subagent).toBeUndefined();
  });

  it("folds to a session whose root is that agent", () => {
    const state = reduceAll(initialState, events);
    const root = state.agents.find((a) => a.parentId === null);
    expect(root?.id).toBe(AGENT);
    expect(state.turns[0]).toMatchObject({ kind: "user" });
  });
});

describe("claudeCode adapter (a subagent transcript with a spawn inside it)", () => {
  const events = parseTranscript(ccStandaloneNested);

  it("renders both levels, the inner one under its spawner", () => {
    const spawn = events.find((e) => e.type === "agent_spawn");
    expect(spawn).toMatchObject({ type: "agent_spawn", agentId: "nested1", parentId: "root-agent" });
    const inner = events.find((e) => e.type === "run_start" && e.runId === "cc-nested1");
    expect(inner).toMatchObject({ agentId: "nested1", parentId: "root-agent" });
    expect(events.some((e) => e.type === "text_delta" && e.agentId === "nested1")).toBe(true);
  });

  it("keeps the root without a parent while the child has one", () => {
    const root = events.find((e) => e.type === "run_start" && e.runId === "cc-import");
    expect(root).toMatchObject({ agentId: "root-agent" });
    expect(root).not.toHaveProperty("parentId");
    expect(events.some((e) => e.type === "text_delta" && e.agentId === "root-agent")).toBe(true);
  });
});

describe("claudeCode adapter (an orphan inside a main transcript is still skipped)", () => {
  // The case this must not break. Here the file really is silent about who ran
  // that record: it is a main transcript, the spawn was compacted away, and
  // there is nothing to read. Inventing an owner would be the opposite defect.
  const { events, source } = detectAndLoad(ccOrphanSidechain);

  it("emits nothing for the record whose spawn the file does not hold", () => {
    expect(events.some((e) => (e as unknown as { text?: string }).text?.includes("ghost"))).toBe(false);
    expect(events.some((e) => (e as unknown as { text?: string }).text?.includes("does not contain"))).toBe(
      false,
    );
  });

  it("imports the rest of the session exactly as before", () => {
    expect(events.find((e) => e.type === "run_start")).toMatchObject({ agentId: "main" });
    expect(events.some((e) => e.type === "text_delta" && e.text === "Three headline changes.")).toBe(true);
    // The orphan's line is the one line nothing was read from.
    expect(sourceStats(source).zeroLines).toBe(1);
  });
});

// A card that came up blank (card 167, finding 4). The importer's asText read
// only `.text`, so every block that was not text mapped to the empty string and
// the card it belonged to showed nothing at all. Measured over the transcripts
// in ~/.claude/projects: 6,789 tool_result BLOCKS flatten to nothing (5,269
// image-or-document, 1,520 `tool_reference`), but 5,240 of them are in
// `agent-*.jsonl` sidechain files that produce no tool cards — so what a reader
// can open blank is 1,546 CARDS, 1,348 with only an image and 201 ToolSearch
// results that dropped the 439 tool names they consisted of. Blocks are the
// bigger number and cards are the honest one; both are stated so neither gets
// borrowed for the other. On the person's own side, 196 user records whose
// body is nothing but attachments produced NO frame at all — the prompt vanished
// from the transcript — and 298 more imported as the words with the screenshot
// they were about removed.
//
// The bytes are NOT carried, and that is a measurement, not a shrug: the corpus
// holds 1.23 GB of base64 image data, an import is a browser-side File.text()
// read with no server blob behind it, and events.ts holds no frame that could
// carry it without claiming the picture was generated here. So the card says
// what was there, in the file's own words for the type and a stated size.
describe("claudeCode adapter (blocks that are not text)", () => {
  const events = parseTranscript(ccBlankCards);
  const outputOf = (callId: string): string =>
    (events.find((e) => e.type === "tool_result" && e.callId === callId) as { output: string }).output;
  const userSaid = events
    .filter((e) => (e as unknown as { type: string }).type === "user_message")
    .map((e) => (e as unknown as { text: string }).text);

  it("names the tools a ToolSearch result loaded instead of returning nothing", () => {
    expect(outputOf("t1")).toBe("WebFetch\nWebSearch");
  });

  it("says an image came back rather than showing an empty card", () => {
    expect(outputOf("t2")).toBe("[image/png · 11 B]");
  });

  it("keeps the text verbatim and adds the screenshot beside it, in the file's order", () => {
    expect(outputOf("t3")).toBe("Took a screenshot of the page.\n[image/jpeg · 6 B]");
  });

  it("hands a tool's own screenshot to the card that answered (card 179)", () => {
    // Roughly 7,300 of the corpus's 8,788 image blocks sit in a tool_result
    // rather than in a person's message, so this is the bulk of what was lost.
    const state = reduceAll(initialState, events);
    const carded = Object.values(state.cards).filter((c) => (c.images?.length ?? 0) > 0);
    expect(carded.length).toBeGreaterThan(0);
    expect(carded[0].images?.[0].dataBase64.length).toBeGreaterThan(0);
  });

  it("keeps a text-only result byte-identical", () => {
    const linear = parseTranscript(ccLinear);
    const call = linear.find((e) => e.type === "tool_result") as { output: string };
    expect(call.output).not.toMatch(/^\[/);
    expect(call.output).not.toContain("\n[");
  });

  it("carries the picture itself, not a sentence about it (card 179)", () => {
    // This is what changed, and it is the whole point: the bytes were in the
    // file all along and the importer measured them and threw them away.
    const shots = events.filter(
      (e) => (e as unknown as { type: string }).type === "attachment_image",
    ) as unknown as { mediaType: string; dataBase64: string; note: string }[];
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.some((s) => s.mediaType === "image/png")).toBe(true);
    expect(shots.every((s) => s.dataBase64.length > 0)).toBe(true);
    // The file's own sentence rides along, so every surface has an alt without
    // recomputing a size or inventing a word.
    expect(shots.some((s) => s.note === "[image/png · 11 B]")).toBe(true);
  });

  it("does not ALSO print the note for a picture it drew", () => {
    // A reader must not get the picture and "[image/png · 11 B]" beside it.
    expect(userSaid).not.toContain("[image/png · 11 B]");
  });

  it("puts the picture and the words in the person's bubble, in the file's order", () => {
    const state = reduceAll(initialState, events);
    const withShot = state.turns.find(
      (t) => t.kind === "user" && (t as { text?: string }).text === "this is the frame I meant",
    ) as { text: string; attachments?: { mediaType: string; dataBase64: string }[] } | undefined;
    expect(withShot).toBeDefined();
    expect(withShot?.attachments?.[0].mediaType).toBe("image/jpeg");
    expect(withShot?.attachments?.[0].dataBase64.length).toBeGreaterThan(0);
    // A screenshot pasted BEFORE the sentence it is about reads as one message,
    // which is why it joins the bubble rather than standing alone.
    expect(withShot?.text).toBe("this is the frame I meant");
  });

  it("names a document by the media type the file gave it", () => {
    // Off the renderable allowlist, so the note is still the whole answer —
    // which is the honest one: this app has no PDF renderer.
    expect(userSaid).toContain("[application/pdf · 6 B]");
  });

  it("never puts an attachment note in the model's mouth", () => {
    const state = reduceAll(initialState, events);
    const answered = state.turns.filter((t) => t.kind === "assistant").map((t) => t.text);
    expect(answered.join("\n")).not.toContain("[image/");
  });
});

// The tool's own return value, carried to the card it belongs to (card 167,
// finding 5). 44,208 records in the corpus hold a `toolUseResult` and the
// importer read none of it, so a Read card showed the body with the line-number
// gutter welded on, a Bash card ran stdout and stderr together, an Edit card
// never said where the change landed and a TaskUpdate card could not draw the
// state it came from. It rides an IMPORT-ONLY frame: nothing in events.ts gains
// a field, and wire/nonWire.ts keeps it out of every file this app writes.
describe("claudeCode adapter (what the tool actually returned)", () => {
  const events = parseTranscript(ccToolResult);
  const detailOf = (callId: string): Record<string, unknown> | undefined =>
    (
      events.find(
        (e) =>
          (e as unknown as { type: string }).type === "tool_result_detail" &&
          (e as unknown as { callId: string }).callId === callId,
      ) as unknown as { detail: Record<string, unknown> } | undefined
    )?.detail;

  it("carries the file body without the gutter the block welded on", () => {
    expect(detailOf("r1")?.fileContent).toBe("# Heading\n\n- one");
    // The block itself is untouched: the output is what the model was shown.
    const result = events.find((e) => e.type === "tool_result" && e.callId === "r1") as { output: string };
    expect(result.output).toBe("1\t# Heading\n2\t\n3\t- one");
  });

  it("carries the page the read returned, and that it stopped at the cap", () => {
    expect(detailOf("r1")).toMatchObject({ startLine: 1, numLines: 3, totalLines: 611, truncated: true });
  });

  it("keeps the two Bash streams apart", () => {
    expect(detailOf("b1")).toMatchObject({
      stdout: " 66M\tapp.asar\n",
      stderr: "\nShell cwd was reset to /tmp\n",
    });
  });

  it("carries where an edit landed", () => {
    expect(detailOf("e1")?.patch).toEqual([{ oldStart: 51, oldLines: 20, newStart: 51, newLines: 21 }]);
  });

  it("carries the state an update moved out of", () => {
    expect(detailOf("k1")).toMatchObject({ statusFrom: "in_progress", statusTo: "completed" });
  });

  it("says nothing for a call whose record carried no toolUseResult", () => {
    const linear = parseTranscript(ccLinear);
    expect(linear.some((e) => (e as unknown as { type: string }).type === "tool_result_detail")).toBe(false);
  });

  it("puts the detail on the card the reducer built", () => {
    const state = reduceAll(initialState, events);
    expect(state.cards["r1"].detail).toMatchObject({ fileContent: "# Heading\n\n- one" });
    expect(state.cards["b1"].detail).toMatchObject({ stderr: "\nShell cwd was reset to /tmp\n" });
  });

  it("never lets the detail frame into a file this app writes", () => {
    const detail = events.find((e) => (e as unknown as { type: string }).type === "tool_result_detail");
    expect(detail).toBeTruthy();
    expect(isWireEvent(detail as unknown as { type: string })).toBe(false);
  });
});

// COMPACTION, WHICH THE IMPORTER USED TO PASS OVER IN SILENCE (card 167,
// finding 2). events.ts has carried `compaction` all along and five consumers
// render it — the reducer's warn line, the text feed's "[compaction −N turns]",
// the graph's compact node, LabTrace and TraceView — and the importer emitted
// none: measured over the 5,120 transcripts in ~/.claude/projects, 21 boundaries
// in 17 files produced 0 frames. Worse, each boundary is followed one line later
// by the machine's own summary, and all 21 imported as a plain user_message:
// 391,308 characters of the model's prose rendered as the person's words.
describe("claudeCode adapter (compaction)", () => {
  const imported = claudeCodeWithOrigin(
    ccCompaction
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)),
  );
  const events = imported.events;
  const compactions = events.filter((e) => e.type === "compaction");
  const summaries = ccCompaction
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { isCompactSummary?: boolean; message?: { content?: string } })
    .filter((r) => r.isCompactSummary === true)
    .map((r) => r.message?.content ?? "");

  it("marks every boundary whose record names the messages that survived", () => {
    // Three boundaries in the fixture; the third names no survivors, so there
    // is nothing to count and nothing is claimed.
    expect(compactions).toHaveLength(2);
    expect(compactions.every((e) => e.type === "compaction" && e.agentId === "main")).toBe(true);
  });

  it("counts only the turns THIS boundary dropped", () => {
    // Three turns before the first boundary, one preserved: two went. The
    // second boundary preserves the turn after the summary, so the one turn
    // that survived the first boundary is the only one it drops — a count that
    // kept the whole history would say three.
    expect((compactions[0] as { removedTurns: number }).removedTurns).toBe(2);
    expect((compactions[1] as { removedTurns: number }).removedTurns).toBe(1);
  });

  it("states the size of the summary the boundary was followed by", () => {
    expect((compactions[0] as { summaryChars: number }).summaryChars).toBe(summaries[0].length);
    expect((compactions[1] as { summaryChars: number }).summaryChars).toBe(summaries[1].length);
  });

  it("never puts the machine's summary in the person's mouth", () => {
    const said = events.filter((e) => (e as unknown as { type: string }).type === "user_message");
    for (const summary of summaries)
      expect(said.some((e) => (e as unknown as { text: string }).text === summary)).toBe(false);
    // and the boundary that named no survivors does not restore the bubble
    expect(said).toHaveLength(0);
  });

  it("charges the frame to the boundary's own line, where the numbers are", () => {
    const at = imported.origin[events.indexOf(compactions[0])];
    const line = JSON.parse(ccCompaction.split(/\r?\n/).filter((l) => l.trim())[at]);
    expect(line).toMatchObject({ subtype: "compact_boundary", uuid: "s1" });
  });

  it("leaves the summary's words in the file and in no face of the app", () => {
    // The honest half of dropping the bubble: every face of the trace hangs off
    // a ROW (sourcePane reads row.sourceLine, the structured face reads
    // sourceLines[entry.sourceLine]), so a line that produces no frame is
    // reachable from nowhere. The size on the compaction frame is all that
    // survives into the app; the words stay in the transcript on disk.
    // Measured over ~/.claude/projects: 21 frames were charged to an
    // isCompactSummary line before this, 0 after.
    const lines = ccCompaction.split(/\r?\n/).filter((l) => l.trim());
    const summaryLines = new Set(
      lines
        .map((l, i) => [JSON.parse(l) as { isCompactSummary?: boolean }, i] as const)
        .filter(([r]) => r.isCompactSummary === true)
        .map(([, i]) => i),
    );
    // three summaries, one of them behind the boundary that produced no frame
    expect(summaryLines.size).toBe(3);
    expect(events.every((_, k) => !summaryLines.has(imported.origin[k]))).toBe(true);
    // and no frame of any type carries the prose, under any field
    for (const summary of summaries)
      expect(events.some((e) => JSON.stringify(e).includes(summary.slice(0, 24)))).toBe(false);
  });

  it("says nothing about a boundary whose turns the file never named", () => {
    // The module's own rule, applied where the count comes from: a transcript
    // whose records carry no uuid gives preservedMessages nothing to match, so
    // `removedTurns` would be 0 — "nothing was dropped" about a session that
    // was cut in half. A boundary that cannot be counted produces no frame,
    // the same way one that names no survivors does. 0 such files in
    // ~/.claude/projects, so this holds a latch rather than a live bug.
    const nameless = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" } },
      { type: "assistant", message: { role: "assistant", id: "m1", model: "claude-opus-5", content: [] } },
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preservedMessages: { allUuids: ["gone"] } },
      },
    ]);
    expect(nameless.some((e) => e.type === "compaction")).toBe(false);
  });

  it("reaches the reader through the consumers that were already there", () => {
    const state = reduceAll(initialState, events);
    // With a summary in the window the chat line names its size too — all 21
    // boundaries in ~/.claude/projects carry one, 391,308 characters in total,
    // and `summaryChars` had no surface until it did.
    expect(state.turns.some((t) => t.kind === "info" && t.infoKey === "info.compactedInto")).toBe(true);
    expect(buildTextFeed(events).some((l) => l.text === "[compaction −2 turns]")).toBe(true);
  });

  it("stays out of every file this app writes", () => {
    // `compaction` IS on the wire, so this one travels — the point of using it.
    expect(isWireEvent(compactions[0] as unknown as { type: string })).toBe(true);
  });
});

// AN OUTAGE READ AS AN ANSWER (card 167, finding 3). Measured over the same
// 5,120 transcripts: 67 `system[subtype=api_error]` records produced no frame at
// all, so a retry ladder was a silent gap in the clock, and 350
// `isApiErrorMessage` records imported their outage text as a `text_delta` — 83
// of them reachable in a session import, each costing a turn and each announcing
// a switch to a model called "<synthetic>". Both are the `error` event that
// events.ts has carried since the beginning.
describe("claudeCode adapter (API failures)", () => {
  const events = parseTranscript(ccApiError);
  const errors = events.filter((e) => e.type === "error");

  it("frames the failure the client recorded, in the file's own words", () => {
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatchObject({ type: "error", agentId: "main" });
    // formatted first, verbatim; the retry the client then made rides in the
    // same sentence, because `error` has no field for it and inventing one
    // would put a reading of somebody else's file on our wire.
    expect((errors[0] as { message: string }).message).toBe("429 Rate limited · retry 1/10");
  });

  it("says nothing about a retry the record did not record", () => {
    // No `formatted`, no retryAttempt: the message is the one string there is.
    expect((errors[1] as { message: string }).message).toBe("Connection error.");
  });

  it("reads the outage as an error and not as the assistant answering", () => {
    expect((errors[2] as { message: string }).message).toBe("API Error: Overloaded");
    expect(events.some((e) => e.type === "text_delta" && e.text === "API Error: Overloaded")).toBe(false);
  });

  it("keeps the turn the run attempted", () => {
    // The request was made and it failed; the clock and the turn count say so.
    const turns = events.filter((e) => e.type === "turn_start" && e.agentId === "main");
    expect(turns.map((e) => (e as { turn: number }).turn)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not announce a switch to a model called <synthetic>", () => {
    const synthetic = events.filter((e) => {
      const frame = e as unknown as { type: string; model?: string };
      return frame.type === "provider_info" && frame.model === "<synthetic>";
    });
    // Exactly one, and it is the record that is NOT an error: the flag says
    // "this synthetic message is an error", and only the true case is read.
    expect(synthetic).toHaveLength(1);
    expect(events.some((e) => e.type === "text_delta" && e.text === "No response requested.")).toBe(true);
  });

  it("does not open the file on <synthetic> either", () => {
    // The up-front announcement takes the file's FIRST model, and 121 of the
    // corpus's transcripts open on an outage record — so the run announced a
    // model called "<synthetic>" before a word was said, and run_start.model
    // carried it too.
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "e0",
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: Overloaded" }],
        },
        uuid: "a0",
        parentUuid: "u1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: "m0",
          model: "claude-opus-5",
          content: [{ type: "text", text: "back" }],
        },
        uuid: "a1",
        parentUuid: "a0",
      },
    ]);
    expect(events.some((e) => (e as unknown as { model?: string }).model === "<synthetic>")).toBe(false);
    expect(events[0]).toMatchObject({ type: "provider_info", model: "claude-opus-5" });
  });

  it("still opens on a synthetic model the file does not call an error", () => {
    // Where the skip stops, measured rather than assumed. The filter follows
    // the file's own flag, so a record marked isApiErrorMessage:false is read
    // as what it says even when its model is the literal "<synthetic>".
    // Over ~/.claude/projects the skip takes the up-front announcement from 122
    // to 1 and every "<synthetic>" announcement from 191 to 29, and it leaves
    // run_start.model exactly where it was: 1 file before, the same 1 after
    // (6b9d11d3-4fea-4964-99f3-6c3aea453b59). The 28 announcements that remain
    // sit on records reading "No response requested.". Guessing from the model
    // string instead would be us deciding what somebody else's record meant.
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" }, uuid: "u1" },
      {
        type: "assistant",
        isApiErrorMessage: false,
        message: {
          role: "assistant",
          id: "n0",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
        uuid: "a0",
        parentUuid: "u1",
      },
    ]);
    expect(events[0]).toMatchObject({ type: "provider_info", model: "<synthetic>" });
    expect(
      events.some((e) => e.type === "run_start" && (e as { model?: string }).model === "<synthetic>"),
    ).toBe(true);
  });

  it("leaves a subagent's outage under the subagent", () => {
    expect(errors[3]).toMatchObject({
      type: "error",
      agentId: "t1",
      message: "You've hit your session limit - resets 3:20pm (Europe/Berlin)",
    });
  });

  it("reaches the reader through the consumers that were already there", () => {
    const state = reduceAll(initialState, events);
    expect(state.turns.filter((t) => t.kind === "error").map((t) => t.text)).toContain(
      "429 Rate limited · retry 1/10",
    );
    expect(buildTextFeed(events).some((l) => l.text === "[error] API Error: Overloaded")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card 167, findings 1 and 6: the subagent's own numbers.
//
// A modern transcript never holds its children: measured over the 5,132 files
// in ~/.claude/projects on 2026-08-04, 0 of 311,332 sidechain records resolve
// an owner in their own file, and 4,674 files are sidechain-only. What a
// session file DOES hold is the launch record, and its toolUseResult carries
// the child's model, its token bill and whether it ever reported back.
// ---------------------------------------------------------------------------

/** A parent session that launches two children: one reported back, one did not. */
const launches: unknown[] = [
  { type: "user", message: { role: "user", content: "fan out" }, uuid: "u1", parentUuid: null },
  {
    type: "assistant",
    message: {
      role: "assistant",
      id: "m1",
      model: "claude-opus-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_done",
          name: "Agent",
          input: { description: "review the diff", subagent_type: "code-reviewer" },
        },
      ],
    },
    uuid: "a1",
    parentUuid: "u1",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "three findings" }],
    },
    toolUseResult: {
      status: "completed",
      resolvedModel: "claude-haiku-4-5-20251001",
      totalDurationMs: 420972,
      totalTokens: 60607,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 3536,
        cache_read_input_tokens: 54290,
        output_tokens: 2779,
      },
    },
    uuid: "u2",
    parentUuid: "a1",
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      id: "m2",
      model: "claude-opus-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_async",
          name: "Agent",
          input: { description: "translate the pitch", subagent_type: "Explore" },
        },
      ],
    },
    uuid: "a2",
    parentUuid: "u2",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_async", content: "Async agent launched successfully." },
      ],
    },
    toolUseResult: {
      isAsync: true,
      status: "async_launched",
      resolvedModel: "claude-opus-4-8[1m]",
      outputFile: "/private/tmp/tasks/afa7775.output",
    },
    uuid: "u3",
    parentUuid: "a2",
  },
];

describe("claudeCode adapter (the subagent's own numbers)", () => {
  const events = claudeCodeToRunEvents(launches);
  const roster = reduceAll(initialState, events).agents;

  it("counts the child's tokens, under the child", () => {
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        agentId: "toolu_done",
        inputTokens: 2,
        outputTokens: 2779,
        cacheReadTokens: 54290,
        cacheCreationTokens: 3536,
      }),
    );
  });

  it("puts those tokens on the child's roster row and in the session total", () => {
    expect(roster.find((a) => a.id === "toolu_done")?.outTokens).toBe(2779);
    expect(reduceAll(initialState, events).usage.outputTokens).toBe(2779);
  });

  it("names the model the child actually ran on, not the parent's", () => {
    expect(roster.find((a) => a.id === "toolu_done")?.model).toBe("claude-haiku-4-5-20251001");
    expect(roster.find((a) => a.id === "toolu_async")?.model).toBe("claude-opus-4-8[1m]");
  });

  it("does not announce the child's model as the run's own", () => {
    // provider_info is latest-wins for the whole run: a child announcement
    // would tell the reader the session had switched models.
    const announced = (events as unknown as { type: string; model?: string }[])
      .filter((e) => e.type === "provider_info")
      .map((e) => e.model);
    expect(announced).toEqual(["claude-opus-5"]);
  });

  it("does not draw a launch that never reported back as finished", () => {
    expect(roster.find((a) => a.id === "toolu_async")?.state).toBe("working");
    expect(roster.find((a) => a.id === "toolu_async")?.launched).toBe(true);
  });

  it("still finishes the child that did report back", () => {
    expect(roster.find((a) => a.id === "toolu_done")?.state).toBe("completed");
    expect(roster.find((a) => a.id === "toolu_done")?.launched).toBeUndefined();
  });

  it("keeps the receipt on the parent's card either way", () => {
    const outputs = events
      .filter((e) => e.type === "tool_result")
      .map((e) => (e as unknown as { output: string }).output);
    expect(outputs).toContain("three findings");
    expect(outputs).toContain("Async agent launched successfully.");
  });

  it("says nothing about a launch whose record carries none of it", () => {
    const bare = claudeCodeToRunEvents([
      launches[0],
      launches[1],
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_done", content: "ok" }],
        },
        uuid: "u2",
        parentUuid: "a1",
      },
    ]);
    expect((bare as unknown as { type: string }[]).some((e) => e.type === "agent_detail")).toBe(false);
    expect(bare.some((e) => e.type === "usage" && (e as { agentId: string }).agentId !== "main")).toBe(false);
    expect(reduceAll(initialState, bare).agents.find((a) => a.id === "toolu_done")?.state).toBe("completed");
  });

  it("keeps the child reading out of a session file", () => {
    // agent_detail is a reading of somebody else's transcript, never a frame
    // the wire carries: a writer that let it through would produce a file the
    // Java reader drops without a word.
    expect(events.filter((e) => !isWireEvent(e)).map((e) => e.type)).toContain("agent_detail");
  });
});

// ---------------------------------------------------------------------------
// A launched child that DID report back, in the same file.
//
// "launched, never reported back" is the app's claim about somebody else's
// transcript, and measured over ~/.claude/projects on 2026-08-04 the
// transcript refutes it on 365 of the 394 async launches: a later
// <task-notification> names the same <tool-use-id> and carries a terminal
// <status>. 218 of those sit in the user record this importer already parses;
// the other 147 sit in the `queue-operation` and `queued_command` records it
// already frames. The same import then drew the outcome a second time, as a
// parentless roster row under the task id.
//
// One rule covers all of it: a notification whose <tool-use-id> names a launch
// this file made IS that child reporting back, whichever record carries it.
// ---------------------------------------------------------------------------
const NOTE = (status: string | null, result: string): string =>
  [
    "<task-notification>",
    "<task-id>a1758523bf8ddf207</task-id>",
    "<tool-use-id>toolu_async</tool-use-id>",
    "<output-file>/private/tmp/tasks/a1758523bf8ddf207.output</output-file>",
    ...(status === null ? [] : [`<status>${status}</status>`]),
    '<summary>Agent "translate the pitch" completed</summary>',
    `<result>${result}</result>`,
    "</task-notification>",
  ].join("\n");

/** The notification as a user record — the channel the importer already read. */
const asUser = (text: string): unknown => ({
  type: "user",
  message: { role: "user", content: text },
  uuid: "u4",
  parentUuid: "u3",
});

describe("a launched child that reported back later in the same file", () => {
  const fold = (note: unknown) => {
    const events = claudeCodeToRunEvents([...launches, note]);
    return { events, roster: reduceAll(initialState, events).agents };
  };
  const { events, roster } = fold(asUser(NOTE("completed", "Saved 11 lines.")));
  const child = roster.find((a) => a.id === "toolu_async");

  it("finishes the child the notification finished", () => {
    expect(child?.state).toBe("completed");
  });

  it("takes the badge back off — the file says it reported back", () => {
    expect(child?.launched).toBeUndefined();
  });

  it("does not draw the same child a second time, parentless, under its task id", () => {
    expect(roster.map((a) => a.id)).not.toContain("a1758523bf8ddf207");
    expect(roster.filter((a) => a.parentId !== null).map((a) => a.id)).toEqual(["toolu_done", "toolu_async"]);
  });

  it("lands the notification's own words, under the child", () => {
    const msg = events.find(
      (e) => e.type === "agent_message" && (e as { from?: string }).from === "toolu_async",
    ) as unknown as { role: string; state: string; to: string; text: string } | undefined;
    expect(msg).toMatchObject({ role: "result", state: "completed", to: "main" });
    expect(msg?.text).toContain("Saved 11 lines.");
    // The join keys and the machine-local path are not words about the run.
    expect(msg?.text).not.toContain("/private/tmp/tasks");
  });

  it("keeps the model the launch record named", () => {
    expect(child?.model).toBe("claude-opus-4-8[1m]");
  });

  it("does not turn the launch receipt into the child's answer", () => {
    const results = events.filter(
      (e) => e.type === "agent_message" && (e as { role?: string }).role === "result",
    ) as unknown as { from: string; text: string }[];
    expect(results.find((m) => m.from === "toolu_async")?.text).not.toContain("launched successfully");
  });

  it("reads the same block out of a queue-operation record", () => {
    const { roster: r } = fold({
      type: "queue-operation",
      operation: "enqueue",
      content: NOTE("completed", "Saved 11 lines."),
    });
    expect(r.find((a) => a.id === "toolu_async")?.state).toBe("completed");
    expect(r.find((a) => a.id === "toolu_async")?.launched).toBeUndefined();
  });

  it("reads the same block out of a queued_command attachment", () => {
    const { roster: r } = fold({
      type: "attachment",
      attachment: { type: "queued_command", prompt: NOTE("completed", "Saved 11 lines.") },
      uuid: "u4",
      parentUuid: "u3",
    });
    expect(r.find((a) => a.id === "toolu_async")?.state).toBe("completed");
    expect(r.find((a) => a.id === "toolu_async")?.launched).toBeUndefined();
  });

  it("lands the same block once when two records carry it", () => {
    const text = NOTE("completed", "Saved 11 lines.");
    const events2 = claudeCodeToRunEvents([
      ...launches,
      { type: "queue-operation", operation: "enqueue", content: text },
      { type: "attachment", attachment: { type: "queued_command", prompt: text }, uuid: "u4" },
      asUser(text),
    ]);
    expect(
      events2.filter((e) => e.type === "agent_message" && (e as { from?: string }).from === "toolu_async"),
    ).toHaveLength(1);
  });

  it("fails the child a failed report failed", () => {
    const { roster: r } = fold(asUser(NOTE("failed", "the sandbox died")));
    expect(r.find((a) => a.id === "toolu_async")?.state).toBe("failed");
    expect(r.find((a) => a.id === "toolu_async")?.launched).toBeUndefined();
  });

  it("leaves a progress report as progress — reported, not finished", () => {
    const { roster: r } = fold(asUser(NOTE(null, "still reading")));
    const c = r.find((a) => a.id === "toolu_async");
    // It reported in, so the badge's sentence is false; it did not end, so the
    // row is not completed either.
    expect(c?.state).toBe("working");
    expect(c?.launched).toBeUndefined();
    expect(c?.lastStatus).toContain("still reading");
  });

  it("holds a report the file wrote down BEFORE the launch it answers", () => {
    // 4 rows in ~/.claude/projects: a compaction replayed the launch after the
    // queue-operation that had already taken the notification. Landing the
    // outcome where it sits would put the ending in front of the spawn, and
    // the task message right after it would reset the row to "submitted" — the
    // file says completed, and the app would have said not started.
    const events = claudeCodeToRunEvents([
      launches[0],
      { type: "queue-operation", operation: "enqueue", content: NOTE("completed", "Saved 11 lines.") },
      launches[3],
      launches[4],
    ]);
    const roster = reduceAll(initialState, events).agents;
    expect(roster.find((a) => a.id === "toolu_async")?.state).toBe("completed");
    expect(roster.find((a) => a.id === "toolu_async")?.launched).toBeUndefined();
    const kinds = (events as unknown as { type: string; from?: string; role?: string }[])
      .filter((e) => (e.type === "agent_spawn" && e.from === undefined) || e.from === "toolu_async")
      .map((e) => `${e.type}${e.role === undefined ? "" : `:${e.role}`}`);
    expect(kinds).toEqual(["agent_spawn", "agent_message:result"]);
  });

  it("does not un-finish a child whose launch a compaction replayed", () => {
    // 1 row in ~/.claude/projects: the launch record comes back 926 records
    // later, and the task message riding with it says "submitted". A child the
    // file had already reported completed went back to not-started.
    const events = claudeCodeToRunEvents([...launches, asUser(NOTE("completed", "done")), launches[3]]);
    const roster = reduceAll(initialState, events).agents;
    expect(roster.find((a) => a.id === "toolu_async")?.state).toBe("completed");
    expect(roster.filter((a) => a.id === "toolu_async")).toHaveLength(1);
    expect(events.filter((e) => e.type === "agent_spawn")).toHaveLength(2);
  });

  it("still says nothing about a launch this file never mentions again", () => {
    const { roster: r } = fold(asUser(NOTE("completed", "done").replace("toolu_async", "toolu_other")));
    expect(r.find((a) => a.id === "toolu_async")).toMatchObject({ state: "working", launched: true });
  });
});

describe("claudeCode adapter (a subagent that IS in the file)", () => {
  // The older layout, and the one the child-run machinery was built for: the
  // child's own records live in the parent's file. 0 of today's corpus does
  // this, and the branch has to count tokens anyway or a file that does will
  // silently drop them again.
  const withChild: unknown[] = [
    { type: "user", message: { role: "user", content: "go" }, uuid: "u1", parentUuid: null },
    {
      type: "assistant",
      message: {
        role: "assistant",
        id: "m1",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "task1", name: "Task", input: { description: "read it" } }],
      },
      uuid: "a1",
      parentUuid: "u1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        id: "c1",
        model: "claude-opus-5",
        content: [{ type: "text", text: "read" }],
        usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 },
      },
      uuid: "s1",
      parentUuid: "task1",
      isSidechain: true,
    },
  ];

  it("charges a sidechain response to the subagent that produced it", () => {
    const events = claudeCodeToRunEvents(withChild);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        agentId: "task1",
        inputTokens: 11,
        outputTokens: 22,
        cacheReadTokens: 33,
      }),
    );
  });

  it("leaves the context ring alone — the child has its own window", () => {
    const state = reduceAll(initialState, claudeCodeToRunEvents(withChild));
    expect(state.lastInputTokens).toBe(0);
    expect(state.usage.outputTokens).toBe(22);
  });

  it("charges the response ONCE when both the child and the launch record bill it", () => {
    // The launch record's `usage` is the child's whole run — `totalTokens` on
    // the real records is exactly its four counters added up. A file that also
    // holds the child's own records therefore says the same bill twice, and
    // charging both paths doubled the child and the session total. The child's
    // own records win: they are the per-response grain, and the summary is the
    // same money counted again.
    const mixed = [
      ...withChild,
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "task1", content: "read" }],
        },
        toolUseResult: {
          status: "completed",
          resolvedModel: "claude-haiku-4-5-20251001",
          totalTokens: 66,
          usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 },
        },
        uuid: "u2",
        parentUuid: "a1",
      },
    ];
    const events = claudeCodeToRunEvents(mixed);
    expect(
      events.filter((e) => e.type === "usage" && (e as { agentId: string }).agentId === "task1"),
    ).toHaveLength(1);
    const state = reduceAll(initialState, events);
    expect(state.agents.find((a) => a.id === "task1")?.outTokens).toBe(22);
    expect(state.usage.outputTokens).toBe(22);
    // The rest of the launch record's reading is unaffected.
    expect(state.agents.find((a) => a.id === "task1")?.model).toBe("claude-haiku-4-5-20251001");
  });
});

// WHERE THE RUN STOOD, AND WHEN IT MOVED (card 167, finding 8).
//
// Every user, assistant, system and attachment record stamps the working
// directory, the git branch and the client version. Measured over the 167
// session transcripts in ~/.claude/projects: 104 of them (62%) carry more than
// one cwd, 32 more than one gitBranch, 12 more than one version. A run that
// walked from a repo root into a worktree and back is a fact about every
// relative path in every tool result after it, and the app said nothing.
//
// The importer already has the shape: provider_info is announced once up front
// and again at each model switch. ground_info is the same announcement about
// the ground under the run, and it is IMPORT-ONLY — a reading of somebody
// else's file, never a frame our wire carries.
describe("the ground under an imported run", () => {
  // ground_info is IMPORT-ONLY, so it is deliberately not in the RunEvent
  // union and the compiler is right to refuse a direct comparison. Same read
  // as the four card-141 kinds get everywhere else in this file.
  const typeOf = (e: RunEvent): string => (e as unknown as { type: string }).type;
  const ground = (events: RunEvent[]): unknown[] => events.filter((e) => typeOf(e) === "ground_info");

  it("announces where the run stood, once, off the first line that says so", () => {
    const events = claudeCodeToRunEvents([
      { type: "queue-operation", operation: "enqueue" },
      {
        type: "user",
        cwd: "/Users/x/repo",
        gitBranch: "main",
        version: "2.1.170",
        message: { role: "user", content: "go" },
      },
      {
        type: "assistant",
        cwd: "/Users/x/repo",
        gitBranch: "main",
        version: "2.1.170",
        message: {
          role: "assistant",
          id: "m1",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);
    expect(ground(events)).toEqual([
      expect.objectContaining({
        type: "ground_info",
        cwd: "/Users/x/repo",
        gitBranch: "main",
        version: "2.1.170",
      }),
    ]);
    // No `from` on the opening announcement: nothing was left behind.
    expect(ground(events)[0]).not.toHaveProperty("from");
  });

  it("says nothing at all about a file that records no ground", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        message: { role: "assistant", id: "m1", content: [{ type: "text", text: "ok" }] },
      },
    ]);
    expect(ground(events)).toEqual([]);
  });

  it("carries only the fields the file recorded", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", cwd: "/Users/x/repo", message: { role: "user", content: "go" } },
    ]);
    expect(ground(events)).toEqual([expect.objectContaining({ cwd: "/Users/x/repo" })]);
    expect(ground(events)[0]).not.toHaveProperty("gitBranch");
    expect(ground(events)[0]).not.toHaveProperty("version");
  });

  it("marks a move, naming what it left and what it landed on", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", cwd: "/Users/x/repo", gitBranch: "main", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        cwd: "/Users/x/repo/worktrees/wt",
        gitBranch: "main",
        message: {
          role: "assistant",
          id: "m1",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);
    const moves = ground(events);
    expect(moves).toHaveLength(2);
    expect(moves[1]).toMatchObject({
      type: "ground_info",
      cwd: "/Users/x/repo/worktrees/wt",
      from: { cwd: "/Users/x/repo" },
    });
    // The branch did not move, so the move frame says nothing about it.
    expect(moves[1]).not.toHaveProperty("gitBranch");
  });

  it("puts two fields that moved together on one frame", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", cwd: "/a", gitBranch: "main", message: { role: "user", content: "go" } },
      {
        type: "assistant",
        cwd: "/b",
        gitBranch: "feature",
        message: {
          role: "assistant",
          id: "m1",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);
    expect(ground(events)[1]).toMatchObject({
      cwd: "/b",
      gitBranch: "feature",
      from: { cwd: "/a", gitBranch: "main" },
    });
  });

  // 3,221 of the corpus's 3,692 cwd moves return to a directory the session
  // already stood in (measured 2026-08-04). A move back is exactly as real as a move away — the
  // relative paths in the tool results after it mean what they meant before —
  // so it is announced, and it is announced as a move rather than as a repeat
  // of the opening.
  it("announces a move back to where it came from", () => {
    const at = (cwd: string, id: string): unknown => ({
      type: "assistant",
      cwd,
      message: { role: "assistant", id, model: "claude-opus-5", content: [{ type: "text", text: "x" }] },
    });
    const events = claudeCodeToRunEvents([
      { type: "user", cwd: "/a", message: { role: "user", content: "go" } },
      at("/b", "m1"),
      at("/a", "m2"),
    ]);
    const moves = ground(events);
    expect(moves).toHaveLength(3);
    expect(moves[2]).toMatchObject({ cwd: "/a", from: { cwd: "/b" } });
  });

  // A ground frame is a reading of the record's own line, so the source face
  // opens on the line that recorded the move.
  it("charges each ground frame to the line that recorded it", () => {
    const text = [
      JSON.stringify({ type: "user", cwd: "/a", message: { role: "user", content: "go" } }),
      JSON.stringify({
        type: "assistant",
        cwd: "/b",
        message: {
          role: "assistant",
          id: "m1",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
        },
      }),
    ].join("\n");
    const { events, source } = detectAndLoad(text);
    const at = events.map((e, n) => (typeOf(e) === "ground_info" ? n : -1)).filter((n) => n >= 0);
    expect(at).toHaveLength(2);
    expect([source.origin[at[0]], source.origin[at[1]]]).toEqual([0, 1]);
  });

  it("never reaches a written session file", () => {
    const events = claudeCodeToRunEvents([
      { type: "user", cwd: "/a", message: { role: "user", content: "go" } },
    ]);
    expect(ground(events)).toHaveLength(1); // it is emitted …
    expect(events.filter(isWireEvent).some((e) => typeOf(e) === "ground_info")).toBe(false); // … and unwritable
  });
});

// Card 179, the commonest shape of all: the pictures a session OPENS with.
// The first user record becomes the run_start and never enters the block loop,
// so this is the case that would have been missed while every other one worked.
describe("a session that opens with a screenshot", () => {
  const opening = [
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
          { type: "text", text: "why is this broken" },
        ],
      },
      uuid: "u1",
      timestamp: "2026-08-05T10:00:00.000Z",
    }),
  ].join("\n");

  it("puts both pictures in the opening bubble, with the prompt", () => {
    const state = reduceAll(initialState, parseTranscript(opening));
    const first = state.turns.find((t) => t.kind === "user") as
      { text: string; attachments?: { mediaType: string }[] } | undefined;
    expect(first?.text).toContain("why is this broken");
    expect(first?.attachments?.map((a) => a.mediaType)).toEqual(["image/png", "image/jpeg"]);
  });

  it("emits them BEFORE the run_start, or they arrive at an empty room", () => {
    const types = parseTranscript(opening).map((e) => (e as unknown as { type: string }).type);
    expect(types.indexOf("attachment_image")).toBeLessThan(types.indexOf("run_start"));
  });
});
