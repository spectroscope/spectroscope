// One card per callId — the workhorse of the chat. tool_call creates it,
// tool_result switches the status; collapsed by default, the whole header row
// is the toggle button. Status is always dot + text, never color alone.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ToolCard as ToolCardModel } from "../state/reducer";
import { agentAccent, compactJson, formatDuration, prettyJson } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** Visible input/output clip — the full payload stays in the JSON views. */
const IO_CLIP_CHARS = 4000;
/** Live duration count-up tick while a tool runs. */
const RUNNING_TICK_MS = 250;
/** How long the copy button shows its "copied" confirmation. */
const COPY_FEEDBACK_MS = 1400;

const cut = (s: string, max = IO_CLIP_CHARS): string =>
  s.length > max ? `${s.slice(0, max)}\n... (truncated)` : s;

export function ToolCard(props: { card: ToolCardModel; live: boolean; inThread?: boolean }) {
  const { card, live } = props;
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const denied = card.permission === "denied";
  const runningNow = live && card.status === "pending" && !denied;
  // Inside a chat thread the container already names the owner — no per-card badge.
  const subagent = card.agentId !== "main" && props.inThread !== true;

  // Live duration count-up while the tool executes (250 ms tick is enough).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!runningNow) return;
    const timer = window.setInterval(() => setNow(Date.now()), RUNNING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [runningNow]);

  const statusLabel = denied
    ? t(lang, "tool.denied")
    : card.status === "pending"
      ? runningNow
        ? t(lang, "tool.running")
        : t(lang, "tool.noResult")
      : card.status;

  const dotTone = denied
    ? "warn"
    : card.status === "pending"
      ? runningNow
        ? "accent pulse"
        : "faint"
      : card.status;

  const duration =
    card.durationMs !== undefined
      ? formatDuration(card.durationMs)
      : runningNow
        ? formatDuration(now - card.startedAt)
        : null;

  // The 2 px line on the left: error/denied status wins, otherwise the
  // subagent's pastel identifies the owner (decoration, never text color).
  const lineColor =
    card.status === "error"
      ? "var(--error)"
      : denied
        ? "var(--warn)"
        : subagent
          ? agentAccent(card.agentId)
          : "var(--border)";

  const copyOutput = (): void => {
    if (card.output === undefined) return;
    void navigator.clipboard.writeText(card.output).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  };

  return (
    <div className="tool-card" style={{ "--line-color": lineColor } as CSSProperties}>
      <button
        type="button"
        className="tool-card-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`dot ${dotTone}`} aria-hidden="true" />
        <span className="tool-name">{card.name}</span>
        {subagent && (
          <span
            className="agent-badge"
            style={{ "--agent-color": agentAccent(card.agentId) } as CSSProperties}
          >
            {card.agentId}
          </span>
        )}
        <span className="tool-preview">{compactJson(card.input)}</span>
        {/* The gate outcome, made visible: an allowed call is didactically
            different from a permission-free one — it went through the gate. */}
        {card.permission !== undefined && (
          <span className={`gate-chip gate-${card.permission}`}>
            {t(lang, `gate.${card.permission}`)}
          </span>
        )}
        <span className={`tool-status status-${denied ? "denied" : card.status}`}>
          {statusLabel}
        </span>
        {duration !== null && <span className="badge tabular">{duration}</span>}
        <svg
          className={`chevron${open ? " open" : ""}`}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      <div className={`tool-card-body${open ? " open" : ""}`}>
        <div className="tool-card-inner">
          <div className="io-label">Input</div>
          <pre className="io-block">{cut(prettyJson(card.input))}</pre>
          <div className="io-label">Output</div>
          {denied ? (
            <p className="denied-line">{t(lang, "tool.deniedByUser")}</p>
          ) : (
            <div className="output-wrap">
              <pre className={`io-block output${card.status === "error" ? " error" : ""}`}>
                {card.output === undefined ? "(no result yet)" : cut(card.output)}
              </pre>
              {card.output !== undefined && (
                <button type="button" className="copy" onClick={copyOutput}>
                  {copied ? t(lang, "common.copied") : t(lang, "common.copy")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
