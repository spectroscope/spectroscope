// The fleet roster: one card per hub node, above the Spectrum lanes. The card
// carries the node's identity (id, role, capabilities), its liveness, and its
// epoch — a restart shows as a new epoch, never a silent merge. Presentation
// only; the fold lives in fleetModel.ts. AgentsTab is the visual template.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { FleetNode } from "./fleetModel";

/** Compact relative age of a wall-clock timestamp: "12s", "4m", "2h". */
function ago(lastSeen: number, now: number): string {
  const secs = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

export function FleetRoster(props: {
  roster: FleetNode[];
  epochBySender: Record<string, number>;
}) {
  const lang = useLang();
  const now = Date.now();
  return (
    <div className="fleet-roster" data-reveal>
      <div className="fleet-roster-head">
        <span className="fleet-roster-title mono">{t(lang, "fleet.title")}</span>
        <span className="fleet-roster-count mono tabular">
          {t(lang, "fleet.count", {
            n: props.roster.length,
            online: props.roster.filter((node) => node.connected).length,
          })}
        </span>
      </div>
      <ul className="fleet-nodes" role="list" aria-label={t(lang, "fleet.rosterAria")}>
        {props.roster.map((node) => {
          const epoch = props.epochBySender[node.id];
          return (
            <li key={node.id}>
              <div className={`fleet-node fleet-node--${node.connected ? "online" : "offline"}`}>
                <span className="fleet-node-head">
                  <span
                    className={`dot ${node.connected ? "ok pulse" : "faint"}`}
                    aria-hidden="true"
                  />
                  <span className="fleet-node-id mono">{node.id}</span>
                  <span className="fleet-node-role">{node.role}</span>
                  {epoch !== undefined && epoch > 0 && (
                    <span className="fleet-node-epoch mono" title={t(lang, "fleet.restarted")}>
                      {t(lang, "fleet.epoch", { n: epoch })}
                    </span>
                  )}
                  <span className={`fleet-node-state fleet-node-state--${node.connected ? "online" : "offline"}`}>
                    {t(lang, node.connected ? "fleet.online" : "fleet.offline")}
                  </span>
                </span>
                {node.capabilities.length > 0 && (
                  <span className="fleet-node-caps">
                    {node.capabilities.map((cap) => (
                      <span key={cap} className="fleet-cap mono">{cap}</span>
                    ))}
                  </span>
                )}
                <span className="fleet-node-meta mono tabular">
                  {t(lang, "fleet.lastSeen", { t: ago(node.lastSeen, now) })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
