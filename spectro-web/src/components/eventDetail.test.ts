// The structured face of a trace/lab event: one frame described as the SHAPE
// it is (a tool call, an answer, a token count, a plan) instead of one JSON
// blob. Pure and DOM-free, like describeTool — the pixels live in the views.
//
// The load-bearing property is the last describe block: no field of a payload
// may vanish behind a prettier rendering.

import { describe, expect, it } from "vitest";
import { describeEvent, toolCallsById } from "./eventDetail";
import type { DetailSection } from "./eventDetail";

/** The payload keys a section accounts for — the drop check's ledger. */
function coveredKeys(sections: DetailSection[]): Set<string> {
  const keys = new Set<string>(["type", "ts"]);
  for (const s of sections) {
    switch (s.kind) {
      case "tool":
        keys.add("name");
        keys.add("input");
        // isError is NOT counted here on purpose: the tool shape only shows a
        // failure where it has a place for one, so the flag has to reach the
        // reader some other way.
        if (s.output !== undefined) keys.add("output");
        break;
      case "rows":
        for (const r of s.rows) keys.add(r.key);
        break;
      default:
        keys.add(s.field);
    }
  }
  return keys;
}

describe("describeEvent — tool frames", () => {
  it("renders a tool_call as its tool shape, still without a result", () => {
    const s = describeEvent("tool_call", {
      agentId: "main",
      callId: "c1",
      name: "read_file",
      input: { path: "a.ts" },
      ts: 1,
    });
    const tool = s.find((x) => x.kind === "tool");
    expect(tool).toBeDefined();
    if (tool?.kind !== "tool") throw new Error("kind");
    expect(tool.name).toBe("read_file");
    expect(tool.input).toEqual({ path: "a.ts" });
    expect(tool.output).toBeUndefined();
  });

  it("a permission_request is the same shape — the call the gate is asking about", () => {
    const s = describeEvent("permission_request", {
      agentId: "main",
      callId: "c1",
      name: "run_command",
      input: { command: "ls" },
      ts: 1,
    });
    expect(s[0].kind).toBe("tool");
  });

  it("pairs a tool_result with its call so the result renders as the tool card", () => {
    const calls = toolCallsById([
      { type: "tool_call", callId: "c1", name: "list_dir", input: { path: "." } },
    ]);
    const s = describeEvent(
      "tool_result",
      { agentId: "main", callId: "c1", output: "a.py\nb.py", isError: false, durationMs: 12, ts: 2 },
      calls,
    );
    const tool = s.find((x) => x.kind === "tool");
    if (tool?.kind !== "tool") throw new Error("kind");
    expect(tool.name).toBe("list_dir");
    expect(tool.input).toEqual({ path: "." });
    expect(tool.output).toBe("a.py\nb.py");
    // the frame's own numbers stay visible next to the shape
    const rows = s.find((x) => x.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("rows");
    expect(rows.rows.map((r) => r.key)).toContain("durationMs");
  });

  it("keeps a failed result readable as failed, beside its tool card", () => {
    const calls = toolCallsById([
      { type: "tool_call", callId: "c1", name: "read_file", input: { path: "gone.ts" } },
    ]);
    const s = describeEvent(
      "tool_result",
      { callId: "c1", output: "No such file", isError: true, durationMs: 1, ts: 2 },
      calls,
    );
    const rows = s.find((x) => x.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("rows");
    expect(rows.rows).toContainEqual({ key: "isError", value: "true" });
  });

  it("shows a tool_result verbatim when its call is not in the stream", () => {
    const s = describeEvent("tool_result", {
      callId: "gone",
      output: "boom",
      isError: true,
      durationMs: 3,
      ts: 2,
    });
    expect(s.some((x) => x.kind === "tool")).toBe(false);
    const prose = s.find((x) => x.kind === "prose");
    if (prose?.kind !== "prose") throw new Error("prose");
    expect(prose.text).toBe("boom");
    expect(prose.markdown).toBe(false);
    // the error flag is not swallowed by the fallback
    expect(coveredKeys(s).has("isError")).toBe(true);
  });
});

describe("toolCallsById", () => {
  it("indexes tool_call and permission_request frames by their callId", () => {
    const map = toolCallsById([
      { type: "tool_call", callId: "c1", name: "read_file", input: { path: "a" } },
      { type: "permission_request", callId: "c2", name: "run_command", input: { command: "ls" } },
      { type: "text_delta", text: "hi" },
    ]);
    expect(map.get("c1")?.name).toBe("read_file");
    expect(map.get("c2")?.name).toBe("run_command");
    expect(map.size).toBe(2);
  });

  it("keeps the first call for a callId — a later frame never rewrites history", () => {
    const map = toolCallsById([
      { type: "tool_call", callId: "c1", name: "read_file", input: { path: "a" } },
      { type: "tool_call", callId: "c1", name: "write_file", input: { path: "b" } },
    ]);
    expect(map.get("c1")?.name).toBe("read_file");
  });
});

describe("describeEvent — prose frames", () => {
  it("an answer delta is markdown", () => {
    const s = describeEvent("text_delta", { agentId: "main", text: "# Title\n\nbody", ts: 1 });
    const prose = s.find((x) => x.kind === "prose");
    if (prose?.kind !== "prose") throw new Error("prose");
    expect(prose.field).toBe("text");
    expect(prose.markdown).toBe(true);
  });

  it("an error message is plain — a crash is not markdown", () => {
    const s = describeEvent("error", { message: "connection reset", ts: 1 });
    const prose = s.find((x) => x.kind === "prose");
    if (prose?.kind !== "prose") throw new Error("prose");
    expect(prose.markdown).toBe(false);
  });

  it("a run_start leads with the prompt and keeps its identifiers", () => {
    const s = describeEvent("run_start", {
      runId: "r1",
      agentId: "main",
      prompt: "say hi",
      provider: "anthropic",
      model: "claude-opus-5",
      ts: 1,
    });
    expect(s[0].kind).toBe("prose");
    const covered = coveredKeys(s);
    for (const key of ["runId", "agentId", "prompt", "provider", "model"]) {
      expect(covered.has(key)).toBe(true);
    }
  });
});

describe("describeEvent — counted frames", () => {
  it("a usage frame is its numbers, and absent cache counts stay absent", () => {
    const s = describeEvent("usage", { agentId: "main", inputTokens: 79, outputTokens: 5, ts: 1 });
    const rows = s.find((x) => x.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("rows");
    expect(rows.rows).toEqual([
      { key: "agentId", value: "main" },
      { key: "inputTokens", value: "79" },
      { key: "outputTokens", value: "5" },
    ]);
  });

  it("a context_info lists its parts with their own counts", () => {
    const s = describeEvent("context_info", {
      agentId: "main",
      turn: 2,
      messages: 6,
      estimatedTokens: 1200,
      threshold: 100000,
      parts: [
        { label: "system prompt", chars: 400, estTokens: 100 },
        { label: "conversation", chars: 3200, estTokens: 800 },
      ],
      ts: 1,
    });
    const list = s.find((x) => x.kind === "list");
    if (list?.kind !== "list") throw new Error("list");
    expect(list.field).toBe("parts");
    expect(list.items[0].text).toBe("system prompt");
    expect(list.items[0].note).toContain("400");
    expect(list.more).toBe(0);
  });

  it("a plan is its steps, each with its status", () => {
    const s = describeEvent("plan", {
      agentId: "main",
      steps: [
        { text: "read the file", status: "done" },
        { text: "fix the bug", status: "in_progress" },
      ],
      ts: 1,
    });
    const list = s.find((x) => x.kind === "list");
    if (list?.kind !== "list") throw new Error("list");
    expect(list.items).toEqual([
      { text: "read the file", note: "done" },
      { text: "fix the bug", note: "in_progress" },
    ]);
  });

  it("a session_resume counts what rides back, per event type", () => {
    const s = describeEvent("session_resume", {
      sessionId: "s1",
      events: 3,
      estTokens: 900,
      history: [
        { type: "run_start", prompt: "hi" },
        { type: "text_delta", text: "a" },
        { type: "text_delta", text: "b" },
      ],
    });
    const list = s.find((x) => x.kind === "list");
    if (list?.kind !== "list") throw new Error("list");
    expect(list.field).toBe("history");
    expect(list.items).toEqual([
      { text: "run_start", note: "1×" },
      { text: "text_delta", note: "2×" },
    ]);
  });
});

describe("describeEvent — images", () => {
  it("a generated image is shown as the image, with the path still readable", () => {
    const s = describeEvent("image_generated", {
      agentId: "main",
      callId: "c1",
      prompt: "a cat on a beach",
      provider: "gemini",
      model: "gemini-3-image",
      mediaType: "image/png",
      blobPath: "/store/blobs/abc.png",
      sha256: "abc",
      ts: 1,
    });
    const img = s.find((x) => x.kind === "image");
    if (img?.kind !== "image") throw new Error("image");
    expect(img.src).toBe("/api/images/abc.png");
    expect(img.alt).toBe("a cat on a beach");
    expect(coveredKeys(s).has("blobPath")).toBe(true);
  });
});

describe("describeEvent — the honest fallback", () => {
  it("renders an unknown type field by field", () => {
    const s = describeEvent("provider_info", { provider: "ollama", host: "localhost:11434", ts: 1 });
    const rows = s.find((x) => x.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("rows");
    expect(rows.rows).toEqual([
      { key: "provider", value: "ollama" },
      { key: "host", value: "localhost:11434" },
    ]);
  });

  it("puts a long or multi-line string in its own block instead of a row", () => {
    const s = describeEvent("odd", { note: "a\nb", short: "x" });
    const prose = s.find((x) => x.kind === "prose");
    if (prose?.kind !== "prose") throw new Error("prose");
    expect(prose.field).toBe("note");
    expect(prose.markdown).toBe(false);
  });

  it("renders a string array as a list and a nested object as json", () => {
    const s = describeEvent("system_context", {
      systemPrompt: "You are spectro.",
      tools: ["read_file", "write_file"],
      skills: [],
      mcpServers: [],
      nested: { a: 1 },
    });
    const tools = s.find((x) => x.kind === "list" && x.field === "tools");
    if (tools?.kind !== "list") throw new Error("list");
    expect(tools.items.map((i) => i.text)).toEqual(["read_file", "write_file"]);
    expect(s.some((x) => x.kind === "json" && x.field === "nested")).toBe(true);
    // the system prompt is prose, and markdown: it is written as markdown
    const prompt = s.find((x) => x.kind === "prose" && x.field === "systemPrompt");
    if (prompt?.kind !== "prose") throw new Error("prose");
    expect(prompt.markdown).toBe(true);
  });

  it("shows a payload that is not an object at all as json", () => {
    const s = describeEvent("abort", "nope");
    expect(s).toEqual([{ kind: "json", field: "", value: "nope" }]);
  });

  it("has nothing to show for an empty payload — and says so by staying empty", () => {
    expect(describeEvent("abort", { type: "abort" })).toEqual([]);
  });
});

// The todo list an imported transcript carries (card 141). It is the most
// frequent thing the importer used to drop and the most interesting one: 26% of
// all attachments, 30,780 items measured, each with its own status. Rendered as
// a json blob it is a wall of braces in a column that ellipsizes; rendered as
// what it is, it is a list somebody can read.
describe("describeEvent, the todo list", () => {
  const items = [
    {
      id: "1",
      subject: "Read the census",
      description: "Count the fields on every item",
      activeForm: "Reading the census",
      status: "completed",
      blocks: [],
      blockedBy: [],
    },
    {
      id: "2",
      subject: "Decide the shape",
      description: "Pick what the row shows",
      activeForm: "Deciding the shape",
      status: "in_progress",
      blocks: [],
      blockedBy: ["1"],
    },
  ];

  it("renders a task_reminder as its list, not as one json blob", () => {
    const s = describeEvent("task_reminder", { type: "task_reminder", items, itemCount: 2, ts: 1 });
    const todo = s.find((x) => x.kind === "todo");
    expect(todo).toBeDefined();
    if (todo?.kind !== "todo") throw new Error("kind");
    expect(todo.field).toBe("items");
    expect(todo.items.map((i) => [i.subject, i.status])).toEqual([
      ["Read the census", "completed"],
      ["Decide the shape", "in_progress"],
    ]);
    // and the items are NOT also dumped as raw json underneath
    expect(s.some((x) => x.kind === "json" && x.field === "items")).toBe(false);
  });

  it("keeps itemCount, which is the file's own number and not a recount", () => {
    const s = describeEvent("task_reminder", { type: "task_reminder", items, itemCount: 2, ts: 1 });
    const rows = s.find((x) => x.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("kind");
    expect(rows.rows).toEqual([{ key: "itemCount", value: "2" }]);
  });

  it("hands back the raw items when the list cannot be rendered whole", () => {
    const broken = [items[0], { id: "2", status: "pending" }];
    const s = describeEvent("task_reminder", { type: "task_reminder", items: broken, ts: 1 });
    expect(s.some((x) => x.kind === "todo")).toBe(false);
    expect(s.some((x) => x.kind === "json" && x.field === "items")).toBe(true);
  });

  it("stops at the list ceiling and says how many stayed behind", () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      id: String(i + 1),
      subject: `item ${i + 1}`,
      description: `item ${i + 1}`,
      status: "pending",
      blocks: [],
      blockedBy: [],
    }));
    const s = describeEvent("task_reminder", { type: "task_reminder", items: many, ts: 1 });
    const todo = s.find((x) => x.kind === "todo");
    if (todo?.kind !== "todo") throw new Error("kind");
    expect(todo.items).toHaveLength(200);
    expect(todo.more).toBe(5);
  });
});

describe("describeEvent — nothing is dropped", () => {
  const samples: { type: string; payload: Record<string, unknown> }[] = [
    { type: "run_start", payload: { runId: "r", agentId: "main", prompt: "p", provider: "x", ts: 1 } },
    { type: "turn_start", payload: { agentId: "main", turn: 3, ts: 1 } },
    { type: "text_delta", payload: { agentId: "main", text: "hello", ts: 1 } },
    { type: "thinking_delta", payload: { agentId: "main", text: "hmm", ts: 1 } },
    { type: "tool_call", payload: { agentId: "a", callId: "c", name: "n", input: {}, ts: 1 } },
    {
      type: "tool_result",
      payload: { agentId: "a", callId: "c", output: "o", isError: false, durationMs: 1, ts: 1 },
    },
    { type: "permission_decision", payload: { callId: "c", allowed: true, ts: 1 } },
    { type: "agent_spawn", payload: { agentId: "w1", parentId: "main", task: "review", ts: 1 } },
    { type: "compaction", payload: { agentId: "main", removedTurns: 4, summaryChars: 900, ts: 1 } },
    { type: "usage", payload: { agentId: "main", inputTokens: 1, outputTokens: 2, ts: 1 } },
    { type: "run_end", payload: { runId: "r", stopReason: "end_turn", ts: 1 } },
    { type: "error", payload: { agentId: "main", message: "boom", ts: 1 } },
    {
      type: "agent_message",
      payload: { from: "a", to: "b", role: "worker", state: "result", text: "done", ts: 1 },
    },
    { type: "plan", payload: { agentId: "main", steps: [{ text: "t", status: "done" }], ts: 1 } },
    { type: "user_message", payload: { type: "user_message", text: "hi" } },
    {
      type: "task_reminder",
      payload: {
        type: "task_reminder",
        items: [
          {
            id: "1",
            subject: "s",
            description: "d",
            status: "pending",
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
        ts: 1,
      },
    },
    { type: "set_provider", payload: { type: "set_provider", provider: "ollama", model: "qwen3" } },
  ];

  for (const { type, payload } of samples) {
    it(`keeps every field of ${type}`, () => {
      const covered = coveredKeys(describeEvent(type, payload));
      for (const key of Object.keys(payload)) expect(covered.has(key)).toBe(true);
    });
  }
});
