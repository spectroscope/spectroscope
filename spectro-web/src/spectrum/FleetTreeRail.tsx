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
                  {/* Two lines, because one did not fit: at the rail's width an
                      id, a role and the counts on a single row cut the id down
                      to "w…" — measured against a live 10-node fleet, where
                      worker-1 and worker-6 became the same three characters.
                      The id is the thing you are looking for, so it gets the
                      line, and the role and counts share the one below. */}
                  <span className="fleet-rail-line">
                    <span
                      className={`dot ${STATE_DOT[node.state] ?? "faint"}${live ? " pulse" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="fleet-rail-id mono">{row.id}</span>
                    {/* The epoch is deliberately NOT printed. It is meant to
                        mark a restarted sender, but the node CLI stamps it with
                        epoch millis, so it is a 13-digit number that is non-zero
                        for every node on a first run — measured live against the
                        same fleet. It would bury the row to say nothing. The
                        canvas card and FleetRoster still print it under that
                        `epoch > 0` rule; correcting it needs its own card, not a
                        fix smuggled in here. */}
                    {node.pendingGate && (
                      <span className="fleet-rail-gate" title={t(lang, "fleet.gatePending")}>
                        {t(lang, "fleet.gateShort")}
                      </span>
                    )}
                  </span>
                  <span className="fleet-rail-line fleet-rail-line--sub">
                    {node.role !== "" && <span className="fleet-rail-role">{node.role}</span>}
                    <span className="fleet-rail-meta mono tabular">
                      {node.inTokens + node.outTokens > 0 && formatTokens(node.inTokens + node.outTokens)}
                      {node.firstTs !== null && node.lastTs !== null && node.lastTs > node.firstTs && (
                        <> · {formatDuration(node.lastTs - node.firstTs)}</>
                      )}
                    </span>
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
