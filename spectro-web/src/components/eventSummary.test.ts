import { describe, expect, it } from "vitest";
import { llmDirection, tokenizeSummary, wireHost, wireProtocol } from "./eventSummary";

const kinds = (raw: string): string => tokenizeSummary(raw).map((t) => t.kind).join(",");
const joined = (raw: string): string => tokenizeSummary(raw).map((t) => t.text).join("");

describe("tokenizeSummary", () => {
  it("re-joins to exactly the input (lossless)", () => {
    for (const s of ['"We"', '{"path":"src/a.ts"}', "ERROR boom · 42 ms", "turn 3", ""]) {
      expect(joined(s)).toBe(s);
    }
  });

  it("highlights quoted string content, dims the quotes", () => {
    const t = tokenizeSummary('"Hello!"');
    expect(t).toEqual([
      { kind: "punct", text: '"' },
      { kind: "str", text: "Hello!" },
      { kind: "punct", text: '"' },
    ]);
  });

  it("marks JSON braces, colons and commas as punctuation", () => {
    expect(kinds('{"path":"a.ts"}')).toBe("punct,punct,str,punct,punct,punct,str,punct,punct");
  });

  it("keeps escaped quotes inside a string", () => {
    const t = tokenizeSummary('"say \\"hi\\""');
    expect(t[1]).toEqual({ kind: "str", text: 'say \\"hi\\"' });
    expect(joined('"say \\"hi\\""')).toBe('"say \\"hi\\""');
  });

  it("marks number runs and leaves units plain", () => {
    expect(kinds("42 ms")).toBe("num,plain");
    expect(kinds("10 in / 2 out")).toBe("num,plain,num,plain");
  });

  it("flags the ERROR marker", () => {
    const t = tokenizeSummary("ERROR boom");
    expect(t[0]).toEqual({ kind: "err", text: "ERROR" });
  });

  it("an unterminated quote falls back to plain (no crash, lossless)", () => {
    expect(joined('"broken')).toBe('"broken');
  });
});

describe("llmDirection", () => {
  it("classifies requests handed to the model as 'to'", () => {
    for (const t of ["system_context", "user_message", "run_start", "turn_start", "tool_result"]) {
      expect(llmDirection(t)).toBe("to");
    }
  });

  it("classifies the model's own output as 'from'", () => {
    for (const t of ["thinking_delta", "text_delta", "tool_call", "usage", "run_end"]) {
      expect(llmDirection(t)).toBe("from");
    }
  });

  it("treats harness plumbing (and unknown types) as 'internal'", () => {
    for (const t of [
      "permission_request", "permission_decision", "permission_response",
      "agent_spawn", "agent_message", "context_info", "compaction",
      "image_generated", "set_provider", "abort", "error", "some_future_event",
    ]) {
      expect(llmDirection(t)).toBe("internal");
    }
  });
});

describe("wireProtocol", () => {
  it("names the LLM stream per provider (cloud SSE, Ollama NDJSON)", () => {
    expect(wireProtocol("text_delta", "anthropic", null)).toBe("SSE");
    expect(wireProtocol("thinking_delta", "openai", null)).toBe("SSE");
    expect(wireProtocol("usage", "ollama", null)).toBe("NDJSON");
    expect(wireProtocol("run_start", "ollama", null)).toBe("NDJSON");
    expect(wireProtocol("text_delta", null, null)).toBe("—");
  });

  it("shows a tool row's EXECUTION transport, not the LLM stream", () => {
    expect(wireProtocol("tool_call", "ollama", "mcp__notes__search_notes")).toBe("JSON-RPC");
    expect(wireProtocol("tool_result", "anthropic", "mcp__notes__add_note")).toBe("JSON-RPC");
    expect(wireProtocol("tool_call", "anthropic", "web_fetch")).toBe("HTTP");
    expect(wireProtocol("tool_call", "ollama", "generate_image")).toBe("HTTP");
    expect(wireProtocol("tool_call", "ollama", "web_search")).toBe("HTTP");
    expect(wireProtocol("tool_call", "anthropic", "browse_page")).toBe("HTTP");
    expect(wireProtocol("tool_result", "ollama", "read_file")).toBe("local");
    expect(wireProtocol("image_generated", "ollama", null)).toBe("HTTP");
  });

  it("keeps harness-internal frames off every wire", () => {
    for (const t of ["permission_request", "permission_decision", "plan", "context_info", "agent_message", "compaction"]) {
      expect(wireProtocol(t, "anthropic", null)).toBe("—");
    }
  });
});

describe("wireHost", () => {
  it("shows the live LLM host from provider_info for LLM rows", () => {
    expect(wireHost("text_delta", "ollama", "localhost:11434", null, null, null)).toBe("localhost:11434");
    expect(wireHost("run_start", "anthropic", "api.anthropic.com", null, null, null)).toBe("api.anthropic.com");
  });

  it("falls back honestly in replays: anthropic is fixed, local backends unknown", () => {
    // Archives carry no provider_info frames (socket-only), only run_start.provider.
    expect(wireHost("text_delta", "anthropic", null, null, null, null)).toBe("api.anthropic.com");
    expect(wireHost("text_delta", "ollama", null, null, null, null)).toBe("—");
    expect(wireHost("usage", "openai", null, null, null, null)).toBe("—");
  });

  it("names a tool row's own counterpart", () => {
    expect(wireHost("tool_call", "ollama", "localhost:11434", "mcp__notes__search_notes", null, null)).toBe("notes");
    expect(wireHost("tool_call", "ollama", null, "web_fetch", "https://example.com:8443/page", null)).toBe("example.com:8443");
    expect(wireHost("tool_result", "ollama", null, "web_fetch", "https://example.com/page", null)).toBe("example.com");
    expect(wireHost("tool_call", "ollama", null, "browse_page", "https://spa.example/app", null)).toBe("spa.example");
    // web_search: the client cannot know the tier (tavily vs duckduckgo) —
    // the result header names it; the host column stays honest with "—".
    expect(wireHost("tool_call", "ollama", null, "web_search", null, null)).toBe("—");
    expect(wireHost("tool_call", "ollama", null, "read_file", null, null)).toBe("—");
    expect(wireHost("image_generated", "ollama", null, null, null, "gemini")).toBe("generativelanguage.googleapis.com");
    expect(wireHost("image_generated", "ollama", null, null, null, "openai")).toBe("api.openai.com");
  });

  it("keeps internal frames hostless and lets provider_info announce itself", () => {
    expect(wireHost("permission_request", "anthropic", "api.anthropic.com", null, null, null)).toBe("—");
    expect(wireHost("provider_info", "ollama", "localhost:11434", null, null, null)).toBe("localhost:11434");
  });
});
