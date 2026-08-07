// The llm-wire sidecar, as this browser sees it.
//
// The server records every LLM exchange beside the session file
// (~/.spectro/llm-wire/<id>.llm.jsonl) and tells the UI about each finished one
// with a SOCKET-ONLY frame, type "llm_exchange": metadata only — who, where,
// how many bytes, how long. The bodies stay on disk and are served on request,
// one exchange at a time, which is card 179's lesson applied before the defect
// this time: a frame that carried the request body would print it in the row's
// summary, and the summary is also the row's search text.
//
// Three things live here, all pure except the two fetches at the bottom:
//   - the frame read into a typed meta record (the boundary reading, the same
//     idiom reducer.ts uses for provider_info and workspace_info),
//   - the one-line row summary, built from NOTHING but that record,
//   - the merge that folds a reopened session's index back into its trace.
//     The frames ride the socket and never the file, so a reopened session's
//     fold has no llm rows; GET /api/sessions/{id}/llm-wire/index is where
//     they come back from, deduped by xid against whatever arrived live.

import type { TraceEntry } from "../state/reducer";
import { formatBytes } from "../workspace/preview";
import { formatDuration } from "../format";

/** One finished exchange, as the socket frame and the index row both spell it.
 *  Metadata only — the bodies live behind {@link fetchLlmExchange}. */
export interface LlmExchangeMeta {
  /** The exchange's own id: the detail endpoint's key, and what dedupes a
   *  merged index row against a live-received frame. */
  xid: string;
  agentId: string;
  turn: number;
  /** What the exchange was for: "chat", or "compaction" | "image" | "stt". */
  kind: string;
  provider: string;
  model: string;
  url: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  responseLines: number;
  aborted: boolean;
  /** How faithful the recording is: "bytes" | "sdk-json" | "sdk-events". */
  fidelity: string;
  durationMs: number;
  ts: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The frame (or index row) read into a meta record, tolerantly: every field
 * except the two the record cannot exist without is defaulted, so an older or
 * newer server degrades a cell rather than the row.
 *
 * @param value the frame's payload, or one row of the index
 * @return the record, or null for a value without an xid (nothing to fetch or
 *         dedupe by) or without a ts (no place in the trace)
 */
export function readExchange(value: unknown): LlmExchangeMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.xid !== "string" || v.xid === "" || typeof v.ts !== "number") return null;
  return {
    xid: v.xid,
    agentId: str(v.agentId),
    turn: num(v.turn),
    kind: str(v.kind) || "chat",
    provider: str(v.provider),
    model: str(v.model),
    url: str(v.url),
    status: num(v.status),
    requestBytes: num(v.requestBytes),
    responseBytes: num(v.responseBytes),
    responseLines: num(v.responseLines),
    aborted: v.aborted === true,
    fidelity: str(v.fidelity),
    durationMs: num(v.durationMs),
    ts: v.ts,
  };
}

/** The url's path, which is what a reader recognises ("/v1/messages"); the
 *  whole string when it does not parse, because half a guess would be a claim. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * The collapsed row's one line: path, provider, sizes, status, duration —
 * and the kind in front when it is not a plain chat turn. Built from the meta
 * record alone, so it structurally cannot leak a body into the search text.
 */
export function llmExchangeSummary(x: LlmExchangeMeta): string {
  const head = x.kind === "chat" ? "" : `${x.kind} · `;
  // status 0 is the normalized "never answered / not exposed" (the Anthropic
  // SDK exposes none on a natural finish) — print the empty-column glyph, not
  // a fabricated code.
  const outcome = x.aborted ? "aborted" : x.status ? String(x.status) : "—";
  return (
    `${head}${pathOf(x.url)} · ${x.provider} · ` +
    `${formatBytes(x.requestBytes)} → ${formatBytes(x.responseBytes)} · ` +
    `${outcome} · ${formatDuration(x.durationMs)}`
  );
}

/** The trace row a merged index entry becomes — the same shape the reducer
 *  gives a live-received frame, payload included, so summarize() and the
 *  detail read one shape wherever the row came from. */
function entryOf(x: LlmExchangeMeta): Omit<TraceEntry, "seq"> {
  return {
    dir: "in",
    ts: x.ts,
    type: "llm_exchange",
    ...(x.agentId !== "" ? { agentId: x.agentId } : {}),
    ...(x.model !== "" ? { model: x.model } : {}),
    payload: { type: "llm_exchange", ...x },
  };
}

/**
 * Fold a fetched index into a trace: each exchange lands at its ts (after
 * every row that is not later than it), deduped by xid against the rows
 * already there AND inside the index itself, and the rows are renumbered so
 * seq stays what it always was — dense and unique.
 *
 * Runs once, at open time, before anyone holds a seq — which is why the
 * renumbering is safe here and would not be against a live trace.
 *
 * @return the same array when nothing new arrived, so a caller can keep state
 *         identity (and React its referential calm)
 */
export function mergeLlmExchanges(trace: TraceEntry[], exchanges: readonly LlmExchangeMeta[]): TraceEntry[] {
  // Keyed by xid AND side: one exchange is more than one row now, and a key of
  // xid alone would fold the group back into one on every archive reopen.
  const seen = new Set<string>();
  for (const row of trace) {
    if (row.type !== "llm_exchange") continue;
    const xid = (row.payload as { xid?: unknown } | null)?.xid;
    if (typeof xid === "string") seen.add(xid);
  }
  const fresh: LlmExchangeMeta[] = [];
  for (const x of exchanges) {
    if (seen.has(x.xid)) continue;
    seen.add(x.xid);
    fresh.push(x);
  }
  if (fresh.length === 0) return trace;
  const out: Omit<TraceEntry, "seq">[] = [...trace];
  const place = (row: Omit<TraceEntry, "seq">): void => {
    let at = out.length;
    while (at > 0 && out[at - 1].ts > row.ts) at--;
    out.splice(at, 0, row);
  };
  for (const x of fresh) {
    // The request row an archive has to get back. Its moment is derivable and
    // exact: the recorder's durationMs IS close minus send, so ts - durationMs
    // is the instant the POST left — the one the live frame carries directly.
    if (x.durationMs > 0) {
      place({
        dir: "out",
        ts: x.ts - x.durationMs,
        type: "llm_request",
        ...(x.agentId !== "" ? { agentId: x.agentId } : {}),
        ...(x.model !== "" ? { model: x.model } : {}),
        payload: {
          type: "llm_request",
          xid: x.xid,
          agentId: x.agentId,
          turn: x.turn,
          kind: x.kind,
          provider: x.provider,
          model: x.model,
          transport: "",
          method: "POST",
          url: x.url,
          requestBytes: x.requestBytes,
          fidelity: x.fidelity,
          ts: x.ts - x.durationMs,
        },
      });
    }
    place(entryOf(x));
  }
  return out.map((row, i) => ({ ...row, seq: i + 1 }));
}

/** The `llm_request` frame: what is known the moment a call LEAVES. Deliberately
 *  without status, duration or response size — at that instant those facts do
 *  not exist, and a zero standing in for them would be a claim (card 184). */
export interface LlmRequestMeta {
  xid: string;
  agentId: string;
  turn: number;
  kind: string;
  provider: string;
  model: string;
  transport: string;
  method: string;
  url: string;
  requestBytes: number;
  fidelity: string;
  ts: number;
}

export function readRequestFrame(value: unknown): LlmRequestMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.xid !== "string" || v.xid === "" || typeof v.ts !== "number") return null;
  return {
    xid: v.xid,
    agentId: str(v.agentId),
    turn: num(v.turn),
    kind: str(v.kind) || "chat",
    provider: str(v.provider),
    model: str(v.model),
    transport: str(v.transport),
    method: str(v.method) || "POST",
    url: str(v.url),
    requestBytes: num(v.requestBytes),
    fidelity: str(v.fidelity),
    ts: v.ts,
  };
}

/** The leaving call in one line: the verb, the path, the size that went out. */
export function llmRequestSummary(r: LlmRequestMeta): string {
  const head = r.kind === "chat" ? "" : `${r.kind} · `;
  return `${head}${r.method} ${pathOf(r.url)} · ${r.provider} · ${formatBytes(r.requestBytes)}`;
}

/** The closing call in one line: how it went, how much came back, how long. */
export function llmResponseSummary(x: LlmExchangeMeta): string {
  const outcome = x.aborted ? "aborted" : x.status ? String(x.status) : "—";
  const lines = x.responseLines > 0 ? ` · ${x.responseLines} lines` : "";
  return `${outcome}${lines} · ${formatBytes(x.responseBytes)} · ${formatDuration(x.durationMs)}`;
}

/**
 * The two display rows one closing exchange stands for: the response at the
 * instant it closed, and the summary that closes the group (owner 2026-08-07 —
 * "die will ich so sehen mit request und response und dann eine
 * Zusammenfassung"). Display-only, like TraceView's synthetic system_context
 * row: neither is in the reducer and neither is in any JSONL.
 *
 * @param rows the trace as the reducer built it
 * @return the same array when there is nothing to expand, so React keeps its
 *         referential calm
 */
export function withResponseRows(rows: TraceEntry[]): TraceEntry[] {
  if (!rows.some((r) => r.type === "llm_exchange")) return rows;
  const out: TraceEntry[] = [];
  for (const row of rows) {
    if (row.type === "llm_exchange") {
      out.push({ ...row, type: "llm_response" });
    }
    out.push(row);
  }
  return out.map((r, i) => ({ ...r, seq: i + 1 }));
}

/** The sentences the detail pane may claim about a recording, per recorded
 *  fidelity. A fidelity nobody wrote a sentence for maps to null and the pane
 *  prints the word itself — the bare word is honest, a borrowed sentence is not. */
const FIDELITY_KEYS: ReadonlySet<string> = new Set(["bytes", "sdk-json", "sdk-events", "encoded"]);

export function fidelityKey(fidelity: string): string | null {
  return FIDELITY_KEYS.has(fidelity) ? `trace.llm.fid.${fidelity}` : null;
}

/** One side of a fetched exchange, read tolerantly off the endpoint's answer.
 *
 *  The endpoint hands over the whole recorded line as it parsed it, so
 *  everything the recorder wrote is already here; what a reader gets is decided
 *  in THIS function. `headers` was the field the wire face was missing: without
 *  it the face could show a POST line and a body but not the request, and a
 *  request without its headers is not what went over the socket. The credential
 *  VALUES were redacted when the line was written, so what arrives here is
 *  already safe to paint. */
export interface LlmExchangeSide {
  fidelity: string;
  /** The request headers as recorded, credential values already redacted by
   *  the writer. Empty for the response side, which records none. */
  headers: Readonly<Record<string, string>>;
  /** How the request travelled ("https", …), as the recorder spelled it. */
  transport: string;
  /** The size the recorder measured, which still stands when the body itself
   *  was dropped at the ceiling. */
  bodyBytes: number;
  /** The single payload, verbatim — the request unless the recorder dropped
   *  it at its ceiling, the response when it was not streamed. */
  body: string | null;
  /** The streamed response's lines, verbatim, in wire order. */
  lines: readonly string[];
  /** "ceiling" when the recorder dropped the body at its size ceiling — the
   *  ledger row still carries the measured size. Empty when nothing was
   *  dropped, so the pane can tell a dropped body from a missing one. */
  omitted: string;
  method: string;
  url: string;
  status: number;
  error: string;
  aborted: boolean;
}

export interface LlmExchangeDetail {
  request: LlmExchangeSide;
  response: LlmExchangeSide;
}

/** The recorded headers, string values only — a foreign or half-written record
 *  loses the odd cell rather than the whole map. */
function readHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function readSide(value: unknown): LlmExchangeSide {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    fidelity: str(v.fidelity),
    headers: readHeaders(v.headers),
    transport: str(v.transport),
    bodyBytes: num(v.bodyBytes),
    body: typeof v.body === "string" ? v.body : null,
    lines: Array.isArray(v.lines) ? v.lines.filter((l): l is string => typeof l === "string") : [],
    omitted: str(v.omitted),
    method: str(v.method),
    url: str(v.url),
    status: num(v.status),
    error: str(v.error),
    aborted: v.aborted === true,
  };
}

/** {request, response} with body/lines verbatim, or null when the answer is
 *  not even that shape. Exported for the component's test seam. */
export function readExchangeDetail(value: unknown): LlmExchangeDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.request === undefined && v.response === undefined) return null;
  return { request: readSide(v.request), response: readSide(v.response) };
}

/**
 * The index of a session's recorded exchanges. An empty array for every way
 * of having none — no sidecar, an older server, a network miss — because the
 * caller's next move is the same in all three: merge nothing, offer no link.
 */
export async function fetchLlmWireIndex(sessionId: string): Promise<LlmExchangeMeta[]> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/llm-wire/index`);
    if (!res.ok) return [];
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.map(readExchange).filter((x): x is LlmExchangeMeta => x !== null);
  } catch {
    return [];
  }
}

/** One exchange's bodies, on the gesture that asks for them. Null is the one
 *  failure word; the pane says an honest sentence for it. */
export async function fetchLlmExchange(sessionId: string, xid: string): Promise<LlmExchangeDetail | null> {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/llm-wire/exchange/${encodeURIComponent(xid)}`,
    );
    if (!res.ok) return null;
    return readExchangeDetail((await res.json()) as unknown);
  } catch {
    return null;
  }
}
