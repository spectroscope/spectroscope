// The gate surface (phase-4 design transplant): pending permission requests
// as first-class UI instead of a blocking modal. The violet line is the brand
// mark for "waiting on you"; approve/deny act inline, the expanded view shows
// the full input and the recorded outcomes of earlier gates. The run stays
// paused server-side until a decision lands — the bar just refuses to shout.

import { useState } from "react";
import type { PendingPermission, ToolCard } from "../state/reducer";
import { compactJson, prettyJson } from "../format";
import { agentAccent } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { CSSProperties } from "react";

/** Recorded outcomes shown in the expanded history, newest first. */
const HISTORY_MAX = 6;

export function GateBar(props: {
  pending: PendingPermission[];
  /** The session's tool cards — decided gates carry their recorded outcome. */
  cards: Record<string, ToolCard>;
  workspaceConfigured: boolean;
  /** Whether to offer "remember this decision". Default true (a session gate);
   *  a FLEET gate passes false — a remote node has no allowlist we control, so
   *  remember would be an inert, misleading control (block 4). */
  allowRemember?: boolean;
  onDecide: (
    callId: string,
    allowed: boolean,
    opts?: { remember?: boolean; persist?: boolean },
  ) => void;
}) {
  const lang = useLang();
  const [expanded, setExpanded] = useState(false);
  const [remember, setRemember] = useState(false);
  const [persist, setPersist] = useState(false);

  const current = props.pending[0];
  if (current === undefined) return null;

  const decide = (allowed: boolean): void => {
    props.onDecide(
      current.callId,
      allowed,
      allowed ? { remember, persist: remember && persist } : undefined,
    );
    setRemember(false);
    setPersist(false);
  };

  const decided = Object.values(props.cards)
    .filter((c) => c.permission === "allowed" || c.permission === "denied")
    .slice(-HISTORY_MAX)
    .reverse();

  return (
    <section className="gate-bar" aria-label={t(lang, "gate.aria")}>
      <div className="gate-line pulse" aria-hidden="true" />
      <div className="gate-row">
        <span className="gate-kicker mono">{t(lang, "gate.kicker")}</span>
        <span
          className="agent-badge"
          style={{ "--agent-color": agentAccent(current.agentId) } as CSSProperties}
        >
          {current.agentId}
        </span>
        <span className="gate-tool mono">{current.name}</span>
        <span className="gate-input mono" title={compactJson(current.input)}>
          {compactJson(current.input)}
        </span>
        {props.pending.length > 1 && (
          <span className="gate-queue mono tabular">
            {t(lang, "gate.queue", { n: props.pending.length - 1 })}
          </span>
        )}
        {props.allowRemember !== false && (
          <label className="gate-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t(lang, "gate.remember")}
          </label>
        )}
        {props.allowRemember !== false && remember && props.workspaceConfigured && (
          <label className="gate-remember">
            <input
              type="checkbox"
              checked={persist}
              onChange={(e) => setPersist(e.target.checked)}
            />
            {t(lang, "gate.persist")}
          </label>
        )}
        <button type="button" className="gate-deny" onClick={() => decide(false)}>
          {t(lang, "gate.deny")}
        </button>
        <button type="button" className="gate-allow" onClick={() => decide(true)}>
          {t(lang, "gate.allow")}
        </button>
        <button
          type="button"
          className="gate-expand icon-button"
          aria-expanded={expanded}
          aria-label={t(lang, expanded ? "gate.collapse" : "gate.expandAria")}
          onClick={() => setExpanded((v) => !v)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {expanded ? <path d="M4 10l4-4 4 4" /> : <path d="M4 6l4 4 4-4" />}
          </svg>
        </button>
      </div>

      {expanded && (
        <div className="gate-detail">
          <pre className="gate-input-full mono">{prettyJson(current.input)}</pre>
          {decided.length > 0 && (
            <div className="gate-history">
              <span className="gate-history-label mono">{t(lang, "gate.recorded")}</span>
              {decided.map((c) => (
                <span key={c.callId} className="gate-history-row mono">
                  <span
                    className={`gate-outcome gate-outcome--${c.permission}`}
                  >
                    {t(lang, c.permission === "allowed" ? "gate.histAllowed" : "gate.histDenied")}
                  </span>
                  {c.name}
                  <span className="gate-history-agent">{c.agentId}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
