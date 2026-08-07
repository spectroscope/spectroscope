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

import { frameLayer } from "./frameLayer";

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

/**
 * The arrow a row wears, which is a fact about ITS OWN WIRE and not a reading
 * of what it says (card 184, owner 2026-08-07: "llm hoch und runter können wir
 * hier noch ein Pfeil links und rechts machen wenn es NUR über websocket geht").
 *
 * Vertical means the row left this machine for a model. Horizontal means it
 * crossed the local socket and nothing else. That distinction is the answer to
 * his question — in a one-turn session exactly ONE row is vertical — and the
 * old column got it backwards, printing ↑ and ↓ on nine frames that never left
 * localhost while the single HTTPS call to the provider printed a dot.
 *
 * @param type the frame's type
 * @param dir  the socket direction the reducer recorded
 * @return ↑ / ↓ for the llm layer (↕ while an exchange is still one row),
 *         → / ← for everything that only ever rode the WebSocket
 */
export function dirGlyph(type: string, dir: "in" | "out"): string {
  if (frameLayer(type) === "llm") {
    if (type === "llm_request") return "↑";
    if (type === "llm_response") return "↓";
    return "↕"; // one row still carrying both halves; leg 2 splits it
  }
  return dir === "out" ? "→" : "←";
}
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
 *
 * @param type the frame type
 * @param provider the provider this row belongs to, when known
 * @param toolName the tool a tool row is about, when known
 * @param url the url the exchange RECORDED, when it has one — the fact that
 *            settles it, exactly as the host column already uses it
 */
export function wireProtocol(
  type: string,
  provider: string | null,
  toolName: string | null,
  url: string | null = null,
): string {
  const layer = frameLayer(type);
  // An app frame rode the WebSocket. It may be ABOUT the model's output; it is
  // not the model's output arriving, and printing the provider's streaming
  // protocol on it was the trace claiming a wire this row never touched.
  if (layer === "app") return "WebSocket";
  if (layer === "llm") {
    // Speech is the one model call that never opens a socket: whisper runs as a
    // child process and the record says `process://…`. Reading the recorded url
    // keeps this row describing its OWN wire rather than borrowing the shape of
    // every other llm row.
    if (url !== null && url.startsWith("process://")) return "process";
    return provider === "ollama" ? "HTTPS/NDJSON" : provider === null ? "HTTPS" : "HTTPS/SSE";
  }
  const llmStream = provider === "ollama" ? "NDJSON" : provider === null ? "—" : "SSE";
  switch (type) {
    case "tool_call":
    case "tool_result":
      if (toolName !== null && toolName.startsWith("mcp__")) return "JSON-RPC";
      if (
        toolName === "web_fetch" ||
        toolName === "generate_image" ||
        toolName === "web_search" ||
        toolName === "browse_page"
      )
        return "HTTP";
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
  origin: string | null,
): string {
  const layer = frameLayer(type);
  // The one app frame that ANNOUNCES a host instead of having one: it is how a
  // replay learns which backend the run rode, and its layer still says `app`.
  if (type === "provider_info") return llmHost ?? origin ?? "—";
  // Where this frame really came from: our own server. Null for a session this
  // browser did not produce — an import cannot know the host the other app ran
  // on, and a dash is the honest answer to a question with no record.
  if (layer === "app") return origin ?? "—";
  if (layer === "llm") {
    if (urlInput !== null) return hostOf(urlInput); // the recorded url wins: it IS the fact
    if (llmHost !== null) return llmHost;
    return provider === "anthropic" ? "api.anthropic.com" : "—";
  }
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
