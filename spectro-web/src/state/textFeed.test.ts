import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildTextFeed, eventsToJsonl, feedToPlainText } from "./textFeed";

const ts = 1;

function feedTexts(events: RunEvent[]): string[] {
  return buildTextFeed(events).map((s) => s.text);
}

describe("buildTextFeed — the <think> boundaries", () => {
  it("wraps a contiguous reasoning run in <think> … </think> when the answer starts", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "2+2?", provider: "ollama", ts },
      { type: "thinking_delta", agentId: "main", text: "The user ", ts },
      { type: "thinking_delta", agentId: "main", text: "wants math.", ts },
      { type: "text_delta", agentId: "main", text: "4", ts },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
    ];
    expect(feedTexts(events)).toEqual([
      "[run_start ollama]",
      "2+2?",
      "<think>",
      "The user wants math.",
      "</think>",
      "4",
      "[run_end end_turn]",
    ]);
  });

  it("closes the reasoning run when a tool call interrupts it", () => {
    const events: RunEvent[] = [
      { type: "thinking_delta", agentId: "main", text: "I should look.", ts },
      { type: "tool_call", agentId: "main", callId: "c1", name: "list_dir", input: { path: "apps" }, ts },
      {
        type: "tool_result",
        agentId: "main",
        callId: "c1",
        output: "cli\nweb",
        isError: false,
        durationMs: 9,
        ts,
      },
    ];
    expect(feedTexts(events)).toEqual([
      "<think>",
      "I should look.",
      "</think>",
      '[tool_call list_dir {"path":"apps"}]',
      "[tool_result list_dir · 9ms]",
      "cli\nweb",
    ]);
  });

  it("closes an open reasoning run at run_end (thinking-only turns)", () => {
    const events: RunEvent[] = [
      { type: "thinking_delta", agentId: "main", text: "hmm", ts },
      { type: "run_end", runId: "r1", stopReason: "aborted", ts },
    ];
    expect(feedTexts(events)).toEqual(["<think>", "hmm", "</think>", "[run_end aborted]"]);
  });

  it("a second reasoning run opens its own tags", () => {
    const events: RunEvent[] = [
      { type: "thinking_delta", agentId: "main", text: "first", ts },
      { type: "text_delta", agentId: "main", text: "answer", ts },
      { type: "thinking_delta", agentId: "main", text: "second", ts },
      { type: "text_delta", agentId: "main", text: " more", ts },
    ];
    expect(feedTexts(events)).toEqual([
      "<think>",
      "first",
      "</think>",
      "answer",
      "<think>",
      "second",
      "</think>",
      " more",
    ]);
  });
});

describe("buildTextFeed — tools, gate, children", () => {
  it("carries the full tool result output and marks errors", () => {
    const events: RunEvent[] = [
      { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: { path: "x" }, ts },
      {
        type: "tool_result",
        agentId: "main",
        callId: "c1",
        output: "ERROR: not found",
        isError: true,
        durationMs: 2,
        ts,
      },
    ];
    expect(feedTexts(events)).toEqual([
      '[tool_call read_file {"path":"x"}]',
      "[tool_result read_file ERROR · 2ms]",
      "ERROR: not found",
    ]);
  });

  it("shows the permission gate as protocol markers", () => {
    const events: RunEvent[] = [
      {
        type: "permission_request",
        agentId: "main",
        callId: "c1",
        name: "run_command",
        input: { command: "ls" },
        ts,
      },
      { type: "permission_decision", callId: "c1", allowed: true, ts },
    ];
    expect(feedTexts(events)).toEqual([
      '[permission_request run_command {"command":"ls"}]',
      "[permission granted]",
    ]);
  });

  it("keeps child agents attributed and interleaved in wire order", () => {
    const events: RunEvent[] = [
      { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "Explore apps/", ts },
      { type: "thinking_delta", agentId: "explore-1", text: "child thinks", ts },
      { type: "text_delta", agentId: "main", text: "parent talks", ts },
      { type: "text_delta", agentId: "explore-1", text: "child answers", ts },
    ];
    const feed = buildTextFeed(events);
    expect(feed.map((s) => `${s.agentId}:${s.text}`)).toEqual([
      "explore-1:[agent_spawn explore-1 ← Explore apps/]",
      "explore-1:<think>",
      "explore-1:child thinks",
      "main:parent talks",
      // the child's reasoning run is still open — its </think> comes with its
      // own next boundary, not the parent's text
      "explore-1:</think>",
      "explore-1:child answers",
    ]);
    expect(feedToPlainText(feed)).toContain("[explore-1] child answers");
  });

  it("a child run_start repeats no prompt (the spawn marker already carries the task)", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main", prompt: "Explore apps/", ts },
    ];
    expect(feedTexts(events)).toEqual([]);
  });
});

describe("eventsToJsonl", () => {
  it("serializes one compact line per wire event and drops socket-only frames", () => {
    const events = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts },
      { type: "provider_info", provider: "ollama", model: "qwen3", host: "localhost:11434" },
      { type: "workspace_info", sessionId: "s", path: "/tmp/x", configured: false },
      { type: "permission_mode_info", mode: "ask" },
      { type: "text_delta", agentId: "main", text: "hello", ts },
    ] as unknown as RunEvent[];
    const lines = eventsToJsonl(events);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"type":"run_start","runId":"r1","agentId":"main","prompt":"hi","ts":1}');
    expect(lines[1]).toContain('"text":"hello"');
  });
});

describe("buildTextFeed — the extended feed (owner 2026-07-26)", () => {
  const events = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts: 1 },
    { type: "turn_start", agentId: "main", turn: 1, ts: 2 },
    {
      type: "context_info",
      agentId: "main",
      turn: 1,
      messages: 2,
      estimatedTokens: 300,
      threshold: 100000,
      parts: [
        { label: "system prompt", chars: 40, estTokens: 10, text: "You are spectroscope, a coding agent." },
        { label: "conversation", chars: 8, estTokens: 2, text: "USER:\ngo\n" },
      ],
      ts: 3,
    },
    { type: "text_delta", agentId: "main", text: "hi", ts: 4 },
    { type: "usage", agentId: "main", inputTokens: 120, outputTokens: 8, ts: 5 },
    { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 6 },
  ] as unknown as RunEvent[];

  it("the normal feed stays a reading feed — no context, no usage", () => {
    const text = buildTextFeed(events)
      .map((s) => s.text)
      .join("\n");
    expect(text).not.toContain("You are spectroscope");
    expect(text).not.toContain("120 in");
  });

  it("extended carries the WHOLE request — the system prompt the model got", () => {
    const segments = buildTextFeed(events, true);
    const text = segments.map((s) => s.text).join("\n");
    expect(text).toContain("[context_info");
    expect(text).toContain("You are spectroscope, a coding agent.");
    expect(text).toContain("system prompt");
    expect(text).toContain("USER:");
  });

  it("extended shows the token truth and the turn boundaries", () => {
    const text = buildTextFeed(events, true)
      .map((s) => s.text)
      .join("\n");
    expect(text).toContain("120 in");
    expect(text).toContain("8 out");
    expect(text).toContain("[turn_start 1]");
  });

  it("extended never loses what the normal feed had", () => {
    const normal = buildTextFeed(events).map((s) => s.text);
    const extended = buildTextFeed(events, true).map((s) => s.text);
    for (const block of normal) {
      expect(extended).toContain(block);
    }
  });
});

// A user turn read out of a transcript (the follow-up prompt).
//
// The reading feed is "every piece of text the protocol carries, in wire
// order". A session's second prompt is text the protocol carried, and it is the
// reason the answer after it changes subject; without it the feed reads as one
// unbroken monologue. It goes in the READING feed, not behind `extended`: the
// extended flag is for the frames a reader does not need (usage, turn
// boundaries, the assembled request), and a prompt is not one of those.
describe("buildTextFeed (a user turn from the stream)", () => {
  const said = (text: string, ts = 2): RunEvent =>
    ({ type: "user_message", text, ts }) as unknown as RunEvent;

  it("reads a follow-up prompt as a prompt, in wire order", () => {
    const feed = buildTextFeed([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "first", ts: 0 },
      { type: "text_delta", agentId: "main", text: "answer", ts: 1 },
      said("second"),
    ]);
    expect(feed.map((s) => [s.kind, s.text])).toEqual([
      ["marker", "[run_start]"],
      ["prompt", "first"],
      ["answer", "answer"],
      ["prompt", "second"],
    ]);
  });

  it("closes an open reasoning run before it, like every other boundary", () => {
    // A prompt cannot land inside a <think> block: the tags would not balance
    // and the whole rest of the feed would read as reasoning.
    const feed = buildTextFeed([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "first", ts: 0 },
      { type: "thinking_delta", agentId: "main", text: "hmm", ts: 1 },
      said("stop"),
    ]);
    expect(feed.map((s) => s.text)).toEqual(["[run_start]", "first", "<think>", "hmm", "</think>", "stop"]);
  });
});

// Cards 281 and 282: the accessible reading carries all three self-reports.
//
// Card 281's criterion 5 says the textFeed case lands in the same pass, "or the
// accessible reading omits the one line this card exists for". The transcript
// and this feed are two readings of the same session, and a guard that speaks in
// one and not the other is a guard a screen reader never hears.
describe("buildTextFeed — the run's self-reports", () => {
  it("carries the guard's observation and the answer to it", () => {
    const texts = feedTexts([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts },
      {
        type: "no_progress",
        agentId: "main",
        detector: "identical_writes",
        count: 3,
        evidence: "the same 283 bytes, 3 times",
        callId: "progress-abc",
        ts,
      },
      {
        type: "progress_intervention",
        agentId: "main",
        callId: "progress-abc",
        detector: "identical_writes",
        intervention: "END",
        stoodDown: false,
        ts,
      },
      { type: "run_end", runId: "r1", stopReason: "no_progress", ts },
    ]);
    expect(texts).toContain("[no_progress identical_writes ×3] the same 283 bytes, 3 times");
    expect(texts).toContain("[progress_intervention identical_writes · END]");
    expect(texts).toContain("[run_end no_progress]");
  });

  it("carries the leash and the goal check too, not one guard out of three", () => {
    const texts = feedTexts([
      {
        type: "continuation",
        agentId: "main",
        decision: "continued",
        continuation: 1,
        budget: 3,
        openSteps: 2,
        totalSteps: 5,
        inputTokens: 0,
        evidence: "two steps still open",
        ts,
      },
      {
        type: "goal_check",
        agentId: "main",
        outcome: "unmet",
        command: "npm test",
        exitCode: 1,
        judge: "exit_code",
        output: "",
        durationMs: 12,
        evidence: "exit 1",
        ts,
      },
    ]);
    expect(texts).toContain("[continuation 1/3 · continued] two steps still open");
    expect(texts).toContain("[goal_check unmet · npm test] exit 1");
  });
});
