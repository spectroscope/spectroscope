// The "Agenten" tab of the right-docked panel: the session-wide agent roster
// (UiState.agents) rendered Claude-Code background-tasks style. The main agent is
// entry 0; every spawned subagent is listed and PERSISTS across runs (only a New
// chat clears it). Selecting a row drives the System-Kontext tab.

import type { AgentInfo } from "../state/reducer";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** Compact token count: 1234 -> "1.2k". */
function tokenLabel(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

export function AgentsTab({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const lang = useLang();
  if (agents.length === 0) {
    return <p className="agents-empty">{t(lang, "agents.empty")}</p>;
  }

  return (
    <ul className="agents-list" role="listbox" aria-label={t(lang, "rp.agents")}>
      {agents.map((a) => {
        const isMain = a.parentId === null;
        const selected = a.id === selectedId;
        return (
          <li key={a.id}>
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className={`agent-card agent-card--${a.state}${selected ? " agent-card--selected" : ""}`}
              onClick={() => onSelect(a.id)}
            >
              <span className="agent-card-head">
                <span className={`agent-dot agent-dot--${a.state}`} aria-hidden="true" />
                <span className="agent-card-name mono">
                  {a.label !== null ? `${a.label} · ` : ""}{a.id}
                </span>
                {isMain && <span className="agent-role-tag">{t(lang, "agents.main")}</span>}
                <span className={`agent-badge agent-badge--${a.state}`}>{t(lang, `map.life.${a.state}`)}</span>
              </span>
              {a.task !== "" && <span className="agent-card-task">{a.task}</span>}
              {a.lastStatus !== null && (
                <span className="agent-card-status">» {a.lastStatus}</span>
              )}
              <span className="agent-card-meta mono tabular">
                {tokenLabel(a.inTokens)} in · {tokenLabel(a.outTokens)} out
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
