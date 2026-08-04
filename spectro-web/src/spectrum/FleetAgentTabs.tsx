// Variant A (0.7 A/B): the second tab row. The agent tab picks WHO, the app
// tabs above keep picking WHAT — "bus" is the whole-fleet reading.

import { useMemo } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildFleetGraph } from "./fleetGraph";
import type { FleetModel } from "./fleetModel";
import { busOrder } from "./FleetBus";

export function FleetAgentTabs({
  model,
  focused,
  onFocus,
  onSpawn,
}: {
  model: FleetModel;
  focused: string | null;
  onFocus: (id: string | null) => void;
  onSpawn?: () => void;
}) {
  const lang = useLang();
  const ordered = useMemo(() => busOrder(buildFleetGraph(model).nodes), [model]);
  return (
    <nav className="agent-tabrow" role="tablist" aria-label={t(lang, "bus.tabrowAria")}>
      <button
        type="button"
        role="tab"
        aria-selected={focused === null}
        className={`agent-tab agent-tab--bus${focused === null ? " on" : ""}`}
        onClick={() => onFocus(null)}
      >
        <svg viewBox="0 0 14 8" width="14" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="14" y2="4" className="agent-tab-rail" />
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
            aria-selected={focused === n.id}
            className={`agent-tab mono${focused === n.id ? " on" : ""}${n.pendingGate ? " gate" : ""}`}
            onClick={() => onFocus(n.id)}
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
        <button type="button" className="agent-tab agent-tab--spawn mono" onClick={onSpawn}>
          +
        </button>
      )}
    </nav>
  );
}
