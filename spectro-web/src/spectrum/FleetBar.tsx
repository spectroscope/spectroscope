// Variant B (0.7 A/B): while a fleet is entered, this bar REPLACES the app
// tab row — its own vocabulary: [bus] [one tab per agent] [+]. It wears the
// same .tab classes as the app nav, so the look does not fork.

import { useMemo } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildFleetGraph } from "./fleetGraph";
import type { FleetModel } from "./fleetModel";
import { busOrder } from "./FleetBus";

export function FleetBar({
  model,
  active,
  onPick,
  onSpawn,
}: {
  model: FleetModel;
  /** "bus" or an agent id. */
  active: string;
  onPick: (tab: string) => void;
  onSpawn?: () => void;
}) {
  const lang = useLang();
  const ordered = useMemo(() => busOrder(buildFleetGraph(model).nodes), [model]);
  return (
    <nav className="tab-nav fleet-bar" role="tablist" aria-label={t(lang, "bus.barAria")}>
      <button
        type="button"
        role="tab"
        aria-selected={active === "bus"}
        className={active === "bus" ? "tab tab--active" : "tab"}
        onClick={() => onPick("bus")}
      >
        <svg viewBox="0 0 14 8" width="14" height="8" aria-hidden="true" className="fleet-bar-glyph">
          <line x1="0" y1="4" x2="14" y2="4" />
          <circle cx="3.5" cy="4" r="1.6" />
          <circle cx="7" cy="4" r="1.6" />
          <circle cx="10.5" cy="4" r="1.6" />
        </svg>
        bus
      </button>
      {ordered.map((n) => {
        const dot =
          n.state === "failed"
            ? "error"
            : n.state === "working"
              ? "accent"
              : n.state === "completed"
                ? "ok"
                : "faint";
        return (
          <button
            key={n.id}
            type="button"
            role="tab"
            aria-selected={active === n.id}
            className={`${active === n.id ? "tab tab--active" : "tab"} mono fleet-bar-agent${n.pendingGate ? " gate" : ""}`}
            onClick={() => onPick(n.id)}
          >
            <span
              className={`dot ${dot}${n.state === "working" && n.connected ? " pulse" : ""}`}
              aria-hidden="true"
            />
            {n.id}
          </button>
        );
      })}
      {onSpawn && (
        <button type="button" className="tab mono fleet-bar-spawn" onClick={onSpawn}>
          +
        </button>
      )}
    </nav>
  );
}
