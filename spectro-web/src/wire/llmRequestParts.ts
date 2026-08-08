// A recorded LLM request, read into its PARTS (card 184).
//
// The rejected structured face printed the whole request body as one wall of
// JSON, which is the one thing "structured" must never mean: a tool call gets a
// tool card, and a request to a model gets its system prompt, its conversation,
// its tools and its settings, each on its own.
//
// The hard part is that five different bodies really travel: the Anthropic
// SDK's json, the OpenAI-compatible chat json, Ollama's, the image request and
// the speech one. A renderer keyed to the first would print an empty pane for
// four of them, and an empty pane reads as "the request was empty" rather than
// "this reader does not know this shape". So this module reads what the chat
// shapes SHARE, names the shape it thinks it found, and sets {@link
// LlmRequestParts.empty} when it found nothing — the pane hands over to the
// JSON tree at that point, visibly, instead of pretending.
//
// Nothing here carries base64. An image block becomes a MEASURED block: its
// kind and the size of the encoded string it stood for. That is card 179's
// lesson applied before the defect rather than after it — a replayed history
// routinely holds megabytes of pictures, and this object is built on every
// expand of an LLM row.

/** One setting off the request, spelled the way the wire spells it. */
export interface LlmPart {
  key: string;
  value: string;
}

/** One block of one message. `chars` is set only for a measured blob. */
export interface LlmBlock {
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "image" | "document" | "other";
  /** The printable content, or "" for a block that is only a measurement. */
  text: string;
  /** The encoded size the block stood for, in characters; 0 when not a blob. */
  chars: number;
  /** The tool a `tool_use` names, or "". */
  name: string;
  /** The wire's own type word, kept for the blocks this reader files as `other`. */
  wire: string;
}

export interface LlmMessage {
  role: string;
  blocks: LlmBlock[];
}

export interface LlmTool {
  name: string;
  description: string;
  /** The JSON Schema as it stood on the wire, for the tool's own expansion. */
  schema: unknown;
}

export type LlmBodyShape = "anthropic" | "openai" | "ollama" | "image" | "unknown";

export interface LlmRequestParts {
  shape: LlmBodyShape;
  config: LlmPart[];
  /** The system prompt as one text, or "" when the body carries none. */
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** True when this reader found nothing it could render as parts. The pane
   *  falls back to the tree AND says why, rather than painting an empty frame. */
  empty: boolean;
}

/** The settings worth a strip, in the order a reader scans them. Presence
 *  decides, never truthiness: `think: false` and `stream: false` are facts
 *  about the request and a strip that hid them would be editorializing. */
const CONFIG_KEYS: readonly string[] = [
  "model",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stream",
  "thinking",
  "think",
  "reasoning_effort",
  "reasoning",
  "options",
  "stop_sequences",
  "size",
  "quality",
  "n",
  "response_format",
];

const EMPTY: LlmRequestParts = {
  shape: "unknown",
  config: [],
  system: "",
  messages: [],
  tools: [],
  empty: true,
};

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A setting's value as one line: a scalar as itself, an object or array
 *  compactly, because the strip is a strip and the tree is one face away. */
function settingValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** The base64 payload of a data URL, or "" for a URL that carries none — a
 *  remote image_url is a link, not a blob, and measuring it would be a lie. */
function dataUrlPayload(url: string): string {
  const at = url.indexOf(";base64,");
  return at === -1 ? "" : url.slice(at + ";base64,".length);
}

function block(kind: LlmBlock["kind"], parts: Partial<LlmBlock>): LlmBlock {
  return { kind, text: "", chars: 0, name: "", wire: kind, ...parts };
}

/** One content block of one message, in either provider's spelling. */
function readBlock(value: unknown): LlmBlock {
  if (typeof value === "string") return block("text", { text: value });
  const b = rec(value);
  if (b === null) return block("other", { wire: "" });
  const type = text(b["type"]);
  switch (type) {
    case "text":
      return block("text", { text: text(b["text"]), wire: type });
    case "thinking":
      return block("thinking", { text: text(b["thinking"]), wire: type });
    case "redacted_thinking":
      return block("thinking", { text: "", chars: text(b["data"]).length, wire: type });
    case "tool_use":
    case "function_call":
      return block("tool_use", {
        name: text(b["name"]),
        text: settingValue(b["input"] ?? b["arguments"]),
        wire: type,
      });
    case "tool_result":
    case "function_call_output": {
      const content = b["content"];
      return block("tool_result", {
        name: text(b["tool_use_id"] ?? b["call_id"]),
        text:
          typeof content === "string"
            ? content
            : blocksOf(content)
                .map((x) => x.text)
                .join("\n"),
        wire: type,
      });
    }
    case "image": {
      const source = rec(b["source"]);
      return block("image", {
        chars: text(source?.["data"]).length,
        name: text(source?.["media_type"]),
        wire: type,
      });
    }
    case "image_url": {
      const url = text(rec(b["image_url"])?.["url"]);
      const payload = dataUrlPayload(url);
      return block("image", {
        chars: payload.length,
        text: payload === "" ? url : "",
        wire: type,
      });
    }
    case "document": {
      const source = rec(b["source"]);
      return block("document", {
        chars: text(source?.["data"]).length,
        name: text(source?.["media_type"]),
        wire: type,
      });
    }
    default:
      return block("other", { text: settingValue(value), wire: type });
  }
}

function blocksOf(content: unknown): LlmBlock[] {
  if (typeof content === "string") return content === "" ? [] : [block("text", { text: content })];
  if (Array.isArray(content)) return content.map(readBlock);
  return content === undefined || content === null ? [] : [readBlock(content)];
}

/** Anthropic's system field is a string or a list of text blocks; both become
 *  one text, because the pane shows one system prompt. */
function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((b) => (typeof b === "string" ? b : text(rec(b)?.["text"])))
      .filter((s) => s !== "")
      .join("\n");
  }
  return "";
}

function readTools(value: unknown): LlmTool[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const t = rec(raw) ?? {};
    // The OpenAI envelope: {type:"function", function:{name, description, parameters}}.
    const fn = rec(t["function"]);
    const from = fn ?? t;
    return {
      name: text(from["name"]),
      description: text(from["description"]),
      schema: from["input_schema"] ?? from["parameters"] ?? from["inputSchema"] ?? null,
    };
  });
}

/**
 * Which body this is, decided on the keys only that provider sends. The order
 * matters: Ollama's two own keys before the generic chat shape, and the
 * top-level `system` before anything else, because it is Anthropic's alone.
 */
function shapeOf(body: Record<string, unknown>): LlmBodyShape {
  const hasMessages = Array.isArray(body["messages"]);
  if (!hasMessages && typeof body["prompt"] === "string") return "image";
  if ("think" in body || "options" in body) return hasMessages ? "ollama" : "unknown";
  if ("system" in body) return "anthropic";
  const tools = body["tools"];
  if (Array.isArray(tools) && tools.some((t) => rec(t) !== null && "input_schema" in (rec(t) as object))) {
    return "anthropic";
  }
  return hasMessages ? "openai" : "unknown";
}

/**
 * Read a recorded request body into its parts.
 *
 * @param body the verbatim body as the sidecar recorded it, or null when the
 *             recorder dropped it at its ceiling
 * @return the parts; `empty` is true when nothing could be read, and the caller
 *         must then say so rather than render an empty pane
 */
export function readRequestParts(body: string | null): LlmRequestParts {
  if (body === null || body.trim() === "") return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return EMPTY;
  }
  const obj = rec(parsed);
  if (obj === null) return EMPTY;

  const shape = shapeOf(obj);
  if (shape === "unknown") return { ...EMPTY, config: [] };

  const config: LlmPart[] = CONFIG_KEYS.filter((k) => k in obj).map((k) => ({
    key: k,
    value: settingValue(obj[k]),
  }));

  let system = systemText(obj["system"]);
  const raw = Array.isArray(obj["messages"]) ? (obj["messages"] as unknown[]) : [];
  const messages: LlmMessage[] = [];
  for (const entry of raw) {
    const m = rec(entry);
    if (m === null) continue;
    const role = text(m["role"]);
    // An OpenAI-compatible system message IS the system prompt, and printing it
    // again as turn one would make the conversation the reader counts disagree
    // with the conversation that was sent.
    if (role === "system" && messages.length === 0 && system === "") {
      system = blocksOf(m["content"])
        .map((b) => b.text)
        .join("\n");
      continue;
    }
    messages.push({ role, blocks: blocksOf(m["content"]) });
  }

  // An image request is not a conversation, but its prompt IS the text that
  // went to the model, and a pane showing only "model · size" would hide the
  // one thing worth reading.
  if (shape === "image") {
    messages.push({ role: "prompt", blocks: [block("text", { text: text(obj["prompt"]) })] });
  }

  const tools = readTools(obj["tools"]);
  const empty = system === "" && messages.length === 0 && tools.length === 0 && config.length === 0;
  return { shape, config, system, messages, tools, empty };
}
