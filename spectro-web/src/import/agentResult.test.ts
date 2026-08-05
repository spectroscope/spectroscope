import { describe, expect, it } from "vitest";
import { readAgentResult } from "./agentResult";

describe("readAgentResult", () => {
  it("reads nothing out of a record that carries no toolUseResult", () => {
    expect(readAgentResult(undefined)).toBeNull();
    expect(readAgentResult(null)).toBeNull();
    expect(readAgentResult("Error: no such agent")).toBeNull();
    expect(readAgentResult([{ type: "text", text: "x" }])).toBeNull();
  });

  it("reads nothing out of an object that says none of it", () => {
    expect(readAgentResult({ stdout: "hi", file: { content: "x" } })).toBeNull();
  });

  it("carries the model the child actually ran on, verbatim", () => {
    expect(readAgentResult({ resolvedModel: "claude-haiku-4-5-20251001" })).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("keeps the context-window suffix the file wrote", () => {
    // 46 launches in ~/.claude/projects name "claude-opus-4-8[1m]". The suffix
    // is part of the id the file recorded; trimming it would name a model the
    // child did not run on.
    expect(readAgentResult({ resolvedModel: "claude-opus-4-8[1m]" })?.model).toBe("claude-opus-4-8[1m]");
  });

  it("marks a launch that never reported back inside the file", () => {
    const r = readAgentResult({ status: "async_launched", isAsync: true, resolvedModel: "claude-opus-4-8" });
    expect(r?.launched).toBe(true);
    expect(r?.model).toBe("claude-opus-4-8");
  });

  it("does not mark a launch that did report back", () => {
    expect(readAgentResult({ status: "completed" })?.launched).toBeUndefined();
  });

  it("reads the child's own token bill off the parent's record", () => {
    expect(
      readAgentResult({
        status: "completed",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 3536,
          cache_read_input_tokens: 54290,
          output_tokens: 2779,
          service_tier: "standard",
        },
      })?.usage,
    ).toEqual({ inputTokens: 2, outputTokens: 2779, cacheReadTokens: 54290, cacheCreationTokens: 3536 });
  });

  it("leaves out a cache counter the record never wrote", () => {
    const u = readAgentResult({ usage: { input_tokens: 5, output_tokens: 7 } })?.usage;
    expect(u).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(u && "cacheReadTokens" in u).toBe(false);
  });

  it("refuses a usage object with no token counts rather than reporting zeroes", () => {
    expect(readAgentResult({ usage: { service_tier: "standard" } })).toBeNull();
  });
});
