// The trace tab — the wire view. Every frame that crossed the socket is one
// row: RunEvents inbound, ClientMessages outbound. What Wireshark is to
// packets, this is to the harness protocol. The rows come straight from the
// reducer state, so live and replay render through the same path (a replayed
// archive is all dir "in" by construction).

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { traceRowOffset, traceWindow } from "./traceWindow";
import { traceDisclosure } from "./traceDisclosure";
import { loadTraceContext, type TraceContext } from "./traceContext";
import type { CSSProperties, ReactNode } from "react";
import type { RunEvent } from "../events";
import type { TraceEntry, UserAttachment } from "../state/reducer";
import { agentAccent, compactJson, formatTokens, prettyJson } from "../format";
import { CopyButton } from "./CopyButton";
import { JsonTree } from "./JsonTree";
import { Markdown } from "./Markdown";
import { highlight } from "./Highlighted";
import { ToolViewBody } from "./ToolViewBody";
import { describeEvent, toolCallsById, toolResultDetailsById } from "./eventDetail";
import { openImage } from "../state/imageViewer";
import { SessionFolderButtons } from "./SessionFolderButtons";
import type { DetailSection, ToolCallRef } from "./eventDetail";
import type { ToolResultDetail } from "../import/toolResultDetail";
import {
  dirGlyph,
  SummaryLine,
  TEXT_FIELD_EVENTS,
  llmDirection,
  wireHost,
  wireProtocol,
} from "./eventSummary";
import type { LlmDir } from "./eventSummary";
import {
  READINGS,
  SOURCE_DISPLAY_CHARS,
  copyLabel,
  detailLines,
  detailText,
  sourcePane,
  sourceSentence,
  withinBudget,
  type Reading,
  type SourcePane,
  type TraceProvenance,
} from "./traceDetail";
import { readable, type ReadableBlock } from "./readable";
import { readTodoItems, statusLabel, todoSummary } from "./todoList";
import { causalChain, reasoningPairs, reasoningBlockText, reasoningReach } from "./traceChain";
import { timelineFractions } from "./traceTimeline";
import { sourceNoteIndex, type SourceNote } from "../import/sourceNotes";
import { readRecordMeta, type MetaGroup } from "../import/recordMeta";
import { noteAnchors } from "../state/traceSource";
import { beacon } from "../state/levelingBeacon";
import { ExplainPanel } from "./ExplainPanel";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { applyAndSaveDesign, useDesignPrefs } from "../state/designPrefs";
import {
  effectiveTraceColumns,
  setTraceColumn,
  traceColumnData,
  useTraceColumns,
} from "../state/traceColumns";
import {
  incomingGeneration,
  reportView,
  subscribeReportedViews,
  takeIncomingView,
} from "../state/viewReport";
import { onlyClause } from "../state/viewState";
import type { TraceColumns } from "../state/traceColumns";
import {
  TRACE_FACES,
  availableFace,
  facesFor,
  rowFace,
  setTraceFace,
  useTraceFace,
} from "../state/traceFace";
import { frameLayer } from "./frameLayer";
import { useVoiceExchanges } from "../state/voiceWire";
import {
  activeCategories,
  setTraceCategories,
  setTraceLlmDir,
  toggleTraceCategory,
  useTraceFilter,
} from "../state/traceFilter";
import type { RowFace } from "../state/traceFace";
import { reportCount, useSearch } from "../state/search";
import { traceHits, traceRowText } from "./traceSearch";
import type { TraceHitRow } from "./traceSearch";
import {
  llmExchangeSummary,
  llmRequestSummary,
  llmResponseSummary,
  readExchange,
  readRequestFrame,
  traceWithVoice,
} from "../wire/llmWire";
import { LlmExchangeDetail } from "./LlmExchangeDetail";

/** agent_message summaries clip their text to this width (CLI parity). */
const AGENT_MESSAGE_PREVIEW_CHARS = 60;
/** This close to the bottom counts as "pinned" (auto-follow stays on). */
/** Rows built beyond each edge of the viewport (card 117). Enough that a flick
 *  of the wheel never reaches an unbuilt row before the next scroll event
 *  lands, small enough that the build stays a fixed cost. */
const TRACE_OVERSCAN_ROWS = 12;

/** The window used before anything has been measured — see the note at the
 *  call site. A tall viewport and a short row deliberately over-build rather
 *  than risk a visible gap on the first frame. */
const TRACE_FALLBACK_VIEWPORT_PX = 1200;
const TRACE_FALLBACK_ROW_PX = 20;

const SCROLL_PIN_THRESHOLD_PX = 80;

/** The chip row's groups, in the order they are shown. Exported because the
 *  words are in the dict now and a category without one would ship as a bare
 *  key, and because the filter below is tested against the whole list. */
export const CATEGORIES = [
  "run",
  "turn",
  "text",
  "thinking",
  "tool",
  "workflow",
  "mcp",
  "permission",
  "usage",
  "image",
  "llm",
  "context",
  "client",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Whether a name off an address is one of ours. An address may say anything. */
function isCategory(name: string): name is Category {
  return (CATEGORIES as readonly string[]).includes(name);
}

/** Which chip a frame answers to. */
export function categoryOf(type: string): Category {
  switch (type) {
    case "run_start":
    case "run_end":
    case "abort":
    case "session_resume":
      return "run";
    case "turn_start":
      return "turn";
    case "text_delta":
    case "user_message":
      return "text";
    case "thinking_delta":
      return "thinking";
    case "tool_call":
    case "tool_result":
      return "tool";
    // hook_decision joins the gate's own frames (card 195), and not by analogy:
    // a pre_tool_use block REPLACES the gate — the call short-circuits before
    // any permission_request is emitted, so the refusal exists and the gate's
    // two frames do not. A reader who presses `permission` to see what was
    // refused would otherwise be shown every refusal except the ones nothing was
    // even asked about.
    case "permission_request":
    case "permission_decision":
    case "permission_response":
    case "hook_decision":
      return "permission";
    case "usage":
      return "usage";
    // attachment_image belongs here: a picture an imported transcript carried
    // is a picture. Without it the row answered to `other`, so the one gesture
    // a reader makes to find the pictures — pressing `image` — hid all of them,
    // and pressing `other` off to clear the plumbing rows took every picture
    // with it. Nothing looked broken until the filter was used, and then the
    // pane confidently showed zero pictures for a file with 140.
    case "image_generated":
    case "set_image_provider":
    case "attachment_image":
      return "image";
    case "context_info":
    case "system_context":
      return "context";
    // The recorded LLM exchange (wire/llmWire.ts). Its own chip, not `other`:
    // a type this switch does not know gets no chip (card 179), and pressing
    // `other` off to clear the plumbing rows must not take the one row that
    // says what actually left for the model.
    case "llm_exchange":
    case "llm_request":
    case "llm_response":
      return "llm";
    // What an imported transcript recorded around the conversation: the todo
    // list, the prompt queue, the file somebody edited (card 141). Their own
    // group rather than `other`, so a reader can bring them in or put them
    // away in one click instead of hunting them among agent_spawn and error.
    // ground_info joins them (card 167): where the run stood, announced once
    // and again at every move. The busiest file in the corpus carries 273 of
    // those rows, so the one-click chip is what keeps them out of the way.
    case "task_reminder":
    case "queue_operation":
    case "queued_command":
    case "edited_text_file":
    case "ground_info":
      return "client";
    default:
      // agent_spawn, compaction, error — and every future type.
      return "other";
  }
}

/** The wire prefix every tool served over MCP carries in its name. The chip is
 *  spelled for what a reader recognises; THIS is the rule underneath it. */
const MCP_NAME_PREFIX = "mcp__";
/**
 * The tools that launch a background task, by their wire names.
 *
 * Two, not one. The importer has always known both — `Workflow` announces
 * "launched in background. Task ID: x" and `Monitor` announces "started (task
 * x, …)", and `receiptTaskId` matches either — so a chip that knew only the
 * first would hide 17 of the 196 launch receipts in the owner's own corpus, and
 * their joined outcomes with them. Pressing `workflow` to study background work
 * and getting most of it is worse than getting none, because nothing says which
 * part is missing.
 */
const BACKGROUND_TASK_TOOLS = new Set(["Workflow", "Monitor"]);

/**
 * Which of the three tool chips a tool NAME answers to.
 *
 * Measured over the owner's 37 recorded Claude Code transcripts (16774 tool
 * calls): 2609 mcp__*, of which browser javascript_tool 916 and browser
 * computer 897, and 172 Workflow. Every one of them read as bare `tool` before
 * this, which is the whole of what the owner asked to end.
 *
 * @param name the tool's wire name, or null when the frame recorded none
 */
export function toolCategory(name: string | null): Category {
  if (name !== null && BACKGROUND_TASK_TOOLS.has(name)) return "workflow";
  if (name !== null && name.startsWith(MCP_NAME_PREFIX)) return "mcp";
  return "tool";
}

/** A payload's string field, or null — the chip rule reads two of them and has
 *  no business trusting anything else it finds in there. */
function payloadStr(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Which chip a ROW answers to — the wire type, and for a tool row the tool.
 *
 * The type alone cannot answer this: a tool_call keeps its name in the payload,
 * and a tool_result keeps no name at all, only the callId pointing back at the
 * call it answers. So a result INHERITS its call's category through the index.
 * Without that, a reader who presses `workflow` sees the launch and loses the
 * answer, which is the one thing a workflow row is read for.
 *
 * @param row    the frame's wire type and its payload
 * @param calls  callId → call, built once per stream ({@link toolCallsById})
 */
export function categoryOfRow(
  row: { type: string; payload?: unknown },
  calls?: ReadonlyMap<string, ToolCallRef>,
): Category {
  // Only the tool group splits. A permission_request names a tool too and is
  // indexed by callId alongside the calls, but the gate is its own group and
  // the tool chips do not reach into it.
  if (categoryOf(row.type) !== "tool") return categoryOf(row.type);
  if (row.type === "tool_call") return toolCategory(payloadStr(row.payload, "name"));
  const callId = payloadStr(row.payload, "callId");
  const call = callId === null ? undefined : calls?.get(callId);
  // A result whose call is not in the stream falls back to plain `tool`: it has
  // nothing to inherit, and a row that answered nobody must never drop out of
  // the trace. A truncated import and an index that was never built are the two
  // ways that happens at rest. On a LIVE stream `windowTrace` (reducer.ts, 5000
  // rows) can evict a call while its result is still on screen — but only for
  // as many frames as separated them, 3 at p90, right at the window's oldest
  // edge, on a row the window is about to delete anyway.
  return call === undefined ? "tool" : toolCategory(call.name);
}

/** The three chips the tool group splits into. A `tool_call` carries the name
 *  that decides between them; a `tool_result` inherits it through the index. */
const TOOL_CHIPS: readonly Category[] = ["tool", "workflow", "mcp"];

/**
 * Whether the callId index can change what the chip row shows.
 *
 * Building it is one walk of the whole stream, and on a LIVE session the stream
 * grows under it — an eager index pays that walk again on every frame batch,
 * for a trace nobody has filtered. It only earns that while the three tool
 * chips DISAGREE: with all three pressed (the state a trace opens in) or all
 * three released, a `tool_result` lands on the same side of the filter whether
 * it inherited its call's chip or fell back to plain `tool`.
 *
 * @param active the categories whose chips are pressed
 */
export function needsCallIndex(active: ReadonlySet<string>): boolean {
  const on = TOOL_CHIPS.filter((c) => active.has(c)).length;
  return on !== 0 && on !== TOOL_CHIPS.length;
}

/**
 * Whether a frame survives the chip row.
 *
 * A function rather than an expression inside the view's filter: it is the one
 * rule that decides what a reader can see, and it was untestable while it sat
 * in a closure over component state.
 *
 * Takes the ROW rather than the wire type, because since the tool group split
 * into tool/workflow/mcp the type no longer carries the answer. A caller with
 * nothing but a type still gets the old behaviour by passing `{ type }`.
 *
 * @param row    the frame's wire type and its payload
 * @param active the categories whose chips are pressed
 * @param calls  callId → call, so a result inherits its call's chip
 */
export function inCategories(
  row: { type: string; payload?: unknown },
  active: ReadonlySet<string>,
  calls?: ReadonlyMap<string, ToolCallRef>,
): boolean {
  return active.has(categoryOfRow(row, calls));
}

/** Event-type color (fixed brand vocabulary, tokens.css --ev-*). The bar in
 *  front of the type column is a mark — color lives only on marks. */
function categoryColor(c: Category): string {
  switch (c) {
    case "text":
      return "var(--ev-token)";
    case "thinking":
      return "var(--ev-reasoning)";
    // workflow and mcp are tool rows read by a finer question; they get the
    // tool mark and no colour of their own. A chip is a filter, not a fifth
    // brand colour, and the palette is what it was before this split.
    case "tool":
    case "workflow":
    case "mcp":
    case "image":
      return "var(--ev-tool)";
    case "permission":
      return "var(--ev-gate)";
    case "other":
      return "var(--ev-subagent)";
    default:
      return "var(--ev-lifecycle)";
  }
}

/** The table's class for a given column choice. Each modifier drops exactly one
 *  track from the grid that header and rows share (panels.css), which is why
 *  the switch has to live in ONE place: cells and header always go together. */
export function traceTableClass(cols: TraceColumns): string {
  return `trace-table${cols.host ? "" : " trace-table--no-host"}${cols.model ? "" : " trace-table--no-model"}`;
}

/**
 * What the trace toolbar shows about this session's OTLP export (card 137).
 *
 * Three states, and one of them is silence. Before anything has been exported
 * there is no chip at all: a greyed placeholder would turn the toolbar into a
 * place where people learn what Langfuse is, and the Settings Observability
 * block already carries that copy. "failed" is deliberately endpoint neutral,
 * because a failing Jaeger export deserves the same sentence. A landed export
 * outranks a later failure, because the trace it wrote still exists.
 */
export function traceLinkState(
  langfuseUrl: string | null,
  otlpFailure: string | null,
): "link" | "failed" | "none" {
  if (langfuseUrl) return "link";
  return otlpFailure !== null ? "failed" : "none";
}

/** Reasoning lens (card 13): the row's role while the lens is active.
 *
 *  `wearsReasoning` is what a turn_start needs: on an imported transcript the
 *  turn and the thought are ONE line of the file, so that row now carries the
 *  block — and a row carrying the whole thought must not be dimmed as though it
 *  said nothing. The type alone can no longer answer this.
 *
 *  Exported for the tests: the `wearsReasoning` branch decides whether a row
 *  holding the whole thought is foregrounded or greyed out, and a branch that
 *  quietly stopped being taken would look exactly like a row that never thought. */
export function lensRole(type: string, wearsReasoning: boolean): "hi" | "anchor" | "dim" {
  if (wearsReasoning || type === "thinking_delta") return "hi";
  if (type === "tool_call" || type.startsWith("permission_") || type === "error") return "anchor";
  return "dim";
}

/** The opening clause of a thought, for the chip that points back at it: one
 *  line, whitespace collapsed, cut on a word. Long enough to answer "why this
 *  call", short enough that it stays a pointer and never becomes the text. */
export function reasoningLead(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Wall-clock with millisecond precision — the wire view's native unit. */
function clock(ts: number): string {
  const d = new Date(ts);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
}

/** One dense line per frame — type-specific where a summary beats raw JSON.
 *  Exported for the tests: a summary that quietly stopped being called would
 *  look exactly like one that was never wired up. */
export function summarize(entry: TraceEntry, lang: Lang): string {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.type) {
    case "system_context": {
      const sp = String(p["systemPrompt"] ?? "");
      const tools = Array.isArray(p["tools"]) ? (p["tools"] as unknown[]).length : 0;
      const skills = Array.isArray(p["skills"]) ? (p["skills"] as unknown[]).length : 0;
      return t(lang, "trace.sysSummary", { n: sp.length, t: tools, s: skills });
    }
    case "session_resume":
      return t(lang, "trace.resumeSummary", {
        e: Number(p["events"] ?? 0),
        t: Number(p["estTokens"] ?? 0),
      });
    case "text_delta":
      return String(p["text"] ?? "");
    case "tool_call":
      return `${String(p["name"] ?? "")} ${compactJson(p["input"])}`;
    case "tool_result":
      return `${p["isError"] === true ? "ERROR" : "ok"} · ${String(p["durationMs"] ?? 0)} ms`;
    case "usage": {
      // inputTokens is the RAW uncached remainder — with prompt caching the
      // additive cache counts complete the picture, so name them here.
      const cache = Number(p["cacheReadTokens"] ?? 0) + Number(p["cacheCreationTokens"] ?? 0);
      const base = `${String(p["inputTokens"] ?? 0)} in / ${String(p["outputTokens"] ?? 0)} out`;
      return cache > 0 ? `${base} · cache ${cache}` : base;
    }
    case "context_info":
      return `est ${formatTokens(Number(p["estimatedTokens"] ?? 0))} / ${formatTokens(
        Number(p["threshold"] ?? 0),
      )}`;
    case "agent_message":
      return `${String(p["from"] ?? "")} → ${String(p["to"] ?? "")} · ${String(p["state"] ?? "")} · ${JSON.stringify(
        String(p["text"] ?? "").slice(0, AGENT_MESSAGE_PREVIEW_CHARS),
      )}`;
    case "ground_info": {
      // Where the run stood, and what it left to get there (card 167). The
      // field names are the FILE's own words and stay untranslated, the same
      // rule recordMeta.ts labels its groups by: a wire path is its own label
      // and cannot drift from the file. A frame naming none of the three is
      // not one this can read, so it falls through to the raw json below.
      const from = p["from"] as Record<string, unknown> | undefined;
      const moved = ["cwd", "gitBranch", "version"]
        .filter((f) => typeof p[f] === "string")
        .map((f) => {
          const left = from === undefined ? undefined : from[f];
          return typeof left === "string" ? `${f} ${left} → ${String(p[f])}` : `${f} ${String(p[f])}`;
        });
      return moved.length === 0 ? compactJson(entry.payload) : moved.join(" · ");
    }
    case "task_reminder": {
      // The todo list an imported transcript carried (card 141). compactJson
      // of a ten-item list is a wall of braces that ellipsizes after the first
      // one, so the collapsed row shows the counts and the open row shows the
      // list. A list this cannot read falls back to the raw frame.
      const items = readTodoItems(p["items"]);
      return items === null ? compactJson(entry.payload) : todoSummary(items, lang);
    }
    // The picture an imported transcript carried. The frame holds the BYTES,
    // and a collapsed row must not print them: compactJson of this payload is
    // up to 600 KB of base64 — measured 19.87 MB across one 140-picture file —
    // in the DOM and, worse, in the row's own search text, where it made Cmd+F
    // match base64 noise ("deny" hit 15 of 140 picture rows, none of them
    // because the frame said so). This is the same reason eventDetail holds
    // `dataBase64` back from the OPEN row. The file's own note is what the row
    // says instead; the picture itself is in the detail below.
    case "attachment_image": {
      const note = String(p["note"] ?? "");
      return note !== "" ? note : `[${String(p["mediaType"] ?? "image")}]`;
    }
    // The recorded exchange: path, provider, sizes, status, duration — and
    // structurally nothing else, because the frame carries metadata only and
    // the line is built from the read record alone (wire/llmWire.ts). The
    // bodies are fetched by the open row and never enter the search text.
    case "llm_exchange": {
      const x = readExchange(entry.payload);
      return x === null ? compactJson(entry.payload) : llmExchangeSummary(x);
    }
    // The call leaving. No status, no duration, no response size: at this
    // moment those facts do not exist, and printing a zero would be a claim.
    case "llm_request": {
      const r = readRequestFrame(entry.payload);
      return r === null ? compactJson(entry.payload) : llmRequestSummary(r);
    }
    // The call closing, derived from the summary frame at the same instant.
    case "llm_response": {
      const x = readExchange(entry.payload);
      return x === null ? compactJson(entry.payload) : llmResponseSummary(x);
    }
    // A configured guard did something (card 195). This frame had no case here
    // and fell to compactJson, which leads with agentId/callId/toolName and
    // ellipsizes before the verdict — so the one row a reader opens this tab to
    // find read as a wall of braces. The CLI got its ⛨ line the day the event
    // was added (EventRenderer); this is the same line, in the surface this
    // product is named after. The verdict and the phase stay in their wire
    // spelling, the rule every other summary here follows: `pre_tool_use` is
    // the field's own word and cannot drift from the file.
    case "hook_decision": {
      const verdict = String(p["verdict"] ?? "");
      const head = `⛨ ${String(p["event"] ?? "")} ${verdict} · ${String(p["command"] ?? "")}`;
      // Fail-open is the case that matters most and shows least: the call ran
      // with part of the fence down. "timed-out" alone leaves a reader guessing
      // whether anything happened after it.
      if (verdict === "timed-out") {
        return `${head} · ${t(lang, "trace.hookRanAnyway", { sec: Number(p["timeoutSeconds"] ?? 0) })}`;
      }
      const reason = String(p["reason"] ?? "");
      return reason === "" ? head : `${head} · ${reason}`;
    }
    default:
      return compactJson(entry.payload);
  }
}

/**
 * The text the chip-row filter searches a row by: type, agent, and the frame
 * itself — except for llm_exchange, which is searched by its SUMMARY. The
 * frame contract carries no body, but that must be client structure, not
 * server discipline: a widened frame's extra field would otherwise ride
 * compactJson straight into the filter text. Exported for the tests.
 */
export function searchText(e: TraceEntry): string {
  let body: string;
  if (e.type === "llm_exchange" || e.type === "llm_response") {
    const x = readExchange(e.payload);
    body = x === null ? compactJson(e.payload) : llmExchangeSummary(x);
  } else if (e.type === "llm_request") {
    const r = readRequestFrame(e.payload);
    body = r === null ? compactJson(e.payload) : llmRequestSummary(r);
  } else {
    body = compactJson(e.payload);
  }
  return `${e.type} ${e.agentId ?? ""} ${body}`;
}

/** Rows are memoized: during a delta flood only the appended rows render. */
const TraceRow = memo(function TraceRow(props: {
  entry: TraceEntry;
  /** ms since the previous VISIBLE row; null for the first one. */
  dt: number | null;
  /** The wire this frame's payload rode (SSE/NDJSON/JSON-RPC/HTTP/local/—). */
  proto: string;
  /** The network counterpart (api.anthropic.com, localhost:11434, …, or —). */
  host: string;
  /** Whether the optional host / model columns are on (toolbar choice). A
   *  hidden column is left out of the row entirely — the cells that stay say
   *  exactly what they said before. */
  showHost: boolean;
  showModel: boolean;
  /** Search: "" when this row is no hit, else its role — "hit-cur" is the one
   *  the reader is standing on right now. */
  hit: "" | "hit" | "hit-cur";
  open: boolean;
  lang: Lang;
  /** Reasoning lens: "" while the lens is off, else the row's role class. */
  lens: "" | "hi" | "anchor" | "dim";
  /** Timeline lens: this row's wait as a fraction of the largest visible gap
   *  (drives the proportional bar), or null while the lens is off / no bar. */
  tl: number | null;
  /** Lens pairing: the action that followed this thinking block, if any. */
  pair?: { seq: number; label: string };
  /** Lens: the row that opens the block's line carries the WHOLE block's
   *  reasoning text (every thinking_delta of the block joined), untruncated. */
  blockText?: string;
  /** Lens, the other direction: the block that was in charge when this action
   *  ran. Absent on every row that ran with nothing in charge. */
  from?: { seq: number; lead: string };
  /** What the imported line behind this frame says beyond the frame itself
   *  (card: the source line). Undefined on every row of a session produced
   *  here, on a frame the importer built, and on the sibling rows of a line
   *  whose notes another row already wears. */
  notes?: readonly SourceNote[];
  /** The open row's causal chain (undefined while closed — keeps memo calm). */
  chain?: TraceEntry[];
  /** The open row's call index, same reason: a fresh Map on every append would
   *  re-render every closed row during a delta flood. */
  calls?: ReadonlyMap<string, ToolCallRef>;
  /** The open row's detail index, same rule again: what the tools RETURNED,
   *  when an importer read it beside the flattened block (card 167). */
  details?: ReadonlyMap<string, ToolResultDetail>;
  /** The source face's two inputs, and the same rule a third time: only the open
   *  row is handed the stream it stands in and the file it was read from. */
  source?: { rows: readonly TraceEntry[]; lines: readonly string[] | null };
  /** Where this trace's frames came from when no file is loaded. A session-wide
   *  fact and one stable string, so every row carries it: it decides a sentence
   *  the pane must not get wrong, and an optional prop would decide it by
   *  falling back. */
  provenance: TraceProvenance;
  /** Whether the rows are carrying translated payloads. Session-wide like
   *  `provenance`, and required for the same reason: it decides whether the
   *  pane may promise the wire line beside it is the stored line. */
  translated: boolean;
  /** Where an llm_exchange row may fetch its recorded bodies from: the session
   *  the sidecar sits beside, or null when there is none to ask — an import, a
   *  scenario, a fleet. Session-wide like `provenance`, and one stable string,
   *  so it rides every row without waking the memo. */
  llmWireSessionId: string | null;
  /**
   * Where the OPEN row reports its height from, and nothing else uses it
   * (card 211).
   *
   * The height that matters is the whole block a row occupies — the button
   * plus its detail, which is a sibling and not a child of it. Measuring
   * `[data-seq=…]` measured the button alone: 25 px under a 1,143 px detail,
   * on the owner's own session. The window then placed every row below the
   * open one against a total that was 1,143 px short, and the browser clamped
   * the reader back to where that shorter total ended.
   *
   * It is a ref callback rather than an effect on purpose: React calls it on
   * every mount and unmount of this node, so a row that is remounted — by a
   * filter, by a scroll, by anything — measures itself again without the view
   * having to notice.
   */
  blockRef?: (el: HTMLDivElement | null) => void;
  onJump?: (seq: number) => void;
  onToggle: (seq: number) => void;
}) {
  const { entry, dt, proto, host, showHost, showModel, hit, open, lang, lens, tl, pair, blockText, from } =
    props;
  // The DIR flag now reads as the LLM direction (derived from the type); the
  // socket direction moves into the tooltip.
  const ld = llmDirection(entry.type);
  // The arrow is a fact about THIS row's wire: vertical only when the row
  // really left this machine for a model (card 184). The LLM reading below is
  // still in the tooltip, labelled as the reading it is.
  const glyph = dirGlyph(entry.type, entry.dir);
  const socket = entry.dir === "out" ? "client→server" : "server→client";
  const dirLabel: Record<LlmDir, string> = {
    to: t(lang, "trace.dirTo"),
    from: t(lang, "trace.dirFrom"),
    internal: t(lang, "trace.dirInternal"),
  };
  const dirTitle =
    entry.type === "system_context"
      ? t(lang, "trace.sysRowTitle")
      : entry.type === "session_resume"
        ? t(lang, "trace.resumeRowTitle")
        : `${dirLabel[ld]} · Socket: ${socket}`;
  return (
    // One element around everything this row occupies — the button, the lens
    // strips, the detail. It exists so the open row's height can be MEASURED
    // rather than guessed from the button (card 211). `data-seq` deliberately
    // stays on the button: the stepper, the search walk and the jump all
    // querySelector it and then call focus() on what they find, and a div is
    // not focusable.
    <div className="trace-rowblock" data-block-seq={entry.seq} ref={props.blockRef}>
      <button
        type="button"
        className={`trace-row${entry.type === "system_context" || entry.type === "session_resume" ? " trace-row--sys" : ""}${lens === "" ? "" : ` trace-row--${lens}`}${tl !== null && tl > 0 ? " trace-row--tl" : ""}${hit === "" ? "" : ` trace-row--${hit}`}`}
        style={tl !== null && tl > 0 ? ({ "--tl": tl } as CSSProperties) : undefined}
        aria-expanded={open}
        aria-current={hit === "hit-cur" ? true : undefined}
        data-seq={entry.seq}
        onClick={() => props.onToggle(entry.seq)}
      >
        <span className="trace-col trace-col--num tabular">{entry.seq}</span>
        <span className="trace-col tabular">{clock(entry.ts)}</span>
        <span className="trace-col trace-col--dt tabular">{dt === null ? "" : `+${dt}`}</span>
        <span className={`trace-col trace-col--llm trace-col--llm-${ld}`} title={dirTitle}>
          {glyph}
        </span>
        <span className="trace-col trace-col--proto" title={t(lang, "trace.protoTitle")}>
          {proto}
        </span>
        {showHost && (
          <span className="trace-col trace-col--host" title={t(lang, "trace.hostTitle")}>
            {host}
          </span>
        )}
        {/* Card 87: the model serving this row's run — blank outside runs. */}
        {showModel && (
          <span className="trace-col trace-col--model" title={entry.model ?? ""}>
            {entry.model ?? ""}
          </span>
        )}
        <span className="trace-col trace-col--agent">
          {entry.agentId !== undefined && (
            <span
              className="agent-badge"
              style={{ "--agent-color": agentAccent(entry.agentId) } as CSSProperties}
            >
              {entry.agentId}
            </span>
          )}
        </span>
        <span className="trace-col">
          <span className="trace-type">
            <span
              className="trace-type-mark"
              style={{ background: categoryColor(categoryOf(entry.type)) }}
              aria-hidden="true"
            />
            {entry.type}
          </span>
        </span>
        <span className="trace-col trace-col--summary">
          {/* Read off the imported line, never off the frame: these fields are
              in somebody else's file and on no wire of ours. Nothing renders
              unless the line carried it. */}
          {props.notes?.map((note) => (
            <span
              key={note.kind}
              className="trace-note"
              /* The value rides in the tooltip too. A narrow window ellipsizes
                 the chip, and a half-read model name would be its own small
                 lie about what the file says. */
              title={`${t(lang, `trace.note.${note.kind}`)} ${note.value}\n${t(lang, `trace.note.${note.kind}Title`)}`}
            >
              {t(lang, `trace.note.${note.kind}`)} {note.value}
            </span>
          ))}
          {/* The text is the part that ellipsizes. A chip that clipped would be
              worse than no chip: the reader would see half a fact and no sign
              that the other half exists. */}
          <span className="trace-summary-text">
            <SummaryLine
              text={summarize(entry, lang)}
              field={TEXT_FIELD_EVENTS.has(entry.type) ? "text" : undefined}
            />
          </span>
        </span>
      </button>
      {blockText !== undefined && blockText !== "" && (
        <div className="trace-reason" aria-label={t(lang, "trace.reasonBlock")}>
          <span className="trace-reason-kicker mono">{t(lang, "trace.reasonBlock")}</span>
          <p className="trace-reason-text">{blockText}</p>
        </div>
      )}
      {/* The lens, read backwards: standing on a call, the thought that was in
          charge of it, one click away. It names the thought's opening clause
          and nothing of the call's own input or result — those are the tool
          card's subject, and repeating them here would make the lens a second
          transcript. */}
      {from !== undefined && (
        <button
          type="button"
          className="trace-pair trace-pair--from"
          title={t(lang, "trace.pairFromTitle")}
          onClick={() => props.onJump?.(from.seq)}
        >
          <span aria-hidden="true">&#8624;</span> {t(lang, "trace.pairFrom")}{" "}
          <span className="mono">{from.lead}</span>
        </button>
      )}
      {pair !== undefined && (
        <button
          type="button"
          className="trace-pair"
          title={t(lang, "trace.pairJump")}
          onClick={() => props.onJump?.(pair.seq)}
        >
          <span aria-hidden="true">&#8627;</span> {t(lang, "trace.pairThen")}{" "}
          <span className="mono">{pair.label}</span>
        </button>
      )}
      {open && (
        <TraceDetail
          entry={entry}
          lang={lang}
          chain={props.chain ?? [entry]}
          calls={props.calls}
          details={props.details}
          rows={props.source?.rows ?? [entry]}
          sourceLines={props.source?.lines ?? null}
          provenance={props.provenance}
          translated={props.translated}
          llmWireSessionId={props.llmWireSessionId}
          onJump={(seq) => props.onJump?.(seq)}
        />
      )}
    </div>
  );
});

/** One chip of the causal-chain strip: the frame's type plus its most telling
 *  detail (tool name, turn number, or a prompt snippet). */
function chainLabel(e: TraceEntry): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "run_start":
      return `prompt "${String(p["prompt"] ?? "").slice(0, 24)}"`;
    case "turn_start":
      return `turn ${String(p["turn"] ?? "?")}`;
    case "tool_call":
      return `tool_call ${String(p["name"] ?? "")}`;
    // The packet, named by the endpoint it went to — which is what a reader
    // standing anywhere in the chain recognises (`/v1/messages`), not the xid.
    case "llm_exchange": {
      const url = String(p["url"] ?? "");
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {
        /* not a URL: print what was recorded */
      }
      return `LLM ${path}`;
    }
    case "permission_request":
      return "gate asked";
    case "permission_decision":
      return p["allowed"] === true ? "gate allowed" : "gate denied";
    // Named by the verdict, because that is the whole content of the row: a
    // chain chip reading "hook_decision" would say a hook was consulted and
    // leave out the only thing a reader is standing here for.
    case "hook_decision":
      return `hook ${String(p["verdict"] ?? "")}`;
    case "agent_spawn":
      return `spawn ${e.agentId ?? ""}`;
    default:
      return e.type;
  }
}

/** One region label: the payload field the region renders, under its wire name
 *  — the trace is the wire view, so the field IS the honest heading. Printed
 *  verbatim, never upper-cased: `systemPrompt` is the field, `SYSTEMPROMPT` is
 *  not a field of anything. */
function SectionLabel({ field }: { field: string }) {
  return field === "" ? null : <span className="ed-label mono">{field}</span>;
}

/**
 * The bytes behind a section's `src`, when it HAS bytes.
 *
 * An imported picture rides as a `data:` URI and can be handed to the gallery
 * whole. A generated one is a `/api/images/<file>` URL — the store holds those
 * bytes, this page does not — so it stays a picture in the row and is not
 * clickable. A click that opened an empty lightbox would be worse than no click.
 *
 * @param src the section's src attribute
 * @return the attachment, or null when the bytes are not here
 */
function bytesOf(src: string, name: string): UserAttachment | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(src);
  return m === null ? null : { name, mediaType: m[1], dataBase64: m[2] };
}

/** A picture in a row, shown as the picture. When the blob is gone it drops out
 *  and the path stays — a placeholder here would be a claim. */
function ImageSection({ section }: { section: Extract<DetailSection, { kind: "image" }> }) {
  const [broken, setBroken] = useState(false);
  const shot = bytesOf(section.src, section.alt || section.field);
  return (
    <div className="ed-sec">
      <SectionLabel field={section.field} />
      {!broken && (
        <img
          className={shot === null ? "ed-img" : "ed-img is-openable"}
          src={section.src}
          alt={section.alt}
          onError={() => setBroken(true)}
          {...(shot === null ? {} : { onClick: () => openImage(shot) })}
        />
      )}
      <div className="ed-path mono">{section.path}</div>
    </div>
  );
}

/** One section of the structured face; the shapes come from eventDetail.ts. */
function DetailSectionView({ section, lang }: { section: DetailSection; lang: Lang }) {
  switch (section.kind) {
    case "tool":
      // The very body the chat's tool card renders — one structured tool view
      // in the app, reached from two places.
      return (
        <ToolViewBody
          mode="structured"
          name={section.name}
          input={section.input}
          output={section.output}
          isError={section.isError}
          denied={false}
          detail={section.detail}
        />
      );

    case "prose":
      return (
        <div className="ed-sec">
          <SectionLabel field={section.field} />
          {section.markdown ? (
            <div className="ed-md">
              <Markdown text={section.text} />
            </div>
          ) : (
            <pre className="tv-well mono">{section.text}</pre>
          )}
        </div>
      );

    case "rows":
      return (
        <div className="ed-sec">
          <SectionLabel field={section.field} />
          <dl className="ed-rows">
            {section.rows.map((row) => (
              <div key={row.key}>
                <dt className="mono">{row.key}</dt>
                <dd className="mono">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      );

    case "list":
      return (
        <div className="ed-sec">
          <SectionLabel field={section.field} />
          <ul className="tv-entries mono">
            {section.items.map((item, i) => (
              <li key={i} className="tv-entry">
                {item.text}
                {item.note !== undefined && <span className="ed-note">{item.note}</span>}
              </li>
            ))}
          </ul>
          {section.more > 0 && <p className="ed-more">{t(lang, "ed.more", { n: section.more })}</p>}
        </div>
      );

    case "todo":
      // The agent's own todo list, as a list (card 141). Status carries the
      // dot and the badge from the agents/plan vocabulary, so it reskins with
      // every design and adds no colour value: --ok for done, --accent for
      // running, the base faint dot for open and for any status a later client
      // invents. Every line under an item is there only because the item
      // carried it.
      return (
        <div className="ed-sec">
          <SectionLabel field={section.field} />
          <ol className="ed-todo">
            {/* The file's id is the item's own ordinal and repeats across
                lists, so the row's key is its position, which cannot. */}
            {section.items.map((item, i) => (
              <li key={i} className="ed-todo-item">
                <span className="ed-todo-head">
                  <span className={`agent-dot agent-dot--${item.status}`} aria-hidden="true" />
                  <span className="ed-todo-id mono">{item.id}</span>
                  <span className="ed-todo-subject">{item.subject}</span>
                  <span className={`agent-badge agent-badge--${item.status}`}>
                    {statusLabel(item.status, lang)}
                  </span>
                </span>
                {item.description !== undefined && <p className="ed-todo-desc">{item.description}</p>}
                {item.activeForm !== undefined && <p className="ed-todo-now">{item.activeForm}</p>}
                {(item.blockedBy !== undefined || item.blocks !== undefined || item.owner !== undefined) && (
                  <p className="ed-todo-meta mono">
                    {/* Wire field names, the way every other label in this view
                        prints them: the trace is the wire view, and `blockedBy`
                        is the field, not a word we chose. */}
                    {item.blockedBy !== undefined && <span>blockedBy {item.blockedBy.join(", ")}</span>}
                    {item.blocks !== undefined && <span>blocks {item.blocks.join(", ")}</span>}
                    {item.owner !== undefined && <span>owner {item.owner}</span>}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {section.more > 0 && <p className="ed-more">{t(lang, "ed.more", { n: section.more })}</p>}
        </div>
      );

    case "image":
      return <ImageSection section={section} />;

    case "json":
      return (
        <div className="ed-sec">
          <SectionLabel field={section.field} />
          <pre className="tv-well mono">{highlight(prettyJson(section.value), "json")}</pre>
        </div>
      );
  }
}

/** The structured face of one frame (owner: "wie in einem chrome network view
 *  wo man die html rendern kann"): the event rendered as what it IS — a call as
 *  its tool card, an answer as its markdown, counts as their numbers, a
 *  generated image as the image. The raw frame stays one click away, and every
 *  field the payload carries is somewhere on screen (eventDetail.ts). */
export function EventStructured(props: {
  type: string;
  payload: unknown;
  /** The stream's calls by callId, so a tool_result can render as its call.
   *  Absent means the pairing is simply not offered — nothing is invented. */
  calls?: ReadonlyMap<string, ToolCallRef>;
  /** What those calls RETURNED, when an importer read it beside the flattened
   *  block (card 167). The trace's structured face opens the very body the chat
   *  card draws, so it is handed the very same evidence — otherwise one call
   *  would read two ways inside one app. */
  details?: ReadonlyMap<string, ToolResultDetail>;
  /** The record this frame was imported from, already read (recordMeta.ts).
   *  Absent for every session produced here, which is why the Lab passes
   *  nothing and renders exactly what it always did. */
  meta?: readonly MetaGroup[];
}) {
  const lang = useLang();
  const sections = useMemo(
    () => describeEvent(props.type, props.payload, props.calls, props.details),
    [props.type, props.payload, props.calls, props.details],
  );
  const meta = props.meta ?? [];
  if (sections.length === 0 && meta.length === 0) return <p className="ed-empty">{t(lang, "ed.nothing")}</p>;
  return (
    <div className="ed">
      {sections.map((section, i) => (
        <DetailSectionView key={`${section.kind}.${section.field}.${i}`} section={section} lang={lang} />
      ))}
      {/* What the imported line says about the turn, under the frames it
          produced. Kept visibly apart from them: the sections above are this
          app's own reading of its own wire, and everything below is a field of
          somebody else's file, printed the way the file spells it. */}
      {meta.length > 0 && (
        <div className="ed-meta">
          <p className="ed-meta-note">{t(lang, "ed.fromFile")}</p>
          {meta.map((group) => (
            <div key={group.path} className="ed-sec">
              <SectionLabel field={group.path} />
              <dl className="ed-rows">
                {group.rows.map((row) => (
                  <div key={row.key} className={row.block === undefined ? undefined : "ed-row--block"}>
                    <dt className="mono">{row.key}</dt>
                    {/* A run of the file's own bytes is painted the way the
                        source pane paints one, down to the sentence: the
                        thought is read where it stands, a signature is opened
                        on request. Same component, so the two faces of one line
                        cannot drift into two vocabularies. The path is already
                        the <dt>, so the block carries none. */}
                    {row.block === undefined ? (
                      <dd className="mono">{row.value}</dd>
                    ) : (
                      <dd>
                        <ReadableBlockView
                          block={{ kind: row.block, path: "", depth: 0, text: row.value }}
                          lang={lang}
                          capNote="trace.meta.capped"
                        />
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A count as a reader counts it, in their own grouping. Line 4127 of 6431 is
 *  a number somebody scrolls a file to; 4127 unspaced is a token. */
const counted = (n: number, lang: Lang): string => n.toLocaleString(lang === "de" ? "de-DE" : "en-US");

/**
 * Text in a pane that stops at a ceiling and SAYS it stopped.
 *
 * Single lines in the owner's corpus reach 769295 characters and a 4.7 MB image
 * block is an ordinary record, so a pane without a ceiling is a pane that
 * freezes. Truncation that names itself is a display limit; truncation that
 * stays quiet is this card's own defect. The clipboard never sees the ceiling.
 *
 * @param capNote which sentence names the two numbers. One ceiling and one
 *                pair of numbers everywhere; only the escape differs, because
 *                the source pane's copy button hands over the whole line and
 *                the structured face's hands over the payload. A pane that
 *                promised a copy it does not make would be this card's defect
 *                wearing the fix's clothes.
 */
function Budgeted({
  text,
  lang,
  wrap,
  capNote = "trace.source.capped",
}: {
  text: string;
  lang: Lang;
  wrap?: boolean;
  capNote?: string;
}) {
  const [all, setAll] = useState(false);
  const cut = withinBudget(text, all ? text.length : SOURCE_DISPLAY_CHARS);
  return (
    <>
      <pre className={wrap === true ? "trace-detail-raw trace-detail-raw--wrap" : "trace-detail-raw"}>
        {cut.text}
      </pre>
      {cut.capped && (
        <p className="trace-source-cap">
          {t(lang, capNote, {
            shown: counted(cut.shown, lang),
            total: counted(cut.total, lang),
          })}{" "}
          <button type="button" className="trace-source-more" onClick={() => setAll(true)}>
            {t(lang, "trace.source.showAll")}
          </button>
        </p>
      )}
    </>
  );
}

/** One piece of an opened line. A document prints as a document; a string with
 *  real line breaks prints with them; a collapsed value prints as what it is,
 *  how many characters, and a way in.
 *
 *  Two collapsed kinds and two sentences, because the reasons are not the same
 *  claim: `hidden` is a signature or a base64 body, `long` is one run of
 *  characters too long to read where it stands, and most of those are prose.
 *  They shared the byte sentence until a dictated prompt met it. */
function ReadableBlockView({
  block,
  lang,
  capNote,
}: {
  block: ReadableBlock;
  lang: Lang;
  /** Passed through to {@link Budgeted}: see there for why one ceiling has two
   *  sentences. */
  capNote?: string;
}) {
  const [open, setOpen] = useState(false);
  const collapsed = block.kind === "hidden" || block.kind === "long";
  return (
    <div className="trace-source-block">
      {block.path !== "" && <p className="trace-source-path mono">{block.path}</p>}
      {collapsed ? (
        <>
          <p className="trace-source-cap">
            {t(lang, `trace.source.${block.kind}`, { n: counted(block.text.length, lang) })}{" "}
            <button type="button" className="trace-source-more" onClick={() => setOpen(!open)}>
              {t(lang, open ? "trace.source.hide" : "trace.source.show")}
            </button>
          </p>
          {open && <Budgeted text={block.text} lang={lang} wrap capNote={capNote} />}
        </>
      ) : (
        <Budgeted text={block.text} lang={lang} wrap={block.kind === "text"} capNote={capNote} />
      )}
    </div>
  );
}

/** One line, opened out. Openly a reading of the line, and the one the pane
 *  opens on: see readable.ts for the escape rule that keeps it from rewriting
 *  anybody's shell command. */
function ReadableLine({ line, lang }: { line: string; lang: Lang }) {
  const { parsed, blocks } = useMemo(() => readable(line), [line]);
  return (
    <div className="trace-source-blocks">
      {!parsed && <p className="trace-source-note">{t(lang, "trace.source.notJson")}</p>}
      {blocks.map((b, i) => (
        <ReadableBlockView key={`${b.path}#${i}`} block={b} lang={lang} />
      ))}
    </div>
  );
}

/**
 * The source face of one frame: the line of the imported file it was read from.
 *
 * One sentence per case, and the sentence comes FIRST in every one of them,
 * including the five that have no line to show. A pane that went blank for a
 * session produced here would be the same silence this card exists to end, and
 * a pane that promised a stored line for a frame nothing stored would be the
 * defect itself.
 */
function SourceBody({
  pane,
  reading,
  lang,
  translated,
}: {
  pane: SourcePane;
  reading: Reading;
  lang: Lang;
  /** Whether the rows are carrying translated payloads. The "none" sentence
   *  promises the wire line beside it is the stored line byte for byte, and a
   *  translation is exactly when that stops being true. */
  translated: boolean;
}) {
  if (pane.kind !== "missing" && pane.kind !== "line") {
    return <p className="trace-source-note">{t(lang, sourceSentence(pane, translated))}</p>;
  }
  if (pane.kind === "missing") {
    return (
      <p className="trace-source-note">
        {t(lang, "trace.source.missing", {
          n: counted(pane.lineNumber, lang),
          total: counted(pane.total, lang),
        })}
      </p>
    );
  }
  return (
    <>
      <p className="trace-source-note">
        {pane.siblings > 1
          ? t(lang, "trace.source.shared", {
              n: counted(pane.lineNumber, lang),
              total: counted(pane.total, lang),
              k: counted(pane.siblings, lang),
              i: counted(pane.ordinal, lang),
            })
          : t(lang, "trace.source.line", {
              n: counted(pane.lineNumber, lang),
              total: counted(pane.total, lang),
            })}
      </p>
      {reading === "readable" ? (
        <ReadableLine line={pane.text} lang={lang} />
      ) : (
        <Budgeted key={pane.lineNumber} text={pane.text} lang={lang} />
      )}
    </>
  );
}

/** The expanded frame, in one of five honest views: Structured (the frame as
 *  the thing it is), Insight (the collapsible tree), Compact (highlighted and
 *  WRAPPED, so the whole record is on screen without a horizontal scroll), Wire
 *  (plain text, one row per real wire line, byte faithful and scrolling
 *  sideways) and Source (the line of the imported file this frame was read
 *  from). session_resume expands to the whole
 *  re-uploaded history: one JSONL line per event, exactly what rides back to
 *  the LLM. Above the views: the causal chain (spectro-explain feature 2),
 *  walked back to the prompt. The face a frame lands on comes from the
 *  toolbar's master switch; the row of modes below the chain is the exception
 *  on top of it, and it holds until the master moves (state/traceFace.ts). */
function TraceDetail({
  entry,
  lang,
  chain,
  calls,
  details,
  rows,
  sourceLines,
  provenance,
  translated,
  llmWireSessionId,
  onJump,
}: {
  entry: TraceEntry;
  lang: Lang;
  /** Precomputed in the parent (only the ONE open row carries a chain, so
   *  the memoized closed rows never see a changing prop). */
  chain: TraceEntry[];
  /** Same rule as the chain: only the open row gets the call index. */
  calls?: ReadonlyMap<string, ToolCallRef>;
  /** Same rule as the calls: only the open row gets the detail index. */
  details?: ReadonlyMap<string, ToolResultDetail>;
  /** The frames this one stands among, read only to count the ones that share
   *  its source line. Same rule again: only the open row gets them. */
  rows: readonly TraceEntry[];
  /** The imported file's lines, or null when no file is loaded. */
  sourceLines?: readonly string[] | null;
  /** Which of the three fileless cases this trace is, for the pane's sentence. */
  provenance: TraceProvenance;
  /** Whether the payload on the wire face is a translated one. */
  translated: boolean;
  /** The session whose llm-wire sidecar an exchange row may ask, or null. */
  llmWireSessionId: string | null;
  onJump: (seq: number) => void;
}) {
  // The row subscribes to the master itself: only the OPEN row renders a
  // detail, so a master change re-renders exactly this one panel and leaves
  // every closed row closed — the switch picks a face, it does not expand.
  const master = useTraceFace();
  const [override, setOverride] = useState<RowFace | null>(null);
  // Which faces THIS row can fill, and the one it shows. A recorded LLM
  // exchange has no source line, and the master is a default for every row at
  // once, so a reader whose master is `source` has to land somewhere real:
  // availableFace decides that once, deterministically (state/traceFace.ts).
  const faces = facesFor(entry.type);
  const mode = availableFace(rowFace(master, override), faces);
  // The recorded exchange renders itself on EVERY face, from ONE fetch. This
  // line is card 184's repair: the rejected version routed only `structured`
  // here, so insight, wire and source went on reading the metadata frame while
  // the recorded bytes sat one fetch away.
  const isExchange = frameLayer(entry.type) === "llm";
  // How the pane reads what it was given. Readable opens first (owner call,
  // 2026-08-03): a source line is escaped JSON inside escaped JSON, and the
  // verbatim form is unreadable at a glance, so opening on it makes the pane
  // look broken rather than faithful. The honesty this card was built for does
  // not live in which reading opens: it lives in the strip saying which one is
  // showing, in verbatim being one click away, and in the copy button handing
  // over what the pane claims to show. Session state, never persisted, so the
  // choice cannot follow a reader into a file they have not looked at yet.
  const [chosen, setChosen] = useState<Reading>("readable");
  // Only two panes have two readings to choose between. Structured and Insight
  // already render the parsed payload, and Compact's whole job is the wire line
  // with its escapes highlighted.
  // The exchange's wire face is OUR rendering of recorded bytes, not a line of
  // somebody's file, so it has no verbatim/readable pair to choose between.
  const hasReading = !isExchange && (mode === "source" || mode === "wire");
  const reading: Reading = hasReading ? chosen : "verbatim";
  const lines = detailLines(entry.type, entry.payload);
  // The line this frame was read from, or nothing. Only the source pane's copy
  // button hands it over, and only when there is one to hand over.
  // Walked once: the sibling count reads every row, and the pane is needed both
  // for the body and for whether there is anything to copy.
  const pane = mode === "source" ? sourcePane(entry, rows, sourceLines, provenance) : null;
  const sourceText = pane?.kind === "line" ? pane.text : undefined;
  // The record behind this frame, for the structured face. Read right here and
  // not indexed up front: only the ONE open row renders a detail, so this is a
  // single JSON.parse on click, where an eager index over the whole import
  // would parse an 80 MB file to fill a panel nobody opened. A frame the
  // importer built itself has no line and therefore no record.
  const at = entry.sourceLine;
  const metaLine = mode === "structured" && at !== undefined ? sourceLines?.[at] : undefined;
  const meta = useMemo<readonly MetaGroup[]>(
    () => (metaLine === undefined ? [] : readRecordMeta(metaLine)),
    [metaLine],
  );
  const copyMode = mode === "structured" ? "insight" : mode;
  // A copy button hands over what the pane SHOWS. For an exchange the pane
  // shows the recorded bodies and the clipboard helper only knows the frame,
  // so no button beats a button that copies the postmark. The whole sidecar is
  // a download away (GET /api/sessions/{id}/llm-wire).
  const copyable = !isExchange && (mode !== "source" || sourceText !== undefined);
  return (
    <div className="trace-detail">
      {chain.length > 1 && (
        <div className="trace-chain" role="group" aria-label={t(lang, "trace.chainAria")}>
          <span className="trace-chain-label mono">{t(lang, "trace.chain")}</span>
          {chain.map((link, i) => (
            <span key={link.seq} className="trace-chain-step">
              {i > 0 && (
                <span className="trace-chain-arrow" aria-hidden="true">
                  &#8594;
                </span>
              )}
              {link.seq === entry.seq ? (
                <span className="trace-chain-chip trace-chain-chip--here mono">{chainLabel(link)}</span>
              ) : (
                <button type="button" className="trace-chain-chip mono" onClick={() => onJump(link.seq)}>
                  {chainLabel(link)}
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="trace-detail-modes" role="group" aria-label={t(lang, "trace.modeAria")}>
        {faces.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setOverride({ face: m, epoch: master.epoch })}
          >
            {t(lang, `trace.mode.${m}`)}
          </button>
        ))}
      </div>
      {/* Which of the two readings the pane is showing. Inside the pane and not
          a face. With readable opening first, this strip is what stops the pane
          from passing an interpretation off as the bytes: it names the
          rendering on screen, and verbatim is the click next to it. */}
      {hasReading && (
        <div
          className="trace-detail-modes trace-reading"
          role="group"
          aria-label={t(lang, "trace.readingAria")}
        >
          {READINGS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reading === r}
              title={t(lang, `trace.readingTitle.${r}`)}
              onClick={() => setChosen(r)}
            >
              {t(lang, `trace.reading.${r}`)}
            </button>
          ))}
        </div>
      )}
      {/* Structured has no text of its own: what it renders IS the payload, so
          the copy button hands over the payload, pretty-printed. A source pane
          with no line behind it has nothing to copy, so it offers no button
          rather than a button that hands over an empty string. */}
      {copyable && (
        <CopyButton
          text={() => detailText(copyMode, entry.type, entry.payload, { line: sourceText, reading })}
          label={t(lang, `common.${copyLabel(copyMode, reading)}`)}
        />
      )}
      {isExchange ? (
        /* Every face of an exchange reads the same fetch: the parts on
           structured, the tree over the PARSED body on insight, the literal
           POST and its stream lines on wire. Source is not offered. */
        <LlmExchangeDetail
          payload={entry.payload}
          sessionId={
            ((entry.payload as { wireSession?: unknown } | null)?.wireSession as string | undefined) ??
            llmWireSessionId
          }
          face={mode === "insight" || mode === "wire" ? mode : "structured"}
          half={
            entry.type === "llm_request" ? "request" : entry.type === "llm_response" ? "response" : "both"
          }
        />
      ) : mode === "structured" ? (
        <EventStructured
          type={entry.type}
          payload={entry.payload}
          calls={calls}
          details={details}
          meta={meta}
        />
      ) : mode === "insight" ? (
        // Expand every level of the event from the start — no clicking open the
        // nested {…} (e.g. a plan's steps, a context_info's parts). Real events
        // never nest anywhere near this deep, so 99 reads as "all".
        <JsonTree value={entry.payload} defaultDepth={99} />
      ) : pane !== null ? (
        <SourceBody pane={pane} reading={reading} lang={lang} translated={translated} />
      ) : reading === "readable" ? (
        <div className="trace-source-blocks">
          {lines.map((ln, i) => (
            <ReadableLine key={i} line={ln} lang={lang} />
          ))}
        </div>
      ) : (
        <pre className="trace-detail-raw">{lines.join("\n")}</pre>
      )}
    </div>
  );
}

/**
 * Whether this view speaks for the shared in-view search.
 *
 * Chat, text and trace all report their hit count into one store
 * (`state/search.ts`), and since card 175 the trace stays MOUNTED while another
 * tab shows. A hidden view that kept reporting overwrote the count of the view
 * the reader was actually searching in — this one's effect runs after the
 * chat's, so the chat's count lost every time.
 *
 * @param showing whether this is the surface on screen
 * @param open whether the search box is open
 * @param query what is typed in it
 * @return whether this view should report its hits
 */
export function ownsSearch(showing: boolean, open: boolean, query: string): boolean {
  return showing && open && query.trim() !== "";
}

export function TraceView(props: {
  entries: TraceEntry[];
  /** Whether this is the surface the reader is looking at. Absent means yes:
   *  the fleet's own trace tab mounts this view only when it is showing. The
   *  sessions chain keeps it mounted behind other tabs (card 175) and passes
   *  the answer, because a view nobody is looking at must not speak for the
   *  shared search store. */
  showing?: boolean;
  /** How many rows the LIVE window has thrown away (card 116). The pane says it
   *  out loud, because a cap nobody can see is indistinguishable from a
   *  coincidence — the reader could not tell whether 5000 was the maximum or
   *  simply where the session ended. Zero, and absent, for anything finite. */
  droppedRows?: number;
  /** Card 246: true when this is the LIVE record and the operator turned the
   *  live trace off — the empty state then says so instead of implying the
   *  session produced nothing. Absent for archives and the fleet pane. */
  liveTraceOff?: boolean;
  /** Lane hand-off from the Spectrum tab: show only this agent's frames
   *  (frames without an agentId — decisions, run ends — stay visible).
   *  null = all agents. Controlled by App so the pin survives tab switches. */
  agentFilter?: string | null;
  onAgentFilter?: (agentId: string | null) => void;
  /** Per-event hand-off from the Spectrum band: open + flash THIS exact event's
   *  frame (matched by identity — its payload IS this object). */
  focusEvent?: RunEvent | null;
  /** Called once the focus was consumed, so App can clear it (a repeat click on
   *  the same event re-focuses). */
  onFocusHandled?: () => void;
  /** Card 137: this session's trace in the configured Langfuse, computed in the
   *  browser from the session id. null whenever no link can work: nothing
   *  exported yet, or the backend is not Langfuse. */
  langfuseUrl?: string | null;
  /** The imported transcript's store-relative path, for the folder buttons. */
  storePath?: string | null;
  /** The message of a failed export, but only while NOTHING has landed yet.
   *  null keeps the toolbar silent. */
  otlpFailure?: string | null;
  /** The imported file's own lines (card: the source line). null when no file
   *  is loaded, which is the case `provenance` then has to tell apart. A few
   *  fields live only in an imported transcript, and this is where the trace
   *  reads them from. */
  sourceLines?: readonly string[] | null;
  /** Where these frames came from when no file is loaded: produced and stored
   *  here, compiled from a scenario, or another process's. The source pane says
   *  a different sentence for each, and only the first one may promise a stored
   *  line. Absent means the plain case, which is what a live socket is. */
  provenance?: TraceProvenance;
  /** Whether these rows are showing translated payloads. App swaps every row's
   *  payload when a translation is applied, so the wire face is then a rebuilt
   *  record and the source pane may not call it the stored line. */
  translated?: boolean;
  /** The session whose llm-wire sidecar an expanded llm_exchange row may
   *  fetch from. Absent or null means there is none to ask — an import, a
   *  scenario, an entered fleet — and the detail says so instead of fetching. */
  llmWireSessionId?: string | null;
}) {
  const { entries } = props;
  const agentFilter = props.agentFilter ?? null;
  const lang = useLang();
  const [query, setQuery] = useState("");
  // The direction segment and the category chips are PERSISTED preferences,
  // not view state (card 184, owner: "ein filter auf solche messages wäre
  // cool"). Both used to live in useState here, and both of App's mount sites
  // unmount this component on every tab change, so isolating the LLM traffic
  // and walking to chat put every chip straight back on. The free-text query
  // above deliberately does NOT persist: a selection is a reading stance, a
  // search is about one file.
  const filter = useTraceFilter();
  const llmDir = filter.llmDir;
  const setLlmDir = setTraceLlmDir;
  const active = useMemo<ReadonlySet<Category>>(
    () => activeCategories(filter.categories, CATEGORIES) as ReadonlySet<Category>,
    [filter.categories],
  );
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  // Card 181: the address and this view keep up with each other. The reading
  // that travels is the open row and the filters, and the filters only when
  // some are off — a link a reader copies should not carry a clause describing
  // a state nobody chose.
  useEffect(() => {
    reportView("trace", {
      row: openSeq ?? undefined,
      only: onlyClause(active as ReadonlySet<string>, CATEGORIES),
    });
  }, [openSeq, active]);
  // Taken ONCE per offer. Keyed on the OFFER, not on the entries: navigating
  // within a session leaves the entries alone, so keying on them meant back and
  // forward between two readings of one session moved the address and left this
  // view exactly where it was. Found live, on the second link pasted.
  const offered = useSyncExternalStore(subscribeReportedViews, incomingGeneration, incomingGeneration);
  useEffect(() => {
    const arriving = takeIncomingView("trace");
    if (arriving === undefined) return;
    if (arriving.row !== undefined) setOpenSeq(arriving.row);
    if (arriving.only !== undefined) {
      // An address may name anything; only the categories this build has are
      // believed, and an unknown one is dropped rather than trusted.
      //
      // Straight into the PERSISTED filter, not into local state: card 184 moved
      // the chips into a store because both of App's mount sites unmount this
      // component on every tab change. A link that arrives has to write where
      // the chips actually live, or it would be forgotten on the next tab.
      setTraceCategories(arriving.only.filter(isCategory));
    }
  }, [offered, entries]);
  const [freshCount, setFreshCount] = useState(0);
  // Reasoning lens (card 13): a persisted preference, not view state — it
  // survives reloads and applies to live and replay alike.
  const { prefs } = useDesignPrefs();
  const lensOn = prefs.reasoningLens;
  // Timeline lens (langfuse P1.3): same persistence pattern as the reasoning
  // lens; the two compose (dimmed rows still wear their wait bars).
  const tlOn = prefs.timelineLens;
  // OTel mirror rows (card 86): default off — the exports sit in the ring
  // either way, the chip only reveals them.
  const otelOn = prefs.otelRows;
  // Card 137: link, honest failure line, or nothing at all.
  const linkState = traceLinkState(props.langfuseUrl ?? null, props.otlpFailure ?? null);
  // What the imported lines say beyond their frames. Built once per import and
  // sparse: a session produced here yields an empty map and every lookup below
  // misses, which is exactly the "renders nothing" case.
  const noteIndex = useMemo(() => sourceNoteIndex(props.sourceLines), [props.sourceLines]);
  // One record fans out to several frames; its notes ride on ONE of them.
  const anchors = useMemo(() => (noteIndex.size === 0 ? null : noteAnchors(entries)), [noteIndex, entries]);
  // Optional columns (owner 2026-07-27): host and model, both on out of the
  // box. A hidden column takes nothing but itself — no row changes meaning.
  const chosenCols = useTraceColumns();
  // The master face: which view a frame opens in. Only the toolbar's own
  // buttons need it here — the open frame reads the store itself.
  const { face } = useTraceFace();
  // In-view search (the shared store). In a table the HIT IS THE ROW: matching
  // rows are marked, the current one more strongly, and stepping walks them.
  const { open: searchOpen, query: searchQuery, regex: searchRegex, index: searchIndex } = useSearch();
  // A closed or empty search costs nothing — no text is built, no row walked.
  // And neither does a search in a view that is mounted behind another tab.
  const showing = props.showing ?? true;
  const searching = ownsSearch(showing, searchOpen, searchQuery);
  // Replay scrubber: cap the visible stream at one frame (null = the live
  // end). Scrubbing back reads the run exactly as far as it had happened.
  const [capSeq, setCapSeq] = useState<number | null>(null);
  // The explain panel (the why layer) docks right of the stream.
  const [explainOpen, setExplainOpen] = useState(false);
  // The system context is uploaded (as the "system" role) with every request but
  // is NOT a wire event, so it can't appear as a frame on its own. We fetch it
  // and prepend ONE synthetic ↑ row so the "what gets uploaded" side is visible.
  const [ctx, setCtx] = useState<TraceContext | null>(null);
  useEffect(() => {
    let alive = true;
    // Asked once per app rather than once per mount: this view now unmounts and
    // remounts whenever a record arrives (card 175), and the operator's
    // configuration is not a property of the record.
    void loadTraceContext().then((c) => {
      if (alive && c) setCtx(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The trace OPENS at the top (the reader studies from the beginning);
  // auto-follow only engages once the user scrolls down to the live end.
  const pinnedRef = useRef(false);
  const prevLen = useRef(entries.length);

  // ---- the window (card 117) --------------------------------------------
  // Only the rows in view are built. The RECORD stays whole — card 116 settled
  // that a trace must never silently begin in the middle — so the two spacers
  // below carry the full height of everything not built, and the scrollbar
  // still measures the entire session.
  //
  // Every measurement here comes from the DOM rather than a constant, because a
  // guessed row height is a scrollbar that drifts. Until they arrive (first
  // frame, or any environment without layout) the window renders whole, which
  // is exactly the behaviour that shipped before this card.
  const headRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ viewportH: 0, rowH: 0, headH: 0, scrollTop: 0 });
  const [openH, setOpenH] = useState(0);
  /** A row the stepper wants focused once the window has built it. */
  const focusPending = useRef<number | null>(null);

  const toggleCat = (c: Category): void => toggleTraceCategory(c, CATEGORIES);

  // Prepend the synthetic system_context frame once, at the top, when a run has
  // started and the context is loaded. It is display-only — never in the reducer,
  // never in the JSONL.
  // Every closing exchange also stands for the moment it CLOSED. The response
  // row is display-only, exactly like the synthetic system_context row below:
  // never in the reducer, never in any JSONL, and it carries the same payload
  // so the detail pane reads one shape wherever a row came from.
  // What this browser was told about its own voice calls (card 184 leg 2b).
  // They never rode the session socket, so they are folded in here at their own
  // moments rather than arriving through the reducer.
  const voice = useVoiceExchanges();
  const withPairs = useMemo(() => traceWithVoice(entries, voice), [entries, voice]);
  const allEntries = useMemo<TraceEntry[]>(() => {
    const entries = withPairs;
    if (ctx === null || entries.length === 0) return entries;
    const sys: TraceEntry = {
      seq: 0,
      dir: "out",
      ts: entries[0].ts,
      type: "system_context",
      payload: {
        note: t(lang, "trace.sysNote"),
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools.map((t) => t.name),
        skills: ctx.skills.map((s) => s.name),
        mcpServers: ctx.mcpServers,
      },
    };
    return [sys, ...entries];
  }, [withPairs, ctx, lang]);

  // What the pane says about its own live window (card 116). Deliberately fed
  // `entries` and not `allEntries`: the three lists above differ, and only the
  // first one is the record the window actually cut. null = say nothing.
  const dropDisclosure = useMemo(
    () => traceDisclosure(entries, props.droppedRows ?? 0),
    [entries, props.droppedRows],
  );

  // Agents seen in this stream, first-seen order — the chip row's catalog.
  const agents = useMemo(() => {
    const seen: string[] = [];
    for (const e of entries) {
      if (e.agentId !== undefined && !seen.includes(e.agentId)) seen.push(e.agentId);
    }
    return seen;
  }, [entries]);

  const bySeq = useMemo(() => new Map(allEntries.map((e) => [e.seq, e])), [allEntries]);
  // Whether a tool_result row is open — the second reader of the index below,
  // and the condition openDetails has always been paid for under.
  const openType = openSeq === null ? undefined : bySeq.get(openSeq)?.type;
  /** A row whose OWN payload carries the importer's reading of a tool result. */
  const openIsToolResult = openType === "tool_result";
  /**
   * A row that needs the callId index — which is one row wider than the above.
   *
   * A `tool_result_detail` frame is `{type, callId, detail, ts}`: the call it
   * answers is named only by its id, exactly like a `tool_result`. Testing for
   * `"tool_result"` alone handed that row `calls: undefined`, so the strongest
   * evidence about what a lifted body IS — the file path on the call, which
   * every one of the 3,215 such frames in this store carries — was unreachable
   * from the very row that needed it.
   */
  const openNeedsCalls = openIsToolResult || openType === "tool_result_detail";

  // callId -> the call it belongs to: one pass over the whole stream, shared by
  // the two readers that need it. The chip row decides every tool_result with
  // it (a result carries no tool name, only the id of the call it answers), and
  // the open row's structured face renders the call it answers from it.
  //
  // Built only when it can change something — while the tool chips disagree
  // ({@link needsCallIndex}) or while such a row is open. `allEntries` is a new
  // array on every frame batch of a live session, so an unconditional memo here
  // would re-walk the whole stream per batch for a trace nobody has filtered;
  // the two readers were both already conditional, and this keeps them so.
  //
  // The memo turns on the ANSWER, never on `active` itself. `active` is a new
  // Set on every chip click, so depending on it would rebuild the map — and
  // re-run the open row's `describeEvent` — each time a reader pressed an
  // unrelated chip on a resting import. Cheap either way, measured; but with a
  // row open the need is true whatever the chips say, so keying on the answer
  // means the map that row holds simply cannot move under it.
  const wantCallIndex = needsCallIndex(active) || openNeedsCalls;
  const callIndex = useMemo(
    () => (wantCallIndex ? toolCallsById(allEntries.map((e) => e.payload)) : undefined),
    [wantCallIndex, allEntries],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allEntries.filter((e) => {
      if (capSeq !== null && e.seq > capSeq) return false;
      if (e.type === "otlp_export" && !otelOn) return false;
      if (agentFilter !== null && e.agentId !== undefined && e.agentId !== agentFilter) return false;
      if (llmDir !== "all" && llmDirection(e.type) !== llmDir) return false;
      if (!inCategories(e, active, callIndex)) return false;
      if (q === "") return true;
      return searchText(e).toLowerCase().includes(q);
    });
  }, [allEntries, query, llmDir, active, agentFilter, capSeq, otelOn, callIndex]);

  // The window itself. openIndex is looked up in the CURRENT filtered list, so
  // a filter that hides the open row simply reports -1 and no offset bends.
  const openIndex = useMemo(
    () => (openSeq === null ? -1 : visible.findIndex((e) => e.seq === openSeq)),
    [openSeq, visible],
  );
  // The fallbacks matter more than they look. Card 175 keeps this view MOUNTED
  // but hidden behind `display: none`, so the rows are built while the trace tab
  // is not showing — and a hidden element has clientHeight 0. Measuring first
  // and windowing second would therefore leave the one cost this card is about
  // (building 9,319 rows during the session load) completely unbounded, because
  // at that moment there is nothing to measure.
  //
  // So an unmeasured view gets a plausible window instead of the whole list.
  // These two numbers are only ever a first guess: the ResizeObserver replaces
  // both the moment the tab is shown, and every offset is recomputed from the
  // real ones. Guessing low would show a gap for one frame; guessing high only
  // costs rows nobody sees, so they lean high.
  const slice = traceWindow({
    scrollTop: metrics.scrollTop - metrics.headH,
    viewportH: metrics.viewportH > 0 ? metrics.viewportH : TRACE_FALLBACK_VIEWPORT_PX,
    count: visible.length,
    rowH: metrics.rowH > 0 ? metrics.rowH : TRACE_FALLBACK_ROW_PX,
    openIndex,
    openH,
    overscan: TRACE_OVERSCAN_ROWS,
  });

  /** Scrolls row {@code index} to the middle without needing it in the DOM. */
  const centreOn = (index: number): void => {
    const el = scrollRef.current;
    if (el === null || metrics.rowH <= 0) return;
    const y = traceRowOffset(index, metrics.rowH, openIndex, openH) + metrics.headH;
    const top = Math.max(0, y - el.clientHeight / 2 + metrics.rowH / 2);
    el.scrollTop = top;
    // The window is moved HERE rather than left to the scroll event this
    // assignment will fire. Waiting for the event makes the stepper depend on
    // the compositor delivering one, and when it does not, the view jumps to a
    // row the window never builds — the reader lands on a blank band and the
    // frame they stepped to is nowhere. Measured exactly that way before this
    // line existed.
    setMetrics((m) => (m.scrollTop === top ? m : { ...m, scrollTop: top }));
    pinnedRef.current = false;
  };

  // Timeline lens: waits normalized over the VISIBLE rows (filters change what
  // "the largest gap" means — the bars answer the question for what you see).
  const tlFractions = useMemo(
    () => (tlOn ? timelineFractions(visible.map((e) => e.ts)) : null),
    [tlOn, visible],
  );

  // Said-vs-did pairs for the lens: block-ending thinking frame -> the next
  // same-agent action. Computed on the FULL stream so pairs survive filters.
  const pairs = useMemo(
    () => (lensOn ? reasoningPairs(allEntries) : new Map<number, number>()),
    [lensOn, allEntries],
  );
  // The whole reasoning text behind each block, keyed by the block-ending seq —
  // the lens shows the complete thought, not just the fragment on one row.
  const blockTexts = useMemo(
    () => (lensOn ? reasoningBlockText(allEntries) : new Map<number, string>()),
    [lensOn, allEntries],
  );
  // And the same relation read backwards: the block that was in charge when an
  // action ran. Without it a tool call said nothing under the lens at all —
  // measured, 41,346 imported tool_call rows and not one of them spoke.
  const reach = useMemo(
    () => (lensOn ? reasoningReach(allEntries) : new Map<number, number>()),
    [lensOn, allEntries],
  );
  const hasThinking = useMemo(() => allEntries.some((e) => e.type === "thinking_delta"), [allEntries]);

  // The open row's causal chain (spectro-explain feature 2) — computed here
  // so the memoized closed rows never receive a changing prop.
  const openChain = useMemo(() => {
    if (openSeq === null) return undefined;
    const target = bySeq.get(openSeq);
    return target === undefined ? undefined : causalChain(allEntries, target);
  }, [openSeq, bySeq, allEntries]);

  // A tool_result names only its callId, so the structured face needs the call
  // it answers. It is the same index the chip row decides with, handed down
  // only while such a row is open — a closed trace passes `undefined` to the
  // row that does not use it, even on the days the chip row built one anyway.
  const openCalls = openNeedsCalls ? callIndex : undefined;

  // And what those calls returned, when the stream carries an importer's
  // reading of it. Built under exactly the same condition and paid for the same
  // way: only while a tool_result row is open, and never for a live stream that
  // has no such frame in it at all.
  const openDetails = useMemo(
    () => (openIsToolResult ? toolResultDetailsById(allEntries.map((e) => e.payload)) : undefined),
    [openIsToolResult, allEntries],
  );

  // What the source face reads: the file's lines, and the frames the open row
  // stands among so it can count the ones that share its line. Counted over the
  // WHOLE stream and never over the filtered view. A sibling count that shrank
  // when somebody typed in the filter box would be a number meaning two things,
  // which is the defect this face exists to remove.
  const openSource = useMemo(
    () => ({ rows: allEntries, lines: props.sourceLines ?? null }),
    [allEntries, props.sourceLines],
  );
  // Which of the three fileless cases this trace is. One string for the whole
  // view: it says nothing about a single frame, so it cannot vary by row.
  const provenance = props.provenance ?? "stored";

  // Jump: open the frame and bring its row into view (it may sit outside the
  // current scroll window; if a filter hides it, the row simply is not there).
  const jumpTo = useCallback((seq: number): void => {
    setOpenSeq(seq);
    requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
      if (!row) return;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "center" });
      // A brief flash so a jump (chain chip OR a Spectrum event) lands the eye.
      row.classList.add("trace-row--flash");
      setTimeout(() => row.classList.remove("trace-row--flash"), 1200);
    });
  }, []);

  // Spectrum drill-in: find THIS event's frame by identity (its payload is the
  // very object the band handed us) and jump to it, then clear the request so a
  // repeat click on the same event fires again. A miss is possible only for a
  // very old event whose row has scrolled past the trace's memory cap (the band
  // draws from the uncapped stream); the tab switch + agent filter that App
  // applied still land the reader on that agent's surviving trace — the exact
  // scroll+flash is what degrades, not the whole affordance.
  const { focusEvent, onFocusHandled } = props;
  useEffect(() => {
    if (!focusEvent) return;
    const match = allEntries.find((e) => e.payload === focusEvent);
    if (match) jumpTo(match.seq);
    onFocusHandled?.();
  }, [focusEvent, allEntries, jumpTo, onFocusHandled]);

  // Protocol + host per frame: one pass carries the current provider (from
  // each run_start AND each provider_info frame), the current LLM host (from
  // provider_info — socket-only, so replays fall back to what the provider
  // name implies), and resolves a tool_result's tool/url through its callId.
  // Where our own frames really came from. A session produced HERE rode the
  // socket of the page that is showing it; an import rode somebody else's, and
  // this browser has no record of which — so it says so instead of guessing.
  const appOrigin = useMemo(() => {
    // An imported file carries its own lines; its frames rode a socket this
    // browser never saw and whose host is nowhere in the record.
    if (props.sourceLines !== undefined && props.sourceLines !== null && props.sourceLines.length > 0) {
      return null;
    }
    try {
      return window.location.host || null;
    } catch {
      return null; // no window (tests)
    }
  }, [props.sourceLines]);
  const metaBySeq = useMemo(() => {
    const bySeq = new Map<number, { proto: string; host: string }>();
    const nameByCall = new Map<string, string>();
    const urlByCall = new Map<string, string>();
    // Seed with the session's first provider/host so the synthetic
    // system_context row (which sits BEFORE the first run_start but rides
    // every request) already names the right wire.
    let provider: string | null = null;
    let llmHost: string | null = null;
    for (const e of allEntries) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === "provider_info") {
        provider = typeof p["provider"] === "string" ? (p["provider"] as string) : provider;
        llmHost = typeof p["host"] === "string" ? (p["host"] as string) : llmHost;
        break;
      }
      if (e.type === "run_start" && typeof p["provider"] === "string") {
        provider = p["provider"] as string;
        break;
      }
    }
    for (const e of allEntries) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === "run_start" && typeof p["provider"] === "string") {
        provider = p["provider"] as string;
      } else if (e.type === "provider_info") {
        // The switch frame: from here on the LLM rows ride the new backend.
        if (typeof p["provider"] === "string") provider = p["provider"] as string;
        if (typeof p["host"] === "string") llmHost = p["host"] as string;
      }
      let toolName: string | null = null;
      let url: string | null = null;
      if (e.type === "tool_call") {
        toolName = typeof p["name"] === "string" ? (p["name"] as string) : null;
        const input = p["input"] as Record<string, unknown> | undefined;
        url = input !== undefined && typeof input["url"] === "string" ? (input["url"] as string) : null;
        if (toolName !== null && typeof p["callId"] === "string") {
          nameByCall.set(p["callId"] as string, toolName);
          if (url !== null) urlByCall.set(p["callId"] as string, url);
        }
      } else if (e.type === "tool_result" && typeof p["callId"] === "string") {
        toolName = nameByCall.get(p["callId"] as string) ?? null;
        url = urlByCall.get(p["callId"] as string) ?? null;
      }
      // The recorded exchange carries its OWN url, which is the fact the host
      // column should print rather than anything inferred from the provider.
      if (frameLayer(e.type) === "llm" && typeof p["url"] === "string") {
        url = p["url"] as string;
      }
      const imageProvider =
        typeof p["provider"] === "string" && e.type === "image_generated" ? (p["provider"] as string) : null;
      // What the exchange itself recorded about its wire — the column describes
      // the row rather than the provider it happens to belong to.
      const llmFacts =
        frameLayer(e.type) === "llm"
          ? {
              transport: typeof p["transport"] === "string" ? (p["transport"] as string) : undefined,
              kind: typeof p["kind"] === "string" ? (p["kind"] as string) : undefined,
            }
          : null;
      bySeq.set(e.seq, {
        proto: wireProtocol(e.type, provider, toolName, llmFacts),
        host: wireHost(e.type, provider, llmHost, toolName, url, imageProvider, appOrigin),
      });
    }
    return bySeq;
  }, [allEntries, appOrigin]);

  // A column this session cannot fill is taken away: a VS Code export records
  // neither host nor model, and a pre-0.4.0 archive no model, so holding those
  // columns open spends the reader's width on a colonnade of dashes. The
  // reader's own OFF still wins — this can only ever remove a column.
  const cols = useMemo(
    () =>
      effectiveTraceColumns(
        chosenCols,
        traceColumnData(
          allEntries.map((e) => ({ host: metaBySeq.get(e.seq)?.host ?? null, model: e.model })),
        ),
      ),
    [chosenCols, allEntries, metaBySeq],
  );

  // The searchable text per row, built once per stream / column / language
  // change — never per keystroke, so typing only re-walks strings that exist.
  const searchTexts = useMemo<string[]>(() => {
    if (!searching) return [];
    return allEntries.map((e) =>
      traceRowText(
        {
          proto: metaBySeq.get(e.seq)?.proto ?? "—",
          host: metaBySeq.get(e.seq)?.host ?? "—",
          model: e.model,
          agentId: e.agentId,
          type: e.type,
          summary: summarize(e, lang),
        },
        cols,
      ),
    );
  }, [searching, allEntries, metaBySeq, cols, lang]);

  // Only rows the filters let through can become hits — a mark on a row that is
  // not on screen would be a lie. The rest are counted and confessed instead.
  const searchRows = useMemo<TraceHitRow[]>(() => {
    if (!searching) return [];
    const shown = new Set(visible.map((e) => e.seq));
    return allEntries.map((e, i) => ({
      seq: e.seq,
      text: searchTexts[i] ?? "",
      shown: shown.has(e.seq),
    }));
  }, [searching, allEntries, searchTexts, visible]);

  const hits = useMemo(
    () => traceHits(searchRows, searchQuery, searchRegex),
    [searchRows, searchQuery, searchRegex],
  );
  const hitSeqs = useMemo(() => new Set(hits.seqs), [hits.seqs]);
  const hitCount = hits.seqs.length;
  // Clamp: a filter can shrink the hit list one render before the store hears
  // about it, and index is the store's, not ours.
  const currentHit = hitCount === 0 ? 0 : Math.min(searchIndex, hitCount - 1);
  const currentSeq = hitCount === 0 ? null : hits.seqs[currentHit];

  // The store keeps the position, the view keeps the hits: report the count
  // from an effect, never during render.
  useEffect(() => {
    if (searching) reportCount(hitCount);
    // See Chat.tsx: query and mode zero the store's count, so an effect keyed
    // only on the number goes silent when two queries share a hit count.
  }, [searching, searchQuery, searchRegex, hitCount]);

  // Leaving the trace takes its hits with it. Without this the next tab would
  // inherit a count nobody can step through — and React runs this cleanup
  // before the incoming view's effects, so it never eats a fresh report.
  //
  // Only when this view was the one on screen, though. Since card 175 the trace
  // also unmounts for a reason that has nothing to do with the reader leaving
  // it: a record arriving while they are on the chat. Zeroing there would wipe
  // the count of the chat's own search, which is the surface being read.
  // The ref is written from an effect on purpose — on the unmounting render
  // this component does not run, so the cleanup reads the last state it was in.
  const wasShowing = useRef(showing);
  useEffect(() => {
    wasShowing.current = showing;
  }, [showing]);
  useEffect(
    () => () => {
      if (wasShowing.current) reportCount(0);
    },
    [],
  );

  // Walk to the current hit. No focus() — the reader is typing in the search
  // box, and taking the caret away would end the search mid-word. The scroll
  // handler sees this move like any other and releases the auto-follow pin.
  useEffect(() => {
    if (currentSeq === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${currentSeq}"]`);
    if (row !== null && row !== undefined) {
      row.scrollIntoView({ block: "center" });
      return;
    }
    // The hit is outside the window (card 117) — walk there by arithmetic. A
    // search that quietly refused to move for hits beyond the built rows would
    // be worse than a slow search.
    const at = visible.findIndex((e) => e.seq === currentSeq);
    if (at >= 0) centreOn(at);
    // Deps stay narrow ON PURPOSE. This effect walks to a hit; `visible` and
    // `centreOn` change on every filter and every scroll, and re-running then
    // would yank the reader's position around — the exact instability card 117
    // asks to prevent. It must fire when the hit moves, and only then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSeq, searchQuery]);

  // Auto-follow: stick to the bottom while pinned (same pattern as the chat);
  // count what arrives while the reader is scrolled up studying a frame.
  const total = entries.length;
  useEffect(() => {
    const el = scrollRef.current;
    const grew = total - prevLen.current;
    prevLen.current = total;
    if (grew < 0) setFreshCount(0); // new chat or a different session
    if (el === null) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (grew > 0) {
      setFreshCount((n) => n + grew);
    }
  }, [total]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_PIN_THRESHOLD_PX;
    pinnedRef.current = pinned;
    if (pinned) setFreshCount(0);
    // The window follows the scroll. Committed straight rather than through a
    // frame callback: React already batches this, and a deferred scrollTop
    // shows the reader a blank band for one frame at exactly the moment they
    // are looking at it.
    setMetrics((m) => (m.scrollTop === el.scrollTop ? m : { ...m, scrollTop: el.scrollTop }));
  };

  // The three measurements the window runs on. Re-read on resize, because a
  // pane drag changes the viewport and a font change changes the row.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const read = (): void => {
      const row = el.querySelector<HTMLElement>('.trace-row:not([aria-expanded="true"])');
      setMetrics((m) => {
        const next = {
          viewportH: el.clientHeight,
          rowH: row?.offsetHeight ?? m.rowH,
          headH: headRef.current?.offsetHeight ?? m.headH,
          scrollTop: el.scrollTop,
        };
        return next.viewportH === m.viewportH && next.rowH === m.rowH && next.headH === m.headH
          ? m
          : { ...m, ...next };
      });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entries.length, tlOn, cols.host, cols.model]);

  // Where the stepper lands. The row is focused AND centred here rather than in
  // `openAt`, and both for the same reason: at the moment the reader presses the
  // key, the row that is closing still holds its detail and the row that is
  // opening has none, so the document the scroll would be computed against is
  // one React commit out of date. This effect runs after that commit, with the
  // real layout in front of it.
  //
  // Card 211 measured what the synchronous version cost once the spacers became
  // exact: stepping onto a row left it 849 px ABOVE the viewport, because the
  // scroll was aimed at a geometry that changed a millisecond later. It also
  // covers the case this effect was written for — a row still outside the
  // window — where without it the stepper moved the view and left the keyboard
  // on the old row, so the next Space stepped from the wrong place.
  useLayoutEffect(() => {
    const want = focusPending.current;
    if (want === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${want}"]`);
    if (row !== null && row !== undefined) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "center" });
      focusPending.current = null;
    }
  });

  // The expanded row's height. Nothing below it can be placed correctly without
  // this, and it is the ONE row whose height is not known in advance.
  //
  // Card 211 rewrote how it is taken, twice over. It used to be an effect keyed
  // on [openSeq] that measured `[data-seq=…]`, and both halves were wrong:
  //
  //   - `[data-seq=…]` is the row BUTTON, and the detail is its sibling. The
  //     effect therefore measured 25 px under a 1,143 px detail and the window
  //     placed everything below the open row against a total that was short by
  //     the whole detail. Now the block wrapper is measured, which is the thing
  //     the row actually occupies.
  //   - An effect keyed on [openSeq] runs once per opened row. If the row was
  //     not in the DOM at that moment it returned WITHOUT measuring and without
  //     observing, and nothing ever re-ran it. A ref callback cannot miss: React
  //     calls it on every mount and every unmount of that node.
  //
  // On unmount the last height is KEPT rather than zeroed. A row that is not
  // built still occupies its height in the arithmetic — that is what the two
  // spacers are for — and zeroing it here is precisely the too-small total that
  // makes the browser clamp `scrollTop` and throw the reader backwards.
  const openRo = useRef<ResizeObserver | null>(null);
  const measureOpen = useCallback((el: HTMLDivElement | null): void => {
    openRo.current?.disconnect();
    openRo.current = null;
    if (el === null) return;
    setOpenH(el.offsetHeight);
    // Observed as well as measured: an open row's detail can still grow after it
    // first paints — the llm bodies arrive from the sidecar a few ms later, and
    // source lines and tool-call bodies come on their own schedule.
    const ro = new ResizeObserver(() => setOpenH(el.offsetHeight));
    ro.observe(el);
    openRo.current = ro;
  }, []);
  useEffect(() => {
    if (openSeq === null) setOpenH(0);
  }, [openSeq]);
  useEffect(() => () => openRo.current?.disconnect(), []);

  // Both jumps move the window themselves, for the same reason centreOn does:
  // a smooth scroll's events are the compositor's to deliver, and the window
  // must not be the thing that waits on them. Setting the destination up front
  // simply builds the rows before the scroll arrives at them.
  const jumpToEnd = (): void => {
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      setMetrics((m) => ({ ...m, scrollTop: el.scrollHeight }));
    }
    pinnedRef.current = true;
    setFreshCount(0);
  };

  const jumpToStart = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setMetrics((m) => (m.scrollTop === 0 ? m : { ...m, scrollTop: 0 }));
    pinnedRef.current = false; // reading from the top — auto-follow stays off
  };

  const onToggle = useCallback((seq: number): void => {
    setOpenSeq((cur) => (cur === seq ? null : seq));
  }, []);

  // Space steps to the NEXT visible entry while one is open — the trace reads
  // like the Lab stepper then: open a frame, tap through the stream. The next
  // row is opened, focused and centred; Enter still toggles a focused row.
  const openAt = (index: number): void => {
    if (index < 0 || index >= visible.length) return;
    const target = visible[index];
    setOpenSeq(target.seq);
    // Focus and centring both wait for the commit (see the layout effect above).
    // They used to happen right here whenever the row was already built, which
    // aimed the scroll at the layout the step was in the act of replacing.
    focusPending.current = target.seq;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${target.seq}"]`);
    if (row !== null && row !== undefined) return;
    // Outside the window. Before card 117 this could not happen, and the
    // querySelector above WAS the whole implementation — leaving it that way
    // would have made the stepper silently stop at the edge of the built rows.
    // So the position is computed, and the row is built before anyone asks the
    // DOM for it.
    centreOn(index);
  };

  const openNextEntry = (): void => openAt(visible.findIndex((e) => e.seq === openSeq) + 1);
  const openPrevEntry = (): void => {
    const at = visible.findIndex((e) => e.seq === openSeq);
    if (at > 0) openAt(at - 1);
  };
  /** One row of the list, wherever it is built — inside the window or pinned
   *  beside it. Same call, same key, so the two are the same element to React. */
  const renderRow = (i: number): ReactNode => {
    const e = visible[i];
    const pairSeq = lensOn ? pairs.get(e.seq) : undefined;
    const pairTarget = pairSeq !== undefined ? bySeq.get(pairSeq) : undefined;
    const ownText = lensOn ? blockTexts.get(e.seq) : undefined;
    const fromSeq = lensOn ? reach.get(e.seq) : undefined;
    const fromText = fromSeq === undefined ? undefined : blockTexts.get(fromSeq);
    return (
      <TraceRow
        key={e.seq}
        entry={e}
        dt={i === 0 ? null : Math.max(0, e.ts - visible[i - 1].ts)}
        tl={tlFractions === null ? null : tlFractions[i]}
        proto={metaBySeq.get(e.seq)?.proto ?? "—"}
        host={metaBySeq.get(e.seq)?.host ?? "—"}
        showHost={cols.host}
        showModel={cols.model}
        hit={hitSeqs.has(e.seq) ? (e.seq === currentSeq ? "hit-cur" : "hit") : ""}
        open={openSeq === e.seq}
        lang={lang}
        lens={lensOn ? lensRole(e.type, ownText !== undefined && ownText !== "") : ""}
        pair={
          pairTarget !== undefined
            ? {
                seq: pairTarget.seq,
                label: `${pairTarget.type} · ${summarize(pairTarget, lang).slice(0, 60)}`,
              }
            : undefined
        }
        blockText={ownText}
        from={
          fromSeq !== undefined && fromText !== undefined && fromText !== ""
            ? { seq: fromSeq, lead: reasoningLead(fromText) }
            : undefined
        }
        notes={
          e.sourceLine !== undefined && anchors?.get(e.sourceLine) === e.seq
            ? noteIndex.get(e.sourceLine)
            : undefined
        }
        chain={openSeq === e.seq ? openChain : undefined}
        calls={openSeq === e.seq ? openCalls : undefined}
        details={openSeq === e.seq ? openDetails : undefined}
        source={openSeq === e.seq ? openSource : undefined}
        provenance={provenance}
        translated={props.translated ?? false}
        llmWireSessionId={props.llmWireSessionId ?? null}
        blockRef={openSeq === e.seq ? measureOpen : undefined}
        onJump={jumpTo}
        onToggle={onToggle}
      />
    );
  };

  /** A spacer standing in for rows nobody needs to build. */
  const pad = (key: string, height: number, mark: string): ReactNode =>
    height > 0 ? <div key={key} style={{ height }} aria-hidden="true" data-trace-pad={mark} /> : null;

  // The table's children, in document order, as ONE keyed array. The open row
  // is built even when the scroll position has left it behind (card 211), and
  // because every child carries a key, the row keeps its DOM node — and with it
  // its ResizeObserver — as it moves between the pinned slot and the window.
  const rowChildren: ReactNode[] = [];
  const pinnedAbove = slice.pinIndex >= 0 && slice.pinBefore;
  rowChildren.push(pad("pad-top", slice.padTop, "top"));
  if (pinnedAbove) {
    rowChildren.push(renderRow(slice.pinIndex));
    rowChildren.push(pad("pad-pin", slice.padPin, "pin"));
  }
  for (let i = slice.start; i < slice.end; i += 1) rowChildren.push(renderRow(i));
  if (slice.pinIndex >= 0 && !slice.pinBefore) {
    rowChildren.push(pad("pad-pin", slice.padPin, "pin"));
    rowChildren.push(renderRow(slice.pinIndex));
  }
  rowChildren.push(pad("pad-bottom", slice.padBottom, "bottom"));

  // Space or → step to the next frame, ← to the previous — the trace reads like
  // the Lab stepper: open a frame, tap through the stream both ways.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (openSeq === null) return;
    if (e.key === " " || e.key === "ArrowRight") {
      e.preventDefault();
      openNextEntry();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      openPrevEntry();
    }
  };

  return (
    <div className="trace-view">
      <div className="trace-toolbar">
        {/* Card 116: the live window is allowed to drop rows; it is not allowed
            to do it quietly. Rendered first in the toolbar so it is read before
            the rows it is about, and only when something really was dropped —
            a permanent "last 5000 of 5000" would teach the reader to skip the
            line on the one run where it matters.

            Built in the same shape as the search read-out below, which is the
            house convention for this: a compact "{x} of {y}", the count of what
            is NOT shown after a "·", and the full-sentence rule in the title.
            The numbers come from `entries` — the record — and never from
            `allEntries`, which carries response rows, voice rows and the
            synthetic system_context row that the run never streamed. */}
        {dropDisclosure !== null && (
          <span
            className="trace-dropped tabular"
            role="status"
            title={t(lang, "trace.droppedScope", {
              shown: String(dropDisclosure.shown),
              first: String(dropDisclosure.firstSeq),
            })}
          >
            {t(lang, "trace.dropped", {
              shown: String(dropDisclosure.shown),
              total: String(dropDisclosure.total),
            })}
            {` ${t(lang, "trace.droppedOut", { n: String(dropDisclosure.dropped) })}`}
          </span>
        )}
        <input
          className="trace-filter"
          type="search"
          placeholder={t(lang, "trace.filterPh")}
          aria-label={t(lang, "trace.filterAria")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="trace-seg" role="group" aria-label={t(lang, "trace.dirAria")}>
          {(
            [
              ["all", "all", t(lang, "trace.dirAll")],
              ["to", "↑ LLM", t(lang, "trace.dirTo")],
              ["from", "↓ LLM", t(lang, "trace.dirFrom")],
              ["internal", "· intern", t(lang, "trace.dirInternal")],
            ] as const
          ).map(([d, label, title]) => (
            <button
              key={d}
              type="button"
              aria-pressed={llmDir === d}
              title={title}
              onClick={() => setLlmDir(d)}
            >
              {label}
            </button>
          ))}
        </div>
        {/* The master face (owner 2026-07-27: "einen hauptschalter oben was man
            als standard haben will"). It carries a label because it sits next to
            the unlabelled direction filter and reads the same otherwise. */}
        <div className="trace-seg" role="group" aria-label={t(lang, "trace.faceAria")}>
          <span className="trace-seg-label mono" title={t(lang, "trace.faceHint")}>
            {t(lang, "trace.face")}
          </span>
          {TRACE_FACES.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={face === f}
              title={t(lang, `trace.faceTitle.${f}`)}
              onClick={() => setTraceFace(f)}
            >
              {t(lang, `trace.mode.${f}`)}
            </button>
          ))}
        </div>
        <div className="trace-chips" role="group" aria-label={t(lang, "trace.typesAria")}>
          {/* all / none: flip every type filter on or off at once. */}
          <button
            type="button"
            className="trace-chip trace-chip--action"
            title={t(lang, "trace.selectAll")}
            onClick={() => setTraceCategories(CATEGORIES)}
          >
            {t(lang, "trace.all")}
          </button>
          <button
            type="button"
            className="trace-chip trace-chip--action"
            title={t(lang, "trace.selectNone")}
            onClick={() => setTraceCategories([])}
          >
            {t(lang, "trace.none")}
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className="trace-chip"
              aria-pressed={active.has(c)}
              onClick={() => toggleCat(c)}
            >
              {t(lang, `trace.cat.${c}`)}
            </button>
          ))}
        </div>
        {agents.length > 1 && props.onAgentFilter !== undefined && (
          <div
            className="trace-chips trace-chips--agents"
            role="group"
            aria-label={t(lang, "trace.agentsAria")}
          >
            <button
              type="button"
              className="trace-chip"
              aria-pressed={agentFilter === null}
              onClick={() => props.onAgentFilter?.(null)}
            >
              {t(lang, "trace.allAgents")}
            </button>
            {agents.map((a) => (
              <button
                key={a}
                type="button"
                className="trace-chip"
                style={{ "--agent-color": agentAccent(a) } as CSSProperties}
                aria-pressed={agentFilter === a}
                onClick={() => props.onAgentFilter?.(agentFilter === a ? null : a)}
              >
                <span className="trace-chip-dot" aria-hidden="true" />
                {a}
              </button>
            ))}
          </div>
        )}
        {/* Reasoning lens (card 13): violet foregrounds the thinking, the rest
            steps back; tool calls and gate frames stay readable as anchors. */}
        <button
          type="button"
          className={`trace-lens mono${lensOn ? " trace-lens--on" : ""}`}
          aria-pressed={lensOn}
          title={t(lang, "trace.lensTitle")}
          onClick={() => {
            applyAndSaveDesign({ reasoningLens: !lensOn });
            if (!lensOn) beacon("lens");
          }}
        >
          {t(lang, "trace.lens")}
        </button>
        {/* Timeline lens (langfuse P1.3): the Δt column, made scannable. */}
        <button
          type="button"
          className={`trace-lens mono${tlOn ? " trace-lens--on" : ""}`}
          aria-pressed={tlOn}
          title={t(lang, "trace.timelineTitle")}
          onClick={() => {
            applyAndSaveDesign({ timelineLens: !tlOn });
            if (!tlOn) beacon("lens");
          }}
        >
          {t(lang, "trace.timeline")}
        </button>
        {/* OTel mirror rows (card 86): the exports going to the configured
            OTLP endpoint (Langfuse), one frame per batch — default off. */}
        <button
          type="button"
          className={`trace-lens mono${otelOn ? " trace-lens--on" : ""}`}
          aria-pressed={otelOn}
          title={t(lang, "trace.otelTitle")}
          onClick={() => applyAndSaveDesign({ otelRows: !otelOn })}
        >
          {t(lang, "trace.otel")}
        </button>
        {/* Card 137: the way out of the app and into the trace that the export
            actually created. A plain anchor is the only outbound idiom here,
            and it is also the whole desktop story: the shell turns a
            target=_blank click into shell.openExternal. */}
        {linkState === "link" && (
          <a
            className="trace-lens mono"
            href={props.langfuseUrl ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            title={t(lang, "trace.langfuseTitle")}
          >
            {t(lang, "trace.langfuse")}
          </a>
        )}
        {/* The session's own files on disk, beside the one link that already
            leaves the app for this session's stuff elsewhere. Same component the
            chat's tools row mounts. */}
        <SessionFolderButtons storePath={props.storePath ?? null} className="trace-folders" />
        {linkState === "failed" && (
          /* Static, not an anchor: there is nothing to open. Endpoint neutral,
             because a failing Jaeger export reads the same way. */
          <span className="trace-lens mono" title={props.otlpFailure ?? undefined}>
            {t(lang, "trace.otlpFailed")}
          </span>
        )}
        {/* Optional columns: the two widest ones are a reading choice, so they
            sit with the lenses rather than in a window of their own. */}
        <div className="trace-seg" role="group" aria-label={t(lang, "trace.colsAria")}>
          <span className="trace-seg-label mono">{t(lang, "trace.cols")}</span>
          <button
            type="button"
            aria-pressed={cols.host}
            title={t(lang, "trace.colsHostTitle")}
            onClick={() => setTraceColumn("host", !cols.host)}
          >
            host
          </button>
          <button
            type="button"
            aria-pressed={cols.model}
            title={t(lang, "trace.colsModelTitle")}
            onClick={() => setTraceColumn("model", !cols.model)}
          >
            {t(lang, "trace.modelCol")}
          </button>
        </div>
        <button
          type="button"
          className={`trace-lens mono${explainOpen ? " trace-lens--on" : ""}`}
          aria-pressed={explainOpen}
          title={t(lang, "explain.toggleTitle")}
          onClick={() => setExplainOpen((v) => !v)}
        >
          {t(lang, "explain.toggle")}
        </button>
        <span className="trace-count tabular">
          {t(lang, "trace.count", { v: visible.length, t: allEntries.length })}
        </span>
        {/* The search readout. It names the hidden matches out loud: search
            walks the rows on screen, so without this line a filtered-away hit
            would read as "not there". */}
        {searching && (
          <span className="trace-search-note tabular" title={t(lang, "trace.searchScope")} aria-live="polite">
            {hitCount === 0
              ? t(lang, "trace.searchNone")
              : t(lang, "trace.searchAt", { i: currentHit + 1, n: hitCount })}
            {hits.hidden > 0 && ` ${t(lang, "trace.searchHidden", { n: hits.hidden })}`}
          </span>
        )}
      </div>

      {lensOn && (
        <p className="trace-lens-note">
          {hasThinking ? t(lang, "trace.lensNote") : t(lang, "trace.lensNone")}
        </p>
      )}

      {allEntries.length > 1 && (
        <div className="trace-scrub">
          <span className="trace-scrub-label mono">{t(lang, "trace.scrub")}</span>
          <input
            type="range"
            min={allEntries[0].seq}
            max={allEntries[allEntries.length - 1].seq}
            value={capSeq ?? allEntries[allEntries.length - 1].seq}
            aria-label={t(lang, "trace.scrubAria")}
            onChange={(e) => {
              const v = Number(e.target.value);
              const parked = v >= allEntries[allEntries.length - 1].seq ? null : v;
              setCapSeq(parked);
              // Stepping back in time is the act; sliding to the live edge is not.
              if (parked !== null) beacon("replay");
            }}
          />
          <span className="trace-scrub-pos mono tabular">
            {capSeq === null
              ? t(lang, "trace.scrubLive")
              : t(lang, "trace.scrubAt", { n: capSeq, t: allEntries[allEntries.length - 1].seq })}
          </span>
          {capSeq !== null && (
            <button type="button" className="trace-chip" onClick={() => setCapSeq(null)}>
              {t(lang, "trace.scrubReset")}
            </button>
          )}
        </div>
      )}

      {/* With the timeline lens on, every row gets breathing room so the wait
          bars read as their own layer instead of touching the next row's text
          (owner: "5 Pixel mehr oben und unten"). */}
      <div className={`trace-body${tlOn ? " trace-body--tl" : ""}`} onKeyDown={onKeyDown}>
        <div
          className="trace-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-label={t(lang, "trace.logAria")}
        >
          {entries.length === 0 ? (
            <p className="trace-empty">
              {t(lang, props.liveTraceOff === true ? "trace.liveOff" : "trace.empty")}
            </p>
          ) : (
            <div className={traceTableClass(cols)}>
              <div className="trace-head" aria-hidden="true" ref={headRef}>
                <span>#</span>
                <span>time</span>
                <span className="trace-col--dt">Δt ms</span>
                <span title={t(lang, "trace.llmColTitle")}>llm</span>
                <span title={t(lang, "trace.protoTitle")}>proto</span>
                {cols.host && <span title={t(lang, "trace.hostTitle")}>host</span>}
                {cols.model && <span>{t(lang, "trace.modelCol")}</span>}
                <span>agent</span>
                <span>type</span>
                <span>summary</span>
              </div>
              {/* The children are ONE keyed array rather than three JSX slots,
                  because the open row moves between the pinned position and the
                  window as the reader scrolls. Keyed inside one array, React
                  reconciles it by seq and the same DOM node travels with it —
                  which is the whole point: an unmounted row is a row nobody is
                  measuring. Split across slots it would unmount and remount at
                  every crossing, and the ResizeObserver with it. */}
              {rowChildren}
              {visible.length === 0 && <p className="trace-empty">{t(lang, "trace.noMatch")}</p>}
            </div>
          )}
        </div>
        {freshCount > 0 && (
          <button type="button" className="trace-pill" onClick={jumpToEnd}>
            {t(lang, "trace.new", { n: freshCount })}
          </button>
        )}
        {explainOpen && (
          <ExplainPanel entries={allEntries} onJump={jumpTo} onClose={() => setExplainOpen(false)} />
        )}
        {/* Jump rail: straight to the first or the newest frame. */}
        <div className="trace-rail">
          <button
            type="button"
            className="trace-rail-btn"
            title={t(lang, "trace.toStart")}
            aria-label={t(lang, "trace.toStart")}
            onClick={jumpToStart}
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 3.5h8" />
              <path d="M4 11.5 8 7.5l4 4" />
            </svg>
          </button>
          <button
            type="button"
            className="trace-rail-btn"
            title={t(lang, "trace.toEnd")}
            aria-label={t(lang, "trace.toEnd")}
            onClick={jumpToEnd}
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 4.5 8 8.5l4-4" />
              <path d="M4 12.5h8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
