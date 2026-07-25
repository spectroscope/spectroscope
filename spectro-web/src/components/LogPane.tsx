// The doctor page's live server log (card 85): the rolling logback file,
// tailed through GET /api/logs — an initial tail, then cheap offset-delta
// polls while the "tail" toggle is on. WARN/ERROR lines tint; the pane
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

/** WARN/ERROR tint per line — matching the logback pattern's level column. */
function lineTone(line: string): "error" | "warn" | null {
  if (line.includes(" ERROR ")) return "error";
  if (line.includes(" WARN ")) return "warn";
  return null;
}

export function LogPane() {
  const lang = useLang();
  const [content, setContent] = useState("");
  const [tail, setTail] = useState(true);
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
  }, [content, tail]);

  const copyAll = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const lines = content === "" ? [] : content.split("\n");
  return (
    <div className="log-pane-section">
      <div className="log-pane-head">
        <span className="doctor-label">{t(lang, "doc.log")}</span>
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
        {content !== "" && (
          <button type="button" className="copy log-copy" onClick={copyAll}>
            {copied ? t(lang, "common.copied") : t(lang, "common.copy")}
          </button>
        )}
      </div>
      <div className="log-pane mono" ref={paneRef} onScroll={handleScroll} aria-live="off">
        {failed ? (
          <span className="log-line warn">{t(lang, "doc.unreachable")}</span>
        ) : lines.length === 0 ? (
          <span className="log-line faint">{t(lang, "doc.logEmpty")}</span>
        ) : (
          lines.map((line, i) => {
            const tone = lineTone(line);
            return (
              <span key={i} className={`log-line${tone !== null ? ` ${tone}` : ""}`}>
                {line}
                {"\n"}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}
