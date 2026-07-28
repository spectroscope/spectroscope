// The two foreign JSONL targets, held to the promise the dialog prints beside
// them. Each writer is tested by ROUND TRIP: write the stream, read it back
// through the importer that already exists for that format, and assert exactly
// the losses the dialog warned about — no more (the writer is broken) and no
// fewer (the warning is scaremongering).
//
// This is the test that keeps the warnings honest as both sides change.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { parseTranscript } from "../import/claudeCode";
import { parseVscodeAgentExport } from "../import/vscodeAgent";
import { toClaudeCodeJsonl } from "./claudeCode";
import { toVscodeAgentJsonl } from "./vscodeAgent";
import { formatLosses, streamFacts } from "./options";

const ts = 1_783_500_000_000;

function sampleEvents(): RunEvent[] {
  return [
    { type: "run_start", runId: "r", agentId: "main", prompt: "find the bug", model: "opus", ts },
    { type: "turn_start", agentId: "main", turn: 1, ts: ts + 1 },
    { type: "thinking_delta", agentId: "main", text: "let me look", ts: ts + 2 },
    { type: "text_delta", agentId: "main", text: "Checking the file.", ts: ts + 3 },
    {
      type: "tool_call",
      agentId: "main",
      callId: "c1",
      name: "read_file",
      input: { path: "a.ts" },
      ts: ts + 4,
    },
    {
      type: "tool_result",
      agentId: "main",
      callId: "c1",
      output: "line one\nline two",
      isError: false,
      durationMs: 12,
      ts: ts + 5,
    },
    { type: "usage", agentId: "main", inputTokens: 120, outputTokens: 45, ts: ts + 6 },
    { type: "run_end", runId: "r", stopReason: "end_turn", ts: ts + 7 },
  ] as RunEvent[];
}

/** Every text_delta joined, which is what a reader actually compares. */
const answerOf = (events: readonly RunEvent[]): string =>
  events
    .filter((e): e is Extract<RunEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

const thinkingOf = (events: readonly RunEvent[]): string =>
  events
    .filter((e): e is Extract<RunEvent, { type: "thinking_delta" }> => e.type === "thinking_delta")
    .map((e) => e.text)
    .join("");

const callsOf = (events: readonly RunEvent[]): string[] =>
  events
    .filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call")
    .map((e) => e.name);

describe("the Claude Code writer", () => {
  const text = toClaudeCodeJsonl(sampleEvents());

  it("writes one JSON record per line", () => {
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("round-trips the prose", () => {
    const back = parseTranscript(text);
    expect(answerOf(back)).toBe("Checking the file.");
    expect(thinkingOf(back)).toBe("let me look");
  });

  it("round-trips the tool call with its input and its output", () => {
    const back = parseTranscript(text);
    expect(callsOf(back)).toEqual(["read_file"]);
    const result = back.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    expect((result as { output: string }).output).toBe("line one\nline two");
  });

  it("round-trips the token counts", () => {
    const usage = parseTranscript(text).find((e) => e.type === "usage");
    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 45 });
  });

  it("keeps the session's own wall clock", () => {
    const back = parseTranscript(text);
    expect(back[0].ts).toBe(ts);
  });

  it("carries the subagent across", () => {
    const withSub = [
      ...sampleEvents().slice(0, 4),
      { type: "agent_spawn", agentId: "s1", parentId: "main", task: "review it", ts: ts + 4 },
      { type: "text_delta", agentId: "s1", text: "looks fine", ts: ts + 5 },
      { type: "run_end", runId: "r", stopReason: "end_turn", ts: ts + 6 },
    ] as RunEvent[];
    const back = parseTranscript(toClaudeCodeJsonl(withSub));
    expect(back.some((e) => e.type === "agent_spawn")).toBe(true);
    expect(answerOf(back)).toContain("looks fine");
  });

  it("loses exactly what the dialog warns it loses", () => {
    const source = [
      ...sampleEvents(),
      { type: "permission_decision", callId: "c1", allowed: true, ts: ts + 8 },
    ] as RunEvent[];
    const back = parseTranscript(toClaudeCodeJsonl(source));
    const warned = formatLosses("claude-code", streamFacts(source)).map((l) => l.code);

    expect(warned).toContain("permissions");
    expect(back.some((e) => e.type === "permission_decision")).toBe(false);
    // And what was NOT warned about really did survive.
    expect(warned).not.toContain("tool-output");
    expect(back.some((e) => e.type === "tool_result")).toBe(true);
  });
});

describe("the VS Code writer", () => {
  const text = toVscodeAgentJsonl(sampleEvents());

  it("writes one JSON record per line", () => {
    for (const line of text.trimEnd().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("round-trips the prose and the reasoning", () => {
    const back = parseVscodeAgentExport(text);
    expect(answerOf(back)).toBe("Checking the file.");
    expect(thinkingOf(back)).toBe("let me look");
  });

  it("round-trips the tool call and its input", () => {
    const back = parseVscodeAgentExport(text);
    expect(callsOf(back)).toEqual(["read_file"]);
  });

  it("loses the tool OUTPUT, exactly as warned", () => {
    // The format has nowhere to put it: tool.execution_complete carries only
    // { toolCallId, success }.
    const source = sampleEvents();
    const warned = formatLosses("vscode", streamFacts(source));
    expect(warned.find((l) => l.code === "tool-output")?.count).toBe(1);

    const back = parseVscodeAgentExport(toVscodeAgentJsonl(source));
    const result = back.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    expect((result as { output: string }).output).toBe("");
  });

  it("loses the subagent, exactly as warned", () => {
    const withSub = [
      ...sampleEvents().slice(0, 4),
      { type: "agent_spawn", agentId: "s1", parentId: "main", task: "review it", ts: ts + 4 },
      { type: "run_end", runId: "r", stopReason: "end_turn", ts: ts + 5 },
    ] as RunEvent[];
    expect(formatLosses("vscode", streamFacts(withSub)).map((l) => l.code)).toContain("subagents");
    expect(parseVscodeAgentExport(toVscodeAgentJsonl(withSub)).some((e) => e.type === "agent_spawn")).toBe(
      false,
    );
  });
});

describe("both writers", () => {
  it("write nothing for an empty stream", () => {
    expect(toClaudeCodeJsonl([])).toBe("");
    expect(toVscodeAgentJsonl([])).toBe("");
  });

  it("survive a session whose text carries JSON of its own", () => {
    const nasty = [
      { type: "run_start", runId: "r", agentId: "main", prompt: '{"not":"a record"}', ts },
      { type: "text_delta", agentId: "main", text: 'say "hi"\n{"x":1}', ts: ts + 1 },
      { type: "run_end", runId: "r", stopReason: "end_turn", ts: ts + 2 },
    ] as RunEvent[];
    expect(answerOf(parseTranscript(toClaudeCodeJsonl(nasty)))).toBe('say "hi"\n{"x":1}');
    expect(answerOf(parseVscodeAgentExport(toVscodeAgentJsonl(nasty)))).toBe('say "hi"\n{"x":1}');
  });
});
