// The doctor page's live log (card 85): the rolling logback file, tailed
// through GET /api/logs — an initial tail, then cheap offset-delta polls while
// the "tail" toggle is on. Each line's leading timestamp + severity token
// render as their own tinted spans (WARN amber, ERROR red — the owner wants
// the level findable at a glance), and a fullscreen button opens the same pane
// as a raw-modal, the System-Kontext pattern. The pane follows the bottom edge
// with the same position-derived pinning as the chat scroll (scroll up to
// study, back to the bottom to re-engage).
//
// The pane shows BOTH halves of the product. The server file knows nothing
// about what happens in the tab — session import is pure client work and never
// calls the server — so the browser ring (state/browserLog) merges in by time,
// marked as its own origin. Its entries survive the server being down, which
// is the case they exist for; that is why the unreachable notice is now a row
// above the log instead of replacing it.
//
// Both timestamps are local wall clock of the same machine (the server runs on
// loopback), so ordering across the two is meaningful.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { useBrowserLog, type BrowserLogEntry } from "../state/browserLog";

const POLL_MS = 1200;
/** Client-side buffer cap — the file itself rolls at 5 MB, the pane needs less. */
const MAX_BUFFER_CHARS = 400_000;
/** This close to the bottom counts as "following". */
const FOLLOW_PIN_THRESHOLD_PX = 32;

/** The logback line head: "2026-07-25 17:18:24.528 LEVEL " — split for tinting. */
const LINE_HEAD = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) (TRACE|DEBUG|INFO|WARN|ERROR)(\s)/;

// The merge below is pure and pinned from state/browserLog.test.ts — the
// suite has no DOM, so the ordering rules are tested as data, not as pixels.

/** One stamped server line together with its continuation lines. */
export interface ServerBlock {
  at: number;
  lines: string[];
}

export type Row =
  | { kind: "server"; key: string; at: number; block: ServerBlock }
  | { kind: "browser"; key: string; at: number; entry: BrowserLogEntry };

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** Renders epoch ms in the logback column format, so the two origins align. */
function formatStamp(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${date} ${time}`;
}

/** logback stamps carry no offset — they are the local clock, and so is ours. */
function parseStamp(text: string): number {
  return Date.parse(text.replace(" ", "T"));
}

/**
 * Groups the tailed file into blocks so the merge can never slip a browser
 * entry between a stack trace and the line it belongs to.
 */
export function serverBlocks(content: string): ServerBlock[] {
  if (content === "") return [];
  const blocks: ServerBlock[] = [];
  for (const line of content.split("\n")) {
    const head = LINE_HEAD.exec(line);
    const previous = blocks[blocks.length - 1];
    if (head === null && previous !== undefined) {
      previous.lines.push(line);
      continue;
    }
    const at = head === null ? Number.NEGATIVE_INFINITY : parseStamp(head[1]);
    // A tail can start mid-file: whatever precedes the first stamp keeps the
    // file's own order at the top rather than being given an invented time.
    blocks.push({ at: Number.isNaN(at) ? (previous?.at ?? Number.NEGATIVE_INFINITY) : at, lines: [line] });
  }
  return blocks;
}

/** Stable merge of two already-ordered streams; a tie keeps the file contiguous. */
export function mergeRows(blocks: ServerBlock[], entries: readonly BrowserLogEntry[]): Row[] {
  const rows: Row[] = [];
  let s = 0;
  let b = 0;
  while (s < blocks.length || b < entries.length) {
    const takeServer = b >= entries.length || (s < blocks.length && blocks[s].at <= entries[b].at);
    if (takeServer) {
      rows.push({ kind: "server", key: `s${s}`, at: blocks[s].at, block: blocks[s] });
      s += 1;
    } else {
      rows.push({ kind: "browser", key: `b${entries[b].seq}`, at: entries[b].at, entry: entries[b] });
      b += 1;
    }
  }
  return rows;
}

/** Stack frames sit under their entry, indented like a logback continuation. */
const indentDetail = (detail: string): string =>
  detail
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");

const browserHead = (e: BrowserLogEntry): string =>
  `${formatStamp(e.at)} ${e.level.toUpperCase()} browser [${e.source}] ${e.message}${e.count > 1 ? ` ×${e.count}` : ""}`;

/** What the copy button hands over: the merged view exactly as it reads. */
export function rowText(row: Row): string {
  if (row.kind === "server") return row.block.lines.join("\n");
  const head = browserHead(row.entry);
  return row.entry.detail === undefined ? head : `${head}\n${indentDetail(row.entry.detail)}`;
}

function LogLine({ line }: { line: string }) {
  const head = LINE_HEAD.exec(line);
  if (head === null) {
    // Continuation lines (stack traces) — plain, no false tinting.
    return (
      <span className="log-line">
        {line}
        {"\n"}
      </span>
    );
  }
  const level = head[2];
  const tone = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info";
  return (
    <span className={`log-line log-line--${tone}`}>
      <span className="log-ts">{head[1]} </span>
      <span className={`log-level log-level--${tone}`}>{level}</span>
      {head[3]}
      {line.slice(head[0].length)}
      {"\n"}
    </span>
  );
}

function BrowserLine({ entry }: { entry: BrowserLogEntry }) {
  const tone = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info";
  return (
    <span className={`log-line log-line--browser log-line--${tone}`}>
      <span className="log-ts">{formatStamp(entry.at)} </span>
      <span className={`log-level log-level--${tone}`}>{entry.level.toUpperCase()}</span>{" "}
      <span className="log-origin">browser</span> <span className="log-source">[{entry.source}]</span>{" "}
      {entry.message}
      {entry.count > 1 && <span className="log-count"> ×{entry.count}</span>}
      {"\n"}
      {entry.detail !== undefined && (
        <span className="log-detail">
          {indentDetail(entry.detail)}
          {"\n"}
        </span>
      )}
    </span>
  );
}

export function LogPane() {
  const lang = useLang();
  const entries = useBrowserLog();
  const [content, setContent] = useState("");
  const [tail, setTail] = useState(true);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const offsetRef = useRef<number | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const pull = useCallback(async (): Promise<void> => {
    try {
      const q = offsetRef.current === null ? "" : `?offset=${offsetRef.current}`;
      const r = await fetch(`/api/logs${q}`);
      if (!r.ok) throw new Error(String(r.status));
      const body = (await r.json()) as { content: string; offset: number };
      offsetRef.current = body.offset;
      setFailed(false);
      if (body.content !== "") {
        setContent((prev) => {
          const next = prev + body.content;
          return next.length > MAX_BUFFER_CHARS ? next.slice(next.length - MAX_BUFFER_CHARS) : next;
        });
      }
    } catch {
      setFailed(true);
    }
  }, []);

  // One tail on mount; delta polls only while the toggle is on.
  useEffect(() => {
    void pull();
  }, [pull]);
  useEffect(() => {
    if (!tail) return;
    const timer = window.setInterval(() => void pull(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [tail, pull]);

  // Fullscreen closes on Escape — captured BEFORE the doctor page's own
  // window listener, so one press closes the modal, not the whole doctor.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFull(false);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [full]);

  // Position-derived pinning (the chat-scroll pattern): a programmatic jump
  // lands at the bottom and stays pinned; a reader scrolling up releases it.
  const handleScroll = (): void => {
    const el = paneRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PIN_THRESHOLD_PX;
  };
  useEffect(() => {
    const el = paneRef.current;
    if (el === null || !tail || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content, entries, tail, full]);

  const rows = mergeRows(serverBlocks(content), entries);

  const copyAll = (): void => {
    void navigator.clipboard.writeText(rows.map(rowText).join("\n")).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const pane = (
    <div
      className={`log-pane mono${full ? " log-pane--full" : ""}`}
      ref={paneRef}
      onScroll={handleScroll}
      aria-live="off"
    >
      {/* The file is unreachable, the ring is not — the notice sits above the
          browser entries instead of hiding them, which is the moment they are
          worth the most. */}
      {failed && (
        <span className="log-line log-line--warn">
          {t(lang, "doc.unreachable")}
          {"\n"}
        </span>
      )}
      {rows.length === 0 && !failed && (
        <span className="log-line log-line--faint">{t(lang, "doc.logEmpty")}</span>
      )}
      {rows.map((row) =>
        row.kind === "browser" ? (
          <BrowserLine key={row.key} entry={row.entry} />
        ) : (
          <Fragment key={row.key}>
            {row.block.lines.map((line, i) => (
              <LogLine key={i} line={line} />
            ))}
          </Fragment>
        ),
      )}
    </div>
  );

  const tailToggle = (
    <button
      type="button"
      className={`log-tail-toggle${tail ? " log-tail-toggle--on" : ""}`}
      role="switch"
      aria-checked={tail}
      onClick={() => setTail((v) => !v)}
    >
      <span className="mono">tail</span>
      <span className="thinking-toggle-track" aria-hidden="true">
        <span className="thinking-toggle-knob" />
      </span>
    </button>
  );

  return (
    <div className="log-pane-section">
      <div className="log-pane-head">
        <span className="doctor-label">{t(lang, "doc.logBoth")}</span>
        {tailToggle}
        <button
          type="button"
          className="icon-button log-expand"
          aria-label={t(lang, "doc.logFull")}
          title={t(lang, "doc.logFull")}
          onClick={() => setFull(true)}
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
            <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
          </svg>
        </button>
        {rows.length > 0 && (
          <button type="button" className="copy log-copy" onClick={copyAll}>
            {copied ? t(lang, "common.copied") : t(lang, "common.copy")}
          </button>
        )}
      </div>
      {full ? (
        <div
          className="raw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t(lang, "doc.logBoth")}
          onClick={() => setFull(false)}
        >
          <div className="raw-modal log-modal" onClick={(e) => e.stopPropagation()}>
            <div className="raw-modal-head">
              <span className="raw-modal-title">{t(lang, "doc.logBoth")}</span>
              {tailToggle}
              <button type="button" className="raw-modal-copy" onClick={copyAll}>
                {copied ? t(lang, "common.copied") : t(lang, "common.copy")}
              </button>
              <button
                type="button"
                className="icon-button raw-modal-close"
                aria-label={t(lang, "common.close")}
                onClick={() => setFull(false)}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
            {pane}
          </div>
        </div>
      ) : (
        pane
      )}
    </div>
  );
}
