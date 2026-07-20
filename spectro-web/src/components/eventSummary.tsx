// Token-level highlighting for the one-line event summaries (Lab JSONL strip +
// Trace tab). The tokenizer is pure and LOSSLESS (tokens re-join to the input),
// so the existing summarize() strings stay the single source of truth and only
// gain color: quoted string content (the "text" field payloads) stands out in
// sand, JSON punctuation fades, numbers align, ERROR flags red.

export type SummaryKind = "str" | "punct" | "num" | "err" | "plain";
export interface SummaryToken {
  kind: SummaryKind;
  text: string;
}

const PUNCT = new Set(["{", "}", "[", "]", ":", ","]);

/** Split a summary line into color tokens. Lossless: tokens re-join to `raw`. */
export function tokenizeSummary(raw: string): SummaryToken[] {
  const out: SummaryToken[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") {
      out.push({ kind: "plain", text: plain });
      plain = "";
    }
  };

  let i = 0;
  while (i < raw.length) {
    const c = raw[i];

    if (c === '"') {
      // find the closing quote, honouring backslash escapes
      let j = i + 1;
      while (j < raw.length && !(raw[j] === '"' && raw[j - 1] !== "\\")) j += 1;
      if (j < raw.length) {
        flush();
        out.push({ kind: "punct", text: '"' });
        if (j > i + 1) out.push({ kind: "str", text: raw.slice(i + 1, j) });
        out.push({ kind: "punct", text: '"' });
        i = j + 1;
        continue;
      }
      // unterminated → treat the rest as plain
      plain += raw.slice(i);
      break;
    }

    if (PUNCT.has(c)) {
      flush();
      out.push({ kind: "punct", text: c });
      i += 1;
      continue;
    }

    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < raw.length && ((raw[j] >= "0" && raw[j] <= "9") || raw[j] === ".")) j += 1;
      flush();
      out.push({ kind: "num", text: raw.slice(i, j) });
      i = j;
      continue;
    }

    if (raw.startsWith("ERROR", i)) {
      flush();
      out.push({ kind: "err", text: "ERROR" });
      i += "ERROR".length;
      continue;
    }

    plain += c;
    i += 1;
  }
  flush();
  return out;
}

/** The rendered summary line — spans with token classes, reskin-safe. */
/**
 * @param field pass "text" when the summary's quoted content IS the event's
 *              `text` field (the model's own words: text_delta / thinking_delta /
 *              agent_message). Those render in a distinct color from structural
 *              string values like file paths or tool names.
 */
export function SummaryLine({ text, field }: { text: string; field?: "text" }) {
  return (
    <>
      {tokenizeSummary(text).map((t, i) => {
        if (t.kind === "plain") return t.text;
        const cls = t.kind === "str" && field === "text" ? "sum-text" : `sum-${t.kind}`;
        return (
          <span key={i} className={cls}>
            {t.text}
          </span>
        );
      })}
    </>
  );
}

/** Events whose summary is (or ends in) their own `text` field content. */
export const TEXT_FIELD_EVENTS: ReadonlySet<string> = new Set([
  "text_delta",
  "thinking_delta",
  "agent_message",
]);

/**
 * Which way a frame flows RELATIVE TO THE LLM, derived from its type (not the
 * socket direction). "to" = part of the request handed to the model (the prompt,
 * a new turn, a tool result fed back); "from" = the model's own output (its
 * thinking/answer stream, a tool call it decided on, the usage + stop it
 * returned); "internal" = harness plumbing that never touches the model
 * (permission gate, subagent A2A messages, context/compaction introspection, …).
 */
export type LlmDir = "to" | "from" | "internal";

export function llmDirection(type: string): LlmDir {
  switch (type) {
    case "system_context": // the synthetic "what's uploaded as the system role" frame (UI-only)
    case "user_message":
    case "run_start":
    case "turn_start":
    case "tool_result":
    case "session_resume": // the re-uploaded history goes TO the model next
      return "to";
    case "thinking_delta":
    case "text_delta":
    case "tool_call":
    case "usage":
    case "run_end":
      return "from";
    default:
      // permission_*, agent_spawn, agent_message, context_info, compaction,
      // image_generated, set_*, abort, error — and any future type.
      return "internal";
  }
}

/** ↑ goes to the model, ↓ comes back, · never reaches it. */
export const LLM_DIR_GLYPH: Record<LlmDir, string> = { to: "↑", from: "↓", internal: "·" };
export const LLM_DIR_LABEL: Record<LlmDir, string> = {
  to: "an die LLM (Anfrage)",
  from: "von der LLM (Antwort)",
  internal: "harness-intern (nicht an die LLM)",
};

/**
 * Which wire a frame's payload actually rides — the protocol-breakdown poster
 * as a column. The LLM stream is SSE for the cloud providers (Anthropic and
 * OpenAI-compatible both stream server-sent events) and NDJSON for Ollama;
 * tool rows show their EXECUTION transport instead: MCP tools speak JSON-RPC
 * (stdio), web_fetch/generate_image leave over plain HTTP, the standard tools
 * stay local. Everything harness-internal (gate, plan, introspection, A2A)
 * never leaves the process: "—".
 */
export function wireProtocol(
  type: string,
  provider: string | null,
  toolName: string | null,
): string {
  const llmStream = provider === "ollama" ? "NDJSON" : provider === null ? "—" : "SSE";
  switch (type) {
    case "tool_call":
    case "tool_result":
      if (toolName !== null && toolName.startsWith("mcp__")) return "JSON-RPC";
      if (toolName === "web_fetch" || toolName === "generate_image"
          || toolName === "web_search" || toolName === "browse_page") return "HTTP";
      return "local";
    case "image_generated":
      return "HTTP";
    default:
      return llmDirection(type) === "internal" ? "—" : llmStream;
  }
}

/** The image backends' fixed endpoints — the generate_image counterpart hosts. */
const IMAGE_BACKEND_HOST: Record<string, string> = {
  gemini: "generativelanguage.googleapis.com",
  openai: "api.openai.com",
};

/** The host[:port] of a URL, or "—" when it does not parse. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port !== "" ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "—";
  }
}

/**
 * The network counterpart per frame — the trace host column. LLM rows show
 * where the request really goes: live sessions learn it from the socket-only
 * provider_info frames; replays only know the provider (run_start), so
 * anthropic maps to its fixed endpoint and the local backends honestly show
 * "—" (their baseUrl never enters the wire). Tool rows name THEIR
 * counterpart instead: the MCP server for JSON-RPC, the fetched URL's host
 * for web_fetch, the image backend for generate_image; the local file tools
 * and everything harness-internal show "—".
 */
export function wireHost(
  type: string,
  provider: string | null,
  llmHost: string | null,
  toolName: string | null,
  urlInput: string | null,
  imageProvider: string | null,
): string {
  switch (type) {
    case "tool_call":
    case "tool_result":
      if (toolName !== null && toolName.startsWith("mcp__")) {
        return toolName.split("__")[1] ?? "—"; // the MCP server the JSON-RPC talks to
      }
      // browse_page carries a url input exactly like web_fetch; web_search
      // falls through to "—" — the client cannot know the search tier's host
      // (the result header names the tier instead).
      if (toolName === "web_fetch" || toolName === "browse_page") {
        return urlInput !== null ? hostOf(urlInput) : "—";
      }
      if (toolName === "generate_image") {
        return imageProvider !== null ? (IMAGE_BACKEND_HOST[imageProvider] ?? "—") : "—";
      }
      return "—";
    case "image_generated":
      return imageProvider !== null ? (IMAGE_BACKEND_HOST[imageProvider] ?? "—") : "—";
    case "provider_info":
      return llmHost ?? "—"; // the frame announces the host itself
    default:
      if (llmDirection(type) === "internal") return "—";
      if (llmHost !== null) return llmHost;
      return provider === "anthropic" ? "api.anthropic.com" : "—";
  }
}
