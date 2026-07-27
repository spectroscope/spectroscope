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
import { claudeCodeToRunEvents, parseTranscript } from "./claudeCode";
import { advanceScene, initialScene } from "../lab/labScene";
import { initialState, reduceAll } from "../state/reducer";

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

  it("skips leading metadata records and opens with the real user prompt", () => {
    expect(events[0]).toMatchObject({ type: "run_start", agentId: "main" });
    expect((events[0] as { prompt: string }).prompt).toMatch(/check the tests/);
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
