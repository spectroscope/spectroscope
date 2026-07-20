// The explain panel (the why layer, docked into the trace): a deterministic
// run summary and one explanation per gate — why it asked, what was decided,
// where in the stream it happened. Everything shown is folded from recorded
// frames (explainModel.ts); the copy stays inside the honest boundary: run
// explanation, not model internals.

import { useMemo } from "react";
import type { TraceEntry } from "../state/reducer";
import { buildRunSummary, gateExplanations } from "./explainModel";
import { formatDuration, formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** Template key for "why did the gate ask", by the mode at ask time. */
function whyKey(mode: string | null): string {
  switch (mode) {
    case "ask":
      return "explain.why.ask";
    case "auto":
      return "explain.why.auto";
    case "readonly":
      return "explain.why.readonly";
    default:
      return "explain.why.unknown";
  }
}

export function ExplainPanel(props: {
  entries: TraceEntry[];
  onJump: (seq: number) => void;
  onClose: () => void;
}) {
  const lang = useLang();
  const summary = useMemo(() => buildRunSummary(props.entries), [props.entries]);
  const gates = useMemo(() => gateExplanations(props.entries), [props.entries]);

  return (
    <aside className="explain-panel" aria-label={t(lang, "explain.aria")}>
      <header className="explain-head">
        <span className="explain-kicker mono">{t(lang, "explain.kicker")}</span>
        <button type="button" className="icon-button" aria-label={t(lang, "common.close")} onClick={props.onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>

      {summary.prompt === null ? (
        <p className="explain-empty">{t(lang, "explain.empty")}</p>
      ) : (
        <>
          <section className="explain-section">
            <h3 className="explain-title">{t(lang, "explain.summary")}</h3>
            <p className="explain-prompt" title={summary.prompt}>{summary.prompt}</p>
            <dl className="explain-facts">
              <div><dt>{t(lang, "explain.duration")}</dt><dd className="mono tabular">{formatDuration(summary.durationMs)}</dd></div>
              <div><dt>{t(lang, "explain.agents")}</dt><dd className="mono">{summary.agents.join(" · ") || "—"}</dd></div>
              <div><dt>{t(lang, "explain.turns")}</dt><dd className="mono tabular">{summary.turns}</dd></div>
              <div>
                <dt>{t(lang, "explain.tools")}</dt>
                <dd className="mono tabular">
                  {summary.toolCalls}
                  {summary.toolErrors > 0 && ` · ${t(lang, "explain.toolErrors", { n: summary.toolErrors })}`}
                </dd>
              </div>
              <div>
                <dt>{t(lang, "explain.gates")}</dt>
                <dd className="mono tabular">
                  {t(lang, "explain.gatesLine", {
                    asked: summary.gatesAsked,
                    ok: summary.gatesAllowed,
                    no: summary.gatesDenied,
                  })}
                  {summary.gatesPending > 0 && ` · ${t(lang, "explain.gatesPending", { n: summary.gatesPending })}`}
                </dd>
              </div>
              <div>
                <dt>{t(lang, "explain.tokens")}</dt>
                <dd className="mono tabular">
                  {formatTokens(summary.inTokens)} in / {formatTokens(summary.outTokens)} out
                  {summary.cacheTokens > 0 && ` · cache ${formatTokens(summary.cacheTokens)}`}
                </dd>
              </div>
              {summary.errors > 0 && (
                <div><dt>{t(lang, "explain.errors")}</dt><dd className="mono tabular">{summary.errors}</dd></div>
              )}
              {summary.stopReason !== null && (
                <div><dt>{t(lang, "explain.stop")}</dt><dd className="mono">{summary.stopReason}</dd></div>
              )}
            </dl>
            {summary.toolsByName.length > 0 && (
              <p className="explain-toollist mono">
                {summary.toolsByName.map((tn) => `${tn.name} ×${tn.n}`).join(" · ")}
              </p>
            )}
          </section>

          <section className="explain-section">
            <h3 className="explain-title">{t(lang, "explain.whyGates")}</h3>
            {gates.length === 0 ? (
              <p className="explain-empty">{t(lang, "explain.noGates")}</p>
            ) : (
              <ul className="explain-gates">
                {gates.map((g) => (
                  <li key={`${g.callId}-${g.seq}`} className="explain-gate">
                    <button
                      type="button"
                      className="explain-gate-head mono"
                      title={t(lang, "explain.jump")}
                      onClick={() => props.onJump(g.seq)}
                    >
                      <span className={`gate-outcome gate-outcome--${g.outcome}`}>
                        {t(lang, `explain.outcome.${g.outcome}`)}
                      </span>
                      {g.name}
                      <span className="explain-gate-agent">{g.agentId}</span>
                    </button>
                    <p className="explain-gate-why">
                      {t(lang, whyKey(g.modeAtAsk), { name: g.name })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="explain-note">{t(lang, "explain.note")}</p>
        </>
      )}
    </aside>
  );
}
