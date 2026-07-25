// The doctor page's live server log (card 85): the rolling logback file,
// tailed through GET /api/logs — an initial tail, then cheap offset-delta
// polls while the "tail" toggle is on. Each line's leading timestamp +
// severity token render as their own tinted spans (WARN amber, ERROR red —
// the owner wants the level findable at a glance), and a fullscreen button
// opens the same pane as a raw-modal, the System-Kontext pattern. The pane
// follows the bottom edge with the same position-derived pinning as the
// chat scroll (scroll up to study, back to the bottom to re-engage).

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

const POLL_MS = 1200;
/** Client-side buffer cap — the file itself rolls at 5 MB, the pane needs less. */
const MAX_BUFFER_CHARS = 400_000;
/** This close to the bottom counts as "following". */
const FOLLOW_PIN_THRESHOLD_PX = 32;

/** The logback line head: "2026-07-25 17:18:24.528 LEVEL " — split for tinting. */
const LINE_HEAD = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) (TRACE|DEBUG|INFO|WARN|ERROR)(\s)/;

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

export function LogPane() {
  const lang = useLang();
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
  }, [content, tail, full]);

  const copyAll = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const lines = content === "" ? [] : content.split("\n");
  const pane = (
    <div
      className={`log-pane mono${full ? " log-pane--full" : ""}`}
      ref={paneRef}
      onScroll={handleScroll}
      aria-live="off"
    >
      {failed ? (
        <span className="log-line log-line--warn">{t(lang, "doc.unreachable")}</span>
      ) : lines.length === 0 ? (
        <span className="log-line log-line--faint">{t(lang, "doc.logEmpty")}</span>
      ) : (
        lines.map((line, i) => <LogLine key={i} line={line} />)
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
        <span className="doctor-label">{t(lang, "doc.log")}</span>
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
        {content !== "" && (
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
          aria-label={t(lang, "doc.log")}
          onClick={() => setFull(false)}
        >
          <div className="raw-modal log-modal" onClick={(e) => e.stopPropagation()}>
            <div className="raw-modal-head">
              <span className="raw-modal-title">{t(lang, "doc.log")}</span>
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
