import { describe, expect, it } from "vitest";
import { llmDirection, tokenizeSummary, wireHost, wireProtocol } from "./eventSummary";

const kinds = (raw: string): string =>
  tokenizeSummary(raw)
    .map((t) => t.kind)
    .join(",");
const joined = (raw: string): string =>
  tokenizeSummary(raw)
    .map((t) => t.text)
    .join("");

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
      "permission_request",
      "permission_decision",
      "permission_response",
      "agent_spawn",
      "agent_message",
      "context_info",
      "compaction",
      "image_generated",
      "set_provider",
      "abort",
      "error",
      "some_future_event",
    ]) {
      expect(llmDirection(t)).toBe("internal");
    }
  });
});

// REPLACED, not loosened (the graphite/espresso rule, add330f): these pins used
// to assert that a `text_delta` rides SSE from the provider. It does not. It
// rides the WebSocket from our own server, and the frame it announces was
// already parsed here. The owner caught it on a one-turn session where nine
// rows claimed api.anthropic.com over SSE and the single row that really was an
// HTTPS call there printed a dot and two dashes. The threshold stays — every
// row still names a protocol — the CLAIM underneath it was exchanged.
describe("wireProtocol", () => {
  it("names the WebSocket for a session frame, whatever that frame says about the model", () => {
    expect(wireProtocol("text_delta", "anthropic", null)).toBe("WebSocket");
    expect(wireProtocol("thinking_delta", "openai", null)).toBe("WebSocket");
    expect(wireProtocol("usage", "ollama", null)).toBe("WebSocket");
    expect(wireProtocol("run_start", "ollama", null)).toBe("WebSocket");
    // No provider on the row changes nothing: the wire it rode is the same one.
    expect(wireProtocol("text_delta", null, null)).toBe("WebSocket");
  });

  it("names the real transport of the one row that leaves this machine for a model", () => {
    expect(wireProtocol("llm_exchange", "anthropic", null)).toBe("HTTPS/SSE");
    expect(wireProtocol("llm_exchange", "openai", null)).toBe("HTTPS/SSE");
    expect(wireProtocol("llm_exchange", "ollama", null)).toBe("HTTPS/NDJSON");
    expect(wireProtocol("llm_exchange", null, null)).toBe("HTTPS");
  });

  // Speech is the one llm row that is not an HTTP call at all: whisper runs as a
  // child process, and the recorded url says so. Printing HTTPS/SSE on it was the
  // trace claiming a wire the row never touched — the same defect the app frames
  // were fixed for, surviving in the one place it could still hide.
  it("names a child process rather than claiming a network protocol", () => {
    expect(wireProtocol("llm_request", "whisper-cpp", null, "process://whisper-cli")).toBe("process");
    expect(wireProtocol("llm_response", "whisper-cpp", null, "process://whisper-cli")).toBe("process");
    expect(wireProtocol("llm_exchange", "whisper-cpp", null, "process://whisper-cli")).toBe("process");
  });

  it("still says SSE when the recorded url really is an https call", () => {
    expect(wireProtocol("llm_exchange", "anthropic", null, "https://api.anthropic.com/v1/messages")).toBe(
      "HTTPS/SSE",
    );
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

  // Also replaced. A gate question and a compaction notice are not "off every
  // wire": they crossed the WebSocket like everything else in the file. What is
  // true of them is that they never reached a model, and THAT reading lives in
  // the filter (llmDirection), where it is labelled as a reading.
  it("puts harness-internal frames on the wire they really used", () => {
    for (const t of [
      "permission_request",
      "permission_decision",
      "plan",
      "context_info",
      "agent_message",
      "compaction",
    ]) {
      expect(wireProtocol(t, "anthropic", null)).toBe("WebSocket");
      expect(llmDirection(t)).toBe("internal");
    }
  });
});

describe("wireHost", () => {
  // REPLACED for the same reason as wireProtocol above. A session frame's
  // counterpart is OUR server, not the provider, however much the frame is
  // about the provider's answer.
  it("names our own origin for a session frame", () => {
    expect(wireHost("text_delta", "ollama", "localhost:11434", null, null, null, "localhost:8874")).toBe(
      "localhost:8874",
    );
    expect(wireHost("run_start", "anthropic", "api.anthropic.com", null, null, null, "localhost:8874")).toBe(
      "localhost:8874",
    );
  });

  it("says it does not know for a session this browser did not produce", () => {
    // An import cannot know the host the other app ran on. A dash is the honest
    // answer to a question with no record; inventing one is the defect.
    expect(wireHost("text_delta", "anthropic", null, null, null, null, null)).toBe("—");
    expect(wireHost("usage", "openai", null, null, null, null, null)).toBe("—");
  });

  it("names the provider for the one row that really went there, url first", () => {
    expect(
      wireHost("llm_exchange", "anthropic", null, null, "https://api.anthropic.com/v1/messages", null, "x"),
    ).toBe("api.anthropic.com");
    // No recorded url: the announced host, then the provider's fixed endpoint.
    expect(wireHost("llm_exchange", "ollama", "localhost:11434", null, null, null, "x")).toBe(
      "localhost:11434",
    );
    expect(wireHost("llm_exchange", "anthropic", null, null, null, null, "x")).toBe("api.anthropic.com");
    expect(wireHost("llm_exchange", "lmstudio", null, null, null, null, "x")).toBe("—");
  });

  it("names a tool row's own counterpart", () => {
    expect(
      wireHost(
        "tool_call",
        "ollama",
        "localhost:11434",
        "mcp__notes__search_notes",
        null,
        null,
        "localhost:8874",
      ),
    ).toBe("notes");
    expect(
      wireHost(
        "tool_call",
        "ollama",
        null,
        "web_fetch",
        "https://example.com:8443/page",
        null,
        "localhost:8874",
      ),
    ).toBe("example.com:8443");
    expect(
      wireHost(
        "tool_result",
        "ollama",
        null,
        "web_fetch",
        "https://example.com/page",
        null,
        "localhost:8874",
      ),
    ).toBe("example.com");
    expect(
      wireHost("tool_call", "ollama", null, "browse_page", "https://spa.example/app", null, "localhost:8874"),
    ).toBe("spa.example");
    // web_search: the client cannot know the tier (tavily vs duckduckgo) —
    // the result header names it; the host column stays honest with "—".
    expect(wireHost("tool_call", "ollama", null, "web_search", null, null, "localhost:8874")).toBe("—");
    expect(wireHost("tool_call", "ollama", null, "read_file", null, null, "localhost:8874")).toBe("—");
    expect(wireHost("image_generated", "ollama", null, null, null, "gemini", "localhost:8874")).toBe(
      "generativelanguage.googleapis.com",
    );
    expect(wireHost("image_generated", "ollama", null, null, null, "openai", "localhost:8874")).toBe(
      "api.openai.com",
    );
  });

  // Replaced with the rest: a gate question is not "hostless", it came from our
  // own server over the socket like every other frame in the file. What it never
  // did is reach a model, and that reading lives in the filter.
  it("names our origin for an internal frame too, because that is where it came from", () => {
    expect(
      wireHost("permission_request", "anthropic", "api.anthropic.com", null, null, null, "localhost:8874"),
    ).toBe("localhost:8874");
    expect(llmDirection("permission_request")).toBe("internal");
  });

  // provider_info is the one app frame that ANNOUNCES a host rather than having
  // one: it is how a replay learns which backend the run rode. It keeps saying
  // so, and the row is still marked app by its layer.
  it("lets provider_info announce the backend it is announcing", () => {
    expect(wireHost("provider_info", "ollama", "localhost:11434", null, null, null, "localhost:8874")).toBe(
      "localhost:11434",
    );
  });
});
