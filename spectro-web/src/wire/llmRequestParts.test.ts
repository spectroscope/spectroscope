// What "structured" has to mean for a recorded LLM request (card 184, owner
// 2026-08-07: the old structured face was "ein unstrukturierter Haufen — der
// Witz in sich selber").
//
// The rule these pins encode: read the parts every chat shape SHARES, print
// those as parts, and say so out loud when a body is not a shape we know
// instead of rendering an empty pane. Five bodies really travel — the Anthropic
// SDK's json, the OpenAI-compatible chat json, Ollama's, the image request and
// the stt one — and a renderer keyed to the first would print nothing for four
// of them.

import { describe, expect, it } from "vitest";
import { readRequestParts } from "./llmRequestParts";

const ANTHROPIC = JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 8192,
  thinking: { type: "enabled", budget_tokens: 4096 },
  system: "You are spectro, a coding agent.",
  messages: [
    { role: "user", content: "count the files" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should list the dir" },
        { type: "tool_use", id: "c1", name: "list_dir", input: { path: "src" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "a.ts\nb.ts" }] },
  ],
  tools: [
    { name: "list_dir", description: "List a directory", input_schema: { type: "object" } },
    { name: "read_file", description: "Read a file", input_schema: { type: "object" } },
  ],
});

const OPENAI = JSON.stringify({
  model: "gpt-5",
  stream: true,
  reasoning_effort: "medium",
  messages: [
    { role: "system", content: "You are spectro." },
    { role: "user", content: "hi" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    },
  ],
});

const OLLAMA = JSON.stringify({
  model: "qwen3.5:27b",
  think: false,
  stream: true,
  options: { num_ctx: 8192 },
  messages: [{ role: "user", content: "hi" }],
});

const IMAGE = JSON.stringify({
  model: "gpt-image-2",
  prompt: "a cat on a beach, spectral lines behind it",
  size: "1024x1024",
});

describe("the shape a recorded request is in", () => {
  it("knows the Anthropic body by its own system field and input_schema", () => {
    expect(readRequestParts(ANTHROPIC).shape).toBe("anthropic");
  });

  it("knows an OpenAI-compatible body by its function tools", () => {
    expect(readRequestParts(OPENAI).shape).toBe("openai");
  });

  it("knows Ollama by the two keys only it sends", () => {
    expect(readRequestParts(OLLAMA).shape).toBe("ollama");
  });

  it("knows an image request: a prompt and no conversation", () => {
    expect(readRequestParts(IMAGE).shape).toBe("image");
  });

  // The honest fallback. A body we cannot read must SAY it cannot be read, so
  // the pane can hand over to the tree instead of painting an empty frame that
  // looks like "there was nothing in the request".
  it("says so for a body in no shape it knows", () => {
    const parts = readRequestParts(JSON.stringify({ audio: "…", language: "de" }));
    expect(parts.shape).toBe("unknown");
    expect(parts.empty).toBe(true);
  });

  it("says so for a body that is not even JSON, without throwing", () => {
    const parts = readRequestParts("not json at all");
    expect(parts.shape).toBe("unknown");
    expect(parts.empty).toBe(true);
  });

  it("says so for a body the recorder dropped at its ceiling", () => {
    expect(readRequestParts(null).empty).toBe(true);
  });
});

describe("the system prompt", () => {
  it("comes off the top level for Anthropic", () => {
    expect(readRequestParts(ANTHROPIC).system).toBe("You are spectro, a coding agent.");
  });

  it("comes out of the first message for an OpenAI-compatible body", () => {
    expect(readRequestParts(OPENAI).system).toBe("You are spectro.");
  });

  // …and then it is NOT also a conversation turn. Printing it twice would make
  // the message count disagree with the conversation the reader sees.
  it("is not counted again among the messages", () => {
    const parts = readRequestParts(OPENAI);
    expect(parts.messages).toHaveLength(1);
    expect(parts.messages[0].role).toBe("user");
  });

  it("joins Anthropic's block form into one text", () => {
    const body = JSON.stringify({
      model: "m",
      system: [
        { type: "text", text: "You are spectro." },
        { type: "text", text: "Today is Friday." },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(readRequestParts(body).system).toBe("You are spectro.\nToday is Friday.");
  });
});

describe("the messages", () => {
  it("keeps every turn, in wire order, with its role", () => {
    const parts = readRequestParts(ANTHROPIC);
    expect(parts.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("reads a plain string content as one text block", () => {
    const [first] = readRequestParts(ANTHROPIC).messages;
    expect(first.blocks).toHaveLength(1);
    expect(first.blocks[0].kind).toBe("text");
    expect(first.blocks[0].text).toBe("count the files");
  });

  it("keeps the wire's own word for each block kind", () => {
    const assistant = readRequestParts(ANTHROPIC).messages[1];
    expect(assistant.blocks.map((b) => b.kind)).toEqual(["thinking", "tool_use"]);
    expect(assistant.blocks[1].name).toBe("list_dir");
  });

  // The whole reason this module exists rather than a JSON.stringify: a
  // replayed history routinely carries base64 images, and printing one raw is
  // the defect the measured-gap segmentation was built to end (card 179).
  it("measures an image block instead of carrying its base64", () => {
    const data = "A".repeat(4000);
    const body = JSON.stringify({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        },
      ],
    });
    const [only] = readRequestParts(body).messages;
    expect(only.blocks[1].kind).toBe("image");
    expect(only.blocks[1].chars).toBe(4000);
    expect(JSON.stringify(only.blocks[1])).not.toContain("AAAA");
  });

  it("measures an OpenAI data-url image the same way", () => {
    const data = "B".repeat(2500);
    const body = JSON.stringify({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }],
        },
      ],
    });
    const [only] = readRequestParts(body).messages;
    expect(only.blocks[0].kind).toBe("image");
    expect(only.blocks[0].chars).toBe(2500);
    expect(JSON.stringify(only.blocks[0])).not.toContain("BBBB");
  });
});

describe("the tools", () => {
  it("lists Anthropic's tools by name with their schema kept", () => {
    const tools = readRequestParts(ANTHROPIC).tools;
    expect(tools.map((t) => t.name)).toEqual(["list_dir", "read_file"]);
    expect(tools[0].description).toBe("List a directory");
    expect(tools[0].schema).toEqual({ type: "object" });
  });

  it("unwraps the OpenAI function envelope", () => {
    const tools = readRequestParts(OPENAI).tools;
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(tools[0].schema).toEqual({ type: "object" });
  });

  it("has none for an image request, and does not invent an empty one", () => {
    expect(readRequestParts(IMAGE).tools).toEqual([]);
  });
});

describe("the config strip", () => {
  it("names the sampling and reasoning settings the body actually carries", () => {
    const config = readRequestParts(ANTHROPIC).config;
    const keys = config.map((c) => c.key);
    expect(keys).toContain("model");
    expect(keys).toContain("max_tokens");
    expect(keys).toContain("thinking");
    expect(config.find((c) => c.key === "model")?.value).toBe("claude-haiku-4-5-20251001");
  });

  it("carries a setting the wire spells differently, spelled the wire's way", () => {
    const keys = readRequestParts(OPENAI).config.map((c) => c.key);
    expect(keys).toContain("reasoning_effort");
    expect(keys).toContain("stream");
  });

  it("never invents a setting the body does not carry", () => {
    const keys = readRequestParts(OLLAMA).config.map((c) => c.key);
    expect(keys).not.toContain("max_tokens");
    expect(keys).toContain("think");
  });

  it("carries the image request's own settings", () => {
    const keys = readRequestParts(IMAGE).config.map((c) => c.key);
    expect(keys).toContain("model");
    expect(keys).toContain("size");
  });
});

describe("the image request's prompt", () => {
  // It is not a conversation, but it IS the text that went to the model, and a
  // pane that showed only "model · size" would hide the one thing that matters.
  it("rides as the single message, so the pane has something to show", () => {
    const parts = readRequestParts(IMAGE);
    expect(parts.empty).toBe(false);
    expect(parts.messages).toHaveLength(1);
    expect(parts.messages[0].blocks[0].text).toContain("a cat on a beach");
  });
});
