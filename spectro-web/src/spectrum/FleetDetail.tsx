// The control room's RIGHT column: everything known about ONE selected agent,
// off the canvas. langfuse's detail panel, driven by the same selection the
// tree rail and the canvas share.
//
// With nothing selected it shows the fleet itself: the per-role roll-up, and
// the start-a-node card that used to be the whole fleet landing page — an empty
// fleet must still tell you how to put something in it.

import { useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatDuration, formatTokens, clockTime } from "../format";
import type { RunEvent } from "../events";
import { TICK_COLOR } from "./SpectrumBand";
import { eventPreview } from "./eventPreview";
import type { Lane } from "./spectrumModel";
import { buildNodeCommand } from "./nodeCommand";
import type { FleetLedger, FleetLedgerRow } from "./fleetLedger";
import type { FleetNode } from "./fleetModel";

/** How many of an agent's most recent events the panel lists. The full wire is
 *  one click away in the trace; this is the peek, not a second trace view. */
const RECENT = 24;

function Num(props: { label: string; value: string; title?: string }) {
  return (
    <div className="fleet-detail-num" title={props.title}>
      <span className="fleet-detail-num-label">{props.label}</span>
      <span className="fleet-detail-num-value mono tabular">{props.value}</span>
    </div>
  );
}

/** Nothing selected: the fleet's own detail. */
function FleetOverview({
  ledger,
  contextId,
  hubPort,
  onSpawn,
}: {
  ledger: FleetLedger;
  contextId: string;
  hubPort: number | null;
  onSpawn?: () => void;
}) {
  const lang = useLang();
  const de = lang === "de";
  const [copied, setCopied] = useState(false);
  // A scenario fleet is a REPLAY: no hub stands behind it, so offering to put a
  // node "into" it would be a lie (the same guard the old fleet home carried).
  const isScenario = contextId.startsWith("scenario:");
  const cmd = buildNodeCommand(
    { prompt: "review the open PR", context: contextId, role: "worker", id: "", linger: false },
    hubPort,
    "ask",
  );
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(cmd)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="fleet-detail-body">
      <p className="fleet-detail-hint">
        {ledger.rows.length === 0 ? t(lang, "fleet.detail.empty") : t(lang, "fleet.detail.pick")}
      </p>

      {ledger.roles.length > 0 && (
        <section className="fleet-detail-section">
          <p className="fleet-detail-label mono">{t(lang, "fleet.detail.byRole")}</p>
          <table className="fleet-detail-table mono tabular">
            <thead>
              <tr>
                <th scope="col">{t(lang, "fleet.col.role")}</th>
                <th scope="col">n</th>
                <th scope="col">{t(lang, "fleet.col.tokens")}</th>
                <th scope="col">{t(lang, "fleet.col.tools")}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.roles.map((role) => (
                <tr key={role.role}>
                  <td>{role.role === "" ? "—" : role.role}</td>
                  <td>{role.agents}</td>
                  <td>{formatTokens(role.inTokens + role.outTokens)}</td>
                  <td>{role.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!isScenario && (
        <section className="fleet-detail-section">
          <p className="fleet-detail-label mono">{t(lang, "fleet.detail.startNode")}</p>
          <div className="fleet-detail-code">
            <code className="mono">{cmd}</code>
            <button type="button" className="fleet-detail-copy" onClick={copy}>
              {copied ? (de ? "kopiert" : "copied") : de ? "kopieren" : "copy"}
            </button>
          </div>
          {onSpawn && (
            <button type="button" className="fleet-detail-action" onClick={onSpawn}>
              + {t(lang, "fleet.detail.spawn")}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

export function FleetDetail({
  ledger,
  contextId,
  selected,
  roster,
  events,
  lane,
  t0,
  hubPort,
  onSpawn,
  onClose,
  onOpenTrace,
  onFocusEvent,
  onStop,
}: {
  ledger: FleetLedger;
  contextId: string;
  selected: string | null;
  roster: FleetNode[];
  /** The fleet's whole stream; the panel slices this agent's tail out of it. */
  events: RunEvent[];
  /** The selected agent's spectral lane — its ticks carry the canonical event
   *  colour keyed by `seq`, so the dots here and the marks on the canvas band
   *  can never disagree. Null for an agent buildSpectrum folded no lane for. */
  lane: Lane | null;
  /** The stream's first wall clock, for relative times. */
  t0: number;
  hubPort: number | null;
  onSpawn?: () => void;
  onClose: () => void;
  onOpenTrace: (agentId: string) => void;
  onFocusEvent: (agentId: string, event: RunEvent) => void;
  onStop?: (agentId: string) => void;
}) {
  const lang = useLang();
  const row: FleetLedgerRow | undefined =
    selected === null ? undefined : ledger.rows.find((r) => r.id === selected);

  if (selected === null || row === undefined) {
    return (
      <aside className="fleet-detail" aria-label={t(lang, "fleet.detailAria")}>
        <header className="fleet-detail-head">
          <span className="fleet-detail-title mono">{t(lang, "fleet.detail.fleetTitle")}</span>
        </header>
        <FleetOverview ledger={ledger} contextId={contextId} hubPort={hubPort} onSpawn={onSpawn} />
      </aside>
    );
  }

  const member = roster.find((n) => n.id === selected);
  // The agent's own tail. Events without an agentId belong to no lane and are
  // deliberately left out here — the trace shows them under any filter.
  const mine: { event: RunEvent; index: number }[] = [];
  events.forEach((event, index) => {
    const owner =
      event.type === "agent_message" ? event.from : "agentId" in event ? event.agentId : undefined;
    if (owner === selected) mine.push({ event, index });
  });
  const tail = mine.slice(-RECENT).reverse();
  // seq indexes into the same events array the lane was folded from.
  const kindBySeq = new Map((lane?.ticks ?? []).map((tick) => [tick.seq, tick.kind]));

  return (
    <aside className="fleet-detail" aria-label={t(lang, "fleet.detailAria")}>
      <header className="fleet-detail-head">
        <span className="fleet-detail-title mono">{row.id}</span>
        {row.role !== "" && <span className="fleet-detail-role">{row.role}</span>}
        <span className={`fleet-detail-state ${row.connected ? "is-online" : "is-offline"}`}>
          {t(lang, row.connected ? "fleet.online" : "fleet.offline")}
        </span>
        <button
          type="button"
          className="fleet-detail-close"
          onClick={onClose}
          aria-label={t(lang, "fleet.detail.close")}
          title={t(lang, "fleet.detail.close")}
        >
          ×
        </button>
      </header>

      <div className="fleet-detail-body">
        {row.trigger !== null && (
          /* Card 72's trigger: the one field that says WHY this node exists.
             The server has sent it on every roster frame since card 72; the
             browser dropped it until now. */
          <p className="fleet-detail-trigger mono">
            <span className="fleet-detail-label">{t(lang, "fleet.detail.trigger")}</span> {row.trigger}
          </p>
        )}

        <div className="fleet-detail-nums">
          <Num
            label={t(lang, "fleet.col.tokens")}
            value={`${formatTokens(row.inTokens)} / ${formatTokens(row.outTokens)}`}
            title={t(lang, "fleet.stat.tokens.title")}
          />
          {(row.cacheReadTokens > 0 || row.cacheCreationTokens > 0) && (
            <Num
              label={t(lang, "fleet.col.cache")}
              value={`${formatTokens(row.cacheReadTokens)} / ${formatTokens(row.cacheCreationTokens)}`}
              title={t(lang, "fleet.col.cache.title")}
            />
          )}
          <Num
            label={t(lang, "fleet.col.span")}
            value={row.spanMs > 0 ? formatDuration(row.spanMs) : "—"}
            title={t(lang, "fleet.col.span.title")}
          />
          <Num
            label={t(lang, "fleet.col.tools")}
            value={`${row.toolCalls}${row.toolMs > 0 ? ` · ${formatDuration(row.toolMs)}` : ""}`}
            title={t(lang, "fleet.stat.tools.title")}
          />
          <Num
            label={t(lang, "fleet.col.gates")}
            value={
              row.gates === 0
                ? "0"
                : `${row.gates}${row.gateWaitMs > 0 ? ` · ${formatDuration(row.gateWaitMs)}${row.gateWaitMeasured ? "" : "+"}` : ""}`
            }
            title={
              row.gateWaitMeasured
                ? t(lang, "fleet.stat.gates.title")
                : t(lang, "fleet.stat.gates.titleFloor")
            }
          />
          {(row.errors > 0 || row.toolErrors > 0) && (
            <Num
              label={t(lang, "fleet.stat.errors")}
              value={`${row.errors + row.toolErrors}`}
              title={t(lang, "fleet.stat.errors.title")}
            />
          )}
        </div>

        {member !== undefined && member.capabilities.length > 0 && (
          /* The roster is the only place a node's advertised tools appear. */
          <section className="fleet-detail-section">
            <p className="fleet-detail-label mono">{t(lang, "fleet.detail.capabilities")}</p>
            <ul className="fleet-detail-caps">
              {member.capabilities.map((cap) => (
                <li key={cap} className="fleet-cap mono">
                  {cap}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="fleet-detail-actions">
          <button type="button" className="fleet-detail-action" onClick={() => onOpenTrace(row.id)}>
            {t(lang, "fleet.detail.openTrace")}
          </button>
          {row.connected && onStop && (
            <button
              type="button"
              className="fleet-detail-action fleet-detail-action--stop"
              onClick={() => onStop(row.id)}
            >
              {t(lang, "fleet.detail.stop")}
            </button>
          )}
        </div>

        <section className="fleet-detail-section">
          <p className="fleet-detail-label mono">
            {t(lang, "fleet.detail.recent", { n: Math.min(RECENT, mine.length), total: mine.length })}
          </p>
          {tail.length === 0 ? (
            <p className="fleet-detail-hint">{t(lang, "fleet.detail.noEvents")}</p>
          ) : (
            <ul className="fleet-detail-events">
              {tail.map(({ event, index }) => {
                const preview = eventPreview(event);
                const kind = kindBySeq.get(index);
                const ts = typeof (event as { ts?: unknown }).ts === "number" ? event.ts : null;
                return (
                  <li key={index}>
                    <button
                      type="button"
                      className="fleet-detail-event"
                      onClick={() => onFocusEvent(row.id, event)}
                      title={t(lang, "fleet.detail.openEvent")}
                    >
                      <span
                        className="fleet-detail-event-dot"
                        style={{ background: kind === undefined ? "var(--border)" : TICK_COLOR[kind] }}
                        aria-hidden="true"
                      />
                      <span className="fleet-detail-event-type mono">{preview.type}</span>
                      {ts !== null && (
                        <span className="fleet-detail-event-time mono tabular">
                          {ts >= t0 ? formatDuration(ts - t0) : clockTime(ts)}
                        </span>
                      )}
                      {preview.detail !== "" && (
                        <span className="fleet-detail-event-text">{preview.detail}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
