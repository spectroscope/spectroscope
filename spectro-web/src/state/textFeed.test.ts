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
      { type: "tool_result", agentId: "main", callId: "c1", output: "cli\nweb", isError: false, durationMs: 9, ts },
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
      "<think>", "first", "</think>", "answer", "<think>", "second", "</think>", " more",
    ]);
  });
});

describe("buildTextFeed — tools, gate, children", () => {
  it("carries the full tool result output and marks errors", () => {
    const events: RunEvent[] = [
      { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: { path: "x" }, ts },
      { type: "tool_result", agentId: "main", callId: "c1", output: "ERROR: not found", isError: true, durationMs: 2, ts },
    ];
    expect(feedTexts(events)).toEqual([
      '[tool_call read_file {"path":"x"}]',
      "[tool_result read_file ERROR · 2ms]",
      "ERROR: not found",
    ]);
  });

  it("shows the permission gate as protocol markers", () => {
    const events: RunEvent[] = [
      { type: "permission_request", agentId: "main", callId: "c1", name: "run_command", input: { command: "ls" }, ts },
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
