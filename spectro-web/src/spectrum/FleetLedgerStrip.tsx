// The control room's header: what the whole fleet spent, on one line. Nothing
// else in the app adds the nodes up — the canvas card prints one agent's
// tokens, the sidebar row prints a count, and the sum lived nowhere.
//
// It reports TOKENS and MILLISECONDS. Not cost: no price, rate or currency
// exists anywhere on the wire, and a dollar figure here would be invented.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatDuration, formatTokens } from "../format";
import type { FleetLedger } from "./fleetLedger";

/** One reading: a big number under a lowercase label. */
function Stat(props: { label: string; value: string; title?: string; tone?: "gate" | "error" }) {
  return (
    <div
      className={`fleet-stat${props.tone !== undefined ? ` fleet-stat--${props.tone}` : ""}`}
      title={props.title}
    >
      <span className="fleet-stat-value mono tabular">{props.value}</span>
      <span className="fleet-stat-label">{props.label}</span>
    </div>
  );
}

export function FleetLedgerStrip({ ledger, contextId }: { ledger: FleetLedger; contextId: string }) {
  const lang = useLang();
  const total = ledger.total;
  // Wall clock against summed agent time: > 1 means the fleet overlapped. Shown
  // only once there is a wall clock to divide by, so a single-act fleet says
  // nothing rather than "1.0x".
  const parallel = total.spanMs > 0 ? total.agentMs / total.spanMs : null;

  return (
    <header className="fleet-strip" aria-label={t(lang, "fleet.ledgerAria")}>
      <div className="fleet-strip-id">
        <span className="fleet-strip-eyebrow mono">{t(lang, "fleet.eyebrow")}</span>
        <h2 className="fleet-strip-name mono">{contextId}</h2>
        <p className="fleet-strip-sub mono tabular">
          {t(lang, "fleet.count", { n: total.agents, online: total.online })}
        </p>
      </div>

      <div className="fleet-strip-stats">
        <Stat
          label={t(lang, "fleet.stat.wall")}
          value={total.spanMs > 0 ? formatDuration(total.spanMs) : "—"}
          title={t(lang, "fleet.stat.wall.title")}
        />
        <Stat
          label={t(lang, "fleet.stat.agentTime")}
          value={
            total.agentMs > 0
              ? `${formatDuration(total.agentMs)}${parallel !== null ? ` · ${parallel.toFixed(1)}×` : ""}`
              : "—"
          }
          title={t(lang, "fleet.stat.agentTime.title")}
        />
        <Stat
          label={t(lang, "fleet.stat.tokens")}
          value={`${formatTokens(total.inTokens)} / ${formatTokens(total.outTokens)}`}
          title={t(lang, "fleet.stat.tokens.title")}
        />
        <Stat
          label={t(lang, "fleet.stat.tools")}
          value={`${total.toolCalls} · ${total.toolMs > 0 ? formatDuration(total.toolMs) : "0"}`}
          title={t(lang, "fleet.stat.tools.title")}
        />
        <Stat
          label={t(lang, "fleet.stat.gates")}
          value={`${total.gates}${total.gateWaitMs > 0 ? ` · ${formatDuration(total.gateWaitMs)}${total.gateWaitMeasured ? "" : "+"}` : ""}`}
          tone={total.gatesPending > 0 ? "gate" : undefined}
          title={
            total.gateWaitMeasured
              ? t(lang, "fleet.stat.gates.title")
              : t(lang, "fleet.stat.gates.titleFloor")
          }
        />
        {(total.errors > 0 || total.toolErrors > 0) && (
          <Stat
            label={t(lang, "fleet.stat.errors")}
            value={`${total.errors + total.toolErrors}`}
            tone="error"
            title={t(lang, "fleet.stat.errors.title")}
          />
        )}
      </div>

      {ledger.roles.length > 1 && (
        <ul className="fleet-roles" aria-label={t(lang, "fleet.rolesAria")}>
          {ledger.roles.map((role) => (
            <li key={role.role} className="fleet-role-chip mono tabular">
              <span className="fleet-role-name">{role.role === "" ? "—" : role.role}</span>
              <span className="fleet-role-n">×{role.agents}</span>
              <span className="fleet-role-tok">
                {formatTokens(role.inTokens + role.outTokens)} {t(lang, "fleet.role.tok")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
