// The trace tab — the wire view. Every frame that crossed the socket is one
// row: RunEvents inbound, ClientMessages outbound. What Wireshark is to
// packets, this is to the harness protocol. The rows come straight from the
// reducer state, so live and replay render through the same path (a replayed
// archive is all dir "in" by construction).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { RunEvent } from "../events";
import type { TraceEntry } from "../state/reducer";
import { agentAccent, compactJson, formatTokens } from "../format";
import { CopyButton } from "./CopyButton";
import { JsonTree } from "./JsonTree";
import { LLM_DIR_GLYPH, SummaryLine, TEXT_FIELD_EVENTS, llmDirection, wireHost, wireProtocol } from "./eventSummary";
import type { LlmDir } from "./eventSummary";
import { DETAIL_MODES, detailLines, detailText } from "./traceDetail";
import type { DetailMode } from "./traceDetail";
import { causalChain, reasoningPairs } from "./traceChain";
import { ExplainPanel } from "./ExplainPanel";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { applyAndSaveDesign, useDesignPrefs } from "../state/designPrefs";

/** agent_message summaries clip their text to this width (CLI parity). */
const AGENT_MESSAGE_PREVIEW_CHARS = 60;
/** This close to the bottom counts as "pinned" (auto-follow stays on). */
const SCROLL_PIN_THRESHOLD_PX = 80;

const CATEGORIES = [
  "run",
  "turn",
  "text",
  "thinking",
  "tool",
  "permission",
  "usage",
  "image",
  "context",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];

function categoryOf(type: string): Category {
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
    case "permission_request":
    case "permission_decision":
    case "permission_response":
      return "permission";
    case "usage":
      return "usage";
    case "image_generated":
    case "set_image_provider":
      return "image";
    case "context_info":
    case "system_context":
      return "context";
    default:
      // agent_spawn, compaction, error — and every future type.
      return "other";
  }
}

/** Event-type color (fixed brand vocabulary, tokens.css --ev-*). The bar in
 *  front of the type column is a mark — color lives only on marks. */
function categoryColor(c: Category): string {
  switch (c) {
    case "text":
      return "var(--ev-token)";
    case "thinking":
      return "var(--ev-reasoning)";
    case "tool":
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

/** Reasoning lens (card 13): the row's role while the lens is active. */
function lensRole(type: string): "hi" | "anchor" | "dim" {
  if (type === "thinking_delta") return "hi";
  if (type === "tool_call" || type.startsWith("permission_") || type === "error") return "anchor";
  return "dim";
}

/** Wall-clock with millisecond precision — the wire view's native unit. */
function clock(ts: number): string {
  const d = new Date(ts);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
}

/** One dense line per frame — type-specific where a summary beats raw JSON. */
function summarize(entry: TraceEntry, lang: Lang): string {
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
    default:
      return compactJson(entry.payload);
  }
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
  open: boolean;
  lang: Lang;
  /** Reasoning lens: "" while the lens is off, else the row's role class. */
  lens: "" | "hi" | "anchor" | "dim";
  /** Lens pairing: the action that followed this thinking block, if any. */
  pair?: { seq: number; label: string };
  /** The open row's causal chain (undefined while closed — keeps memo calm). */
  chain?: TraceEntry[];
  onJump?: (seq: number) => void;
  onToggle: (seq: number) => void;
}) {
  const { entry, dt, proto, host, open, lang, lens, pair } = props;
  // The DIR flag now reads as the LLM direction (derived from the type); the
  // socket direction moves into the tooltip.
  const ld = llmDirection(entry.type);
  const socket = entry.dir === "out" ? "client→server" : "server→client";
  const dirLabel: Record<LlmDir, string> = {
    to: t(lang, "trace.dirTo"), from: t(lang, "trace.dirFrom"), internal: t(lang, "trace.dirInternal"),
  };
  const dirTitle =
    entry.type === "system_context"
      ? t(lang, "trace.sysRowTitle")
      : entry.type === "session_resume"
        ? t(lang, "trace.resumeRowTitle")
        : `${dirLabel[ld]} · Socket: ${socket}`;
  return (
    <>
      <button
        type="button"
        className={`trace-row${entry.type === "system_context" || entry.type === "session_resume" ? " trace-row--sys" : ""}${lens === "" ? "" : ` trace-row--${lens}`}`}
        aria-expanded={open}
        data-seq={entry.seq}
        onClick={() => props.onToggle(entry.seq)}
      >
        <span className="trace-col trace-col--num tabular">{entry.seq}</span>
        <span className="trace-col tabular">{clock(entry.ts)}</span>
        <span className="trace-col trace-col--dt tabular">{dt === null ? "" : `+${dt}`}</span>
        <span
          className={`trace-col trace-col--llm trace-col--llm-${ld}`}
          title={dirTitle}
        >
          {LLM_DIR_GLYPH[ld]}
        </span>
        <span className="trace-col trace-col--proto" title={t(lang, "trace.protoTitle")}>
          {proto}
        </span>
        <span className="trace-col trace-col--host" title={t(lang, "trace.hostTitle")}>
          {host}
        </span>
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
          <SummaryLine text={summarize(entry, lang)} field={TEXT_FIELD_EVENTS.has(entry.type) ? "text" : undefined} />
        </span>
      </button>
      {pair !== undefined && (
        <button
          type="button"
          className="trace-pair"
          title={t(lang, "trace.pairJump")}
          onClick={() => props.onJump?.(pair.seq)}
        >
          <span aria-hidden="true">&#8627;</span> {t(lang, "trace.pairThen")} <span className="mono">{pair.label}</span>
        </button>
      )}
      {open && (
        <TraceDetail
          entry={entry}
          lang={lang}
          chain={props.chain ?? [entry]}
          onJump={(seq) => props.onJump?.(seq)}
        />
      )}
    </>
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
    case "permission_request":
      return "gate asked";
    case "permission_decision":
      return p["allowed"] === true ? "gate allowed" : "gate denied";
    case "agent_spawn":
      return `spawn ${e.agentId ?? ""}`;
    default:
      return e.type;
  }
}

/** The expanded frame, in one of three honest views: Insight (the collapsible
 *  tree), Compact (highlighted, ONE row per wire line, x-scroll instead of
 *  artificial wrapping) and Raw (plain text, newlines only between real
 *  lines). session_resume expands to the whole re-uploaded history: one JSONL
 *  line per event, exactly what rides back to the LLM. Above the views: the
 *  causal chain (spectro-explain feature 2), walked back to the prompt. */
function TraceDetail({ entry, lang, chain, onJump }: {
  entry: TraceEntry;
  lang: Lang;
  /** Precomputed in the parent (only the ONE open row carries a chain, so
   *  the memoized closed rows never see a changing prop). */
  chain: TraceEntry[];
  onJump: (seq: number) => void;
}) {
  const [mode, setMode] = useState<DetailMode>("insight");
  const lines = detailLines(entry.type, entry.payload);
  return (
    <div className="trace-detail">
      {chain.length > 1 && (
        <div className="trace-chain" role="group" aria-label={t(lang, "trace.chainAria")}>
          <span className="trace-chain-label mono">{t(lang, "trace.chain")}</span>
          {chain.map((link, i) => (
            <span key={link.seq} className="trace-chain-step">
              {i > 0 && <span className="trace-chain-arrow" aria-hidden="true">&#8594;</span>}
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
        {DETAIL_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {t(lang, `trace.mode.${m}`)}
          </button>
        ))}
      </div>
      <CopyButton text={() => detailText(mode, entry.type, entry.payload)} />
      {mode === "insight" ? (
        <JsonTree value={entry.payload} />
      ) : mode === "compact" ? (
        <div className="trace-detail-lines">
          {lines.map((ln, i) => (
            <div key={i} className="trace-detail-line">
              <SummaryLine text={ln} />
            </div>
          ))}
        </div>
      ) : (
        <pre className="trace-detail-raw">{lines.join("\n")}</pre>
      )}
    </div>
  );
}

export function TraceView(props: {
  entries: TraceEntry[];
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
}) {
  const { entries } = props;
  const agentFilter = props.agentFilter ?? null;
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [llmDir, setLlmDir] = useState<"all" | LlmDir>("all");
  const [active, setActive] = useState<ReadonlySet<Category>>(() => new Set(CATEGORIES));
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [freshCount, setFreshCount] = useState(0);
  // Reasoning lens (card 13): a persisted preference, not view state — it
  // survives reloads and applies to live and replay alike.
  const { prefs } = useDesignPrefs();
  const lensOn = prefs.reasoningLens;
  // Replay scrubber: cap the visible stream at one frame (null = the live
  // end). Scrubbing back reads the run exactly as far as it had happened.
  const [capSeq, setCapSeq] = useState<number | null>(null);
  // The explain panel (the why layer) docks right of the stream.
  const [explainOpen, setExplainOpen] = useState(false);
  // The system context is uploaded (as the "system" role) with every request but
  // is NOT a wire event, so it can't appear as a frame on its own. We fetch it
  // and prepend ONE synthetic ↑ row so the "what gets uploaded" side is visible.
  const [ctx, setCtx] = useState<
    { systemPrompt: string; tools: { name: string }[]; skills: { name: string }[]; mcpServers: string[] } | null
  >(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/context")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (alive && c) setCtx(c); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The trace OPENS at the top (the reader studies from the beginning);
  // auto-follow only engages once the user scrolls down to the live end.
  const pinnedRef = useRef(false);
  const prevLen = useRef(entries.length);

  const toggleCat = (c: Category): void => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  // Prepend the synthetic system_context frame once, at the top, when a run has
  // started and the context is loaded. It is display-only — never in the reducer,
  // never in the JSONL.
  const allEntries = useMemo<TraceEntry[]>(() => {
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
  }, [ctx, entries, lang]);

  // Agents seen in this stream, first-seen order — the chip row's catalog.
  const agents = useMemo(() => {
    const seen: string[] = [];
    for (const e of entries) {
      if (e.agentId !== undefined && !seen.includes(e.agentId)) seen.push(e.agentId);
    }
    return seen;
  }, [entries]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allEntries.filter((e) => {
      if (capSeq !== null && e.seq > capSeq) return false;
      if (agentFilter !== null && e.agentId !== undefined && e.agentId !== agentFilter) return false;
      if (llmDir !== "all" && llmDirection(e.type) !== llmDir) return false;
      if (!active.has(categoryOf(e.type))) return false;
      if (q === "") return true;
      return `${e.type} ${e.agentId ?? ""} ${compactJson(e.payload)}`.toLowerCase().includes(q);
    });
  }, [allEntries, query, llmDir, active, agentFilter, capSeq]);

  // Said-vs-did pairs for the lens: block-ending thinking frame -> the next
  // same-agent action. Computed on the FULL stream so pairs survive filters.
  const pairs = useMemo(() => (lensOn ? reasoningPairs(allEntries) : new Map<number, number>()), [lensOn, allEntries]);
  const bySeq = useMemo(() => new Map(allEntries.map((e) => [e.seq, e])), [allEntries]);
  const hasThinking = useMemo(
    () => allEntries.some((e) => e.type === "thinking_delta"),
    [allEntries],
  );

  // The open row's causal chain (spectro-explain feature 2) — computed here
  // so the memoized closed rows never receive a changing prop.
  const openChain = useMemo(() => {
    if (openSeq === null) return undefined;
    const target = bySeq.get(openSeq);
    return target === undefined ? undefined : causalChain(allEntries, target);
  }, [openSeq, bySeq, allEntries]);

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
      const imageProvider =
        typeof p["provider"] === "string" && e.type === "image_generated"
          ? (p["provider"] as string) : null;
      bySeq.set(e.seq, {
        proto: wireProtocol(e.type, provider, toolName),
        host: wireHost(e.type, provider, llmHost, toolName, url, imageProvider),
      });
    }
    return bySeq;
  }, [allEntries]);

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
  };

  const jumpToEnd = (): void => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    pinnedRef.current = true;
    setFreshCount(0);
  };

  const jumpToStart = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    pinnedRef.current = false; // reading from the top — auto-follow stays off
  };

  const onToggle = useCallback((seq: number): void => {
    setOpenSeq((cur) => (cur === seq ? null : seq));
  }, []);

  // Space steps to the NEXT visible entry while one is open — the trace reads
  // like the Lab stepper then: open a frame, tap through the stream. The next
  // row is opened, focused and centred; Enter still toggles a focused row.
  const openNextEntry = (): void => {
    const at = visible.findIndex((e) => e.seq === openSeq);
    if (at < 0 || at + 1 >= visible.length) return;
    const next = visible[at + 1];
    setOpenSeq(next.seq);
    // The row button exists BEFORE the re-render (only the detail expands),
    // so focus + centring can happen synchronously — no frame callback.
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${next.seq}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center" });
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== " " || openSeq === null) return;
    e.preventDefault(); // the row buttons would re-toggle on space otherwise
    openNextEntry();
  };

  return (
    <div className="trace-view">
      <div className="trace-toolbar">
        <input
          className="trace-filter"
          type="search"
          placeholder={t(lang, "trace.filterPh")}
          aria-label={t(lang, "trace.filterAria")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="trace-seg" role="group" aria-label={t(lang, "trace.dirAria")}>
          {([
            ["all", "all", t(lang, "trace.dirAll")],
            ["to", "↑ LLM", t(lang, "trace.dirTo")],
            ["from", "↓ LLM", t(lang, "trace.dirFrom")],
            ["internal", "· intern", t(lang, "trace.dirInternal")],
          ] as const).map(([d, label, title]) => (
            <button key={d} type="button" aria-pressed={llmDir === d} title={title} onClick={() => setLlmDir(d)}>
              {label}
            </button>
          ))}
        </div>
        <div className="trace-chips" role="group" aria-label={t(lang, "trace.typesAria")}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className="trace-chip"
              aria-pressed={active.has(c)}
              onClick={() => toggleCat(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {agents.length > 1 && props.onAgentFilter !== undefined && (
          <div className="trace-chips trace-chips--agents" role="group" aria-label={t(lang, "trace.agentsAria")}>
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
          onClick={() => applyAndSaveDesign({ reasoningLens: !lensOn })}
        >
          {t(lang, "trace.lens")}
        </button>
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
              setCapSeq(v >= allEntries[allEntries.length - 1].seq ? null : v);
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

      <div className="trace-body" onKeyDown={onKeyDown}>
        <div
          className="trace-scroll"
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-label={t(lang, "trace.logAria")}
        >
          {entries.length === 0 ? (
            <p className="trace-empty">{t(lang, "trace.empty")}</p>
          ) : (
            <div className="trace-table">
              <div className="trace-head" aria-hidden="true">
                <span>#</span>
                <span>time</span>
                <span className="trace-col--dt">Δt ms</span>
                <span title={t(lang, "trace.llmColTitle")}>llm</span>
                <span title={t(lang, "trace.protoTitle")}>proto</span>
                <span title={t(lang, "trace.hostTitle")}>host</span>
                <span>agent</span>
                <span>type</span>
                <span>summary</span>
              </div>
              {visible.map((e, i) => {
                const pairSeq = lensOn ? pairs.get(e.seq) : undefined;
                const pairTarget = pairSeq !== undefined ? bySeq.get(pairSeq) : undefined;
                return (
                  <TraceRow
                    key={e.seq}
                    entry={e}
                    dt={i === 0 ? null : Math.max(0, e.ts - visible[i - 1].ts)}
                    proto={metaBySeq.get(e.seq)?.proto ?? "—"}
                    host={metaBySeq.get(e.seq)?.host ?? "—"}
                    open={openSeq === e.seq}
                    lang={lang}
                    lens={lensOn ? lensRole(e.type) : ""}
                    pair={
                      pairTarget !== undefined
                        ? { seq: pairTarget.seq, label: `${pairTarget.type} · ${summarize(pairTarget, lang).slice(0, 60)}` }
                        : undefined
                    }
                    chain={openSeq === e.seq ? openChain : undefined}
                    onJump={jumpTo}
                    onToggle={onToggle}
                  />
                );
              })}
              {visible.length === 0 && (
                <p className="trace-empty">{t(lang, "trace.noMatch")}</p>
              )}
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
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 4.5 8 8.5l4-4" />
              <path d="M4 12.5h8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
