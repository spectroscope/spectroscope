// The fleet control room — the three columns FLEET-MANAGER.md §2 specified and
// nobody built: LEFT the agent tree, CENTRE the spectral canvas, RIGHT the
// detail panel, and ONE selection driving all three. Above them the ledger
// strip: what the whole fleet spent.
//
// It replaces the fleet's landing page, which was a getting-started card and
// nothing else, and it replaces the hunt: until now a fleet's numbers, its
// topology and one agent's wire lived on three different tabs, and the app
// forgot which agent you were looking at between them. The old landing card
// survives inside the detail column's no-selection state, because an empty
// fleet still has to tell you how to put something in it.
//
// The other tabs are untouched: spectrum, trace, text and lab still re-fold the
// entered fleet exactly as before. This is the surface you land on, not a
// replacement for the drill-downs it hands off to.

import { useEffect, useMemo, useState } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildSpectrum } from "./spectrumModel";
import { buildFleetLedger } from "./fleetLedger";
import { buildFleetTree } from "./fleetTree";
import type { FleetModel } from "./fleetModel";
import { FleetBus } from "./FleetBus";
import { FleetCanvas } from "./FleetCanvas";
import { FleetDetail } from "./FleetDetail";
import { FleetLedgerStrip } from "./FleetLedgerStrip";
import { FleetTreeRail } from "./FleetTreeRail";

/** Which reading the centre column shows. The bus is the default: a fleet is a
 *  bus with peers on it, and the graph answers the narrower question of who
 *  spawned whom. Persisted, because a reading is a habit, not a session. */
export type CentreView = "bus" | "graph";
const CENTRE_KEY = "spectroscope:fleet.centre";

function storedCentre(): CentreView {
  try {
    return localStorage.getItem(CENTRE_KEY) === "graph" ? "graph" : "bus";
  } catch {
    return "bus"; // blocked storage: the default is still the default
  }
}

export function FleetControlRoom({
  contextId,
  model,
  events,
  hubPort,
  onSpawn,
  onOpenTrace,
  onFocusEvent,
  onStop,
}: {
  contextId: string;
  model: FleetModel;
  /** The fleet's stream as the tabs see it (translated if the reader asked). */
  events: RunEvent[];
  hubPort: number | null;
  onSpawn?: () => void;
  /** Hand off to the trace tab with this agent pinned. */
  onOpenTrace: (agentId: string) => void;
  /** Hand off ONE event to the trace (the shared Spectrum seam). */
  onFocusEvent: (agentId: string, event: RunEvent) => void;
  onStop?: (agentId: string) => void;
}) {
  const lang = useLang();
  const [selected, setSelected] = useState<string | null>(null);
  const [centre, setCentre] = useState<CentreView>(storedCentre);
  const pickCentre = (next: CentreView): void => {
    setCentre(next);
    try {
      localStorage.setItem(CENTRE_KEY, next);
    } catch {
      /* blocked storage: the pick still holds for this session */
    }
  };

  const ledger = useMemo(() => buildFleetLedger(model), [model]);
  const tree = useMemo(() => buildFleetTree(model), [model]);
  const spectrum = useMemo(() => buildSpectrum(events), [events]);
  const lane = useMemo(
    () => (selected === null ? null : (spectrum.lanes.find((l) => l.id === selected) ?? null)),
    [spectrum, selected],
  );

  // A selection outlives one roster frame, not a fleet. Drop it when the agent
  // it names is no longer in the fold, so the detail column can never describe
  // an agent the other two columns stopped showing.
  useEffect(() => {
    if (selected !== null && !ledger.rows.some((r) => r.id === selected)) setSelected(null);
  }, [ledger, selected]);

  // Entering a different fleet is a different room: start with nothing picked.
  useEffect(() => {
    setSelected(null);
  }, [contextId]);

  const isScenario = contextId.startsWith("scenario:");

  return (
    <div className="fleet-room" data-reveal>
      <FleetLedgerStrip ledger={ledger} contextId={contextId} />
      <div className="fleet-room-cols">
        <FleetTreeRail rows={tree} selected={selected} onSelect={setSelected} />
        <div className="fleet-room-canvas">
          {ledger.rows.length === 0 ? (
            <div className="spectrum-empty">
              <p>{t(lang, "fleet.noNodes")}</p>
              <p className="spectrum-empty-sub">{t(lang, "fleet.noNodesHint")}</p>
            </div>
          ) : (
            <>
              {/* Two readings of the same fleet, and the reader picks. The bus
                  shows every agent whole, docked on one rail; the graph answers
                  ancestry. Same selection drives both and the two side columns. */}
              <div className="fleet-centre-pick" role="tablist" aria-label={t(lang, "fleet.centre.aria")}>
                {(["bus", "graph"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    role="tab"
                    aria-selected={centre === view}
                    className={centre === view ? "fleet-centre-tab on" : "fleet-centre-tab"}
                    title={t(lang, `fleet.centre.${view}.title`)}
                    onClick={() => pickCentre(view)}
                  >
                    {t(lang, `fleet.centre.${view}`)}
                  </button>
                ))}
              </div>
              {centre === "bus" ? (
                <FleetBus
                  model={model}
                  events={events}
                  selectedId={selected}
                  onSelect={setSelected}
                  contextId={isScenario ? undefined : contextId}
                  hubPort={hubPort}
                  onStop={onStop}
                />
              ) : (
                <FleetCanvas
                  model={model}
                  events={events}
                  /* In the control room a node click SELECTS: the detail column is
                     right there, so jumping to another tab would undo the point of
                     having three columns. The graph tab keeps its own hand-off. */
                  selectedId={selected}
                  onSelect={setSelected}
                  onFocusEvent={onFocusEvent}
                  /* A scripted scenario has no live hub — its node command would
                     connect to nothing, so the spawn panel stays off. */
                  contextId={isScenario ? undefined : contextId}
                  hubPort={hubPort}
                  onStop={onStop}
                />
              )}
            </>
          )}
        </div>
        <FleetDetail
          ledger={ledger}
          contextId={contextId}
          selected={selected}
          roster={model.roster}
          events={events}
          lane={lane}
          t0={spectrum.t0}
          hubPort={hubPort}
          onSpawn={onSpawn}
          onClose={() => setSelected(null)}
          onOpenTrace={onOpenTrace}
          onFocusEvent={onFocusEvent}
          onStop={onStop}
        />
      </div>
    </div>
  );
}
