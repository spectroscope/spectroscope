// The control room's LEFT column: the fleet's agents as a spawn tree, indented.
// langfuse's trace tree in fleet vocabulary — who started whom, and who is
// blocked. One click selects, and the same selection drives the canvas and the
// detail column; nothing here navigates away.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatDuration, formatTokens } from "../format";
import type { FleetTreeRow } from "./fleetTree";

const STATE_DOT: Record<string, string> = {
  failed: "error",
  working: "accent",
  completed: "ok",
  idle: "faint",
};

export function FleetTreeRail({
  rows,
  selected,
  onSelect,
}: {
  rows: FleetTreeRow[];
  selected: string | null;
  onSelect: (agentId: string) => void;
}) {
  const lang = useLang();
  return (
    <nav className="fleet-rail" aria-label={t(lang, "fleet.treeAria")}>
      <p className="fleet-rail-head mono">{t(lang, "fleet.tree")}</p>
      {rows.length === 0 ? (
        <p className="fleet-rail-empty">{t(lang, "fleet.tree.empty")}</p>
      ) : (
        <ul className="fleet-rail-list">
          {rows.map((row) => {
            const node = row.node;
            const live = node.state === "working" && node.connected;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={`fleet-rail-row${selected === row.id ? " fleet-rail-row--on" : ""}${
                    node.pendingGate ? " fleet-rail-row--gate" : ""
                  }`}
                  style={{ paddingLeft: `calc(var(--sp-2) + ${row.depth} * var(--sp-4))` }}
                  aria-current={selected === row.id}
                  onClick={() => onSelect(row.id)}
                >
                  <span
                    className={`dot ${STATE_DOT[node.state] ?? "faint"}${live ? " pulse" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="fleet-rail-id mono">{row.id}</span>
                  {node.role !== "" && <span className="fleet-rail-role">{node.role}</span>}
                  {node.epoch > 0 && <span className="fleet-rail-epoch mono">#{node.epoch}</span>}
                  {node.pendingGate && (
                    <span className="fleet-rail-gate" title={t(lang, "fleet.gatePending")}>
                      {t(lang, "fleet.gateShort")}
                    </span>
                  )}
                  <span className="fleet-rail-meta mono tabular">
                    {node.inTokens + node.outTokens > 0 && formatTokens(node.inTokens + node.outTokens)}
                    {node.firstTs !== null && node.lastTs !== null && node.lastTs > node.firstTs && (
                      <> · {formatDuration(node.lastTs - node.firstTs)}</>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
