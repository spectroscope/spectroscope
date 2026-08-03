// The Spectrum tab — the fleet on one screen. One horizontal lane per agent
// (the brand image: every agent is a spectral line), every event a discrete
// mark. The rail opens the whole agent in Trace; the band is a scrubber — hover
// an event for its type + a mini preview, click to open THAT event in Trace.
// Pure presentation: the folding lives in spectrumModel.ts, live and replay
// render through the same path.

import { useMemo, useState } from "react";
import type { RunEvent } from "../events";
import { formatDuration, formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { ThinkingDisclosure } from "../components/ThinkingDisclosure";
import { buildSpectrum } from "./spectrumModel";
import type { Lane, LaneTick, TickKind } from "./spectrumModel";
import { BAND_W, SpectrumBand, TICK_COLOR } from "./SpectrumBand";
import { sliceLane } from "./laneSlice";
import { fit } from "./viewport";
import { useEffect } from "react";
import { beacon } from "../state/levelingBeacon";

/** The legend mirrors the wire vocabulary — protocol terms, not translated. */
const LEGEND: TickKind[] = ["token", "reasoning", "tool", "gate", "subagent", "lifecycle"];

/** This view reads a WINDOW over the time axis rather than assuming the whole.
 *  Today that window is always the whole; when zoom and pan arrive they move
 *  this one value and nothing below it has to learn a new shape. */
const FULL = fit();

/** How a lane names itself. The id is the addressable truth (Trace filters by
 *  it), but an imported Claude Code session hands us a 26-char toolu_* id next
 *  to a readable agent type in the label — so the label leads when there is one
 *  and the id steps back into the chip. No label, no chip: the id keeps the
 *  title and nothing is invented to fill the slot. */
export function laneNames(lane: { id: string; label: string | null }): {
  title: string;
  chip: string | null;
} {
  const label = lane.label === null ? "" : lane.label.trim();
  if (label === "" || label === lane.id) return { title: lane.id, chip: null };
  return { title: label, chip: lane.id };
}

function LaneRow({
  lane,
  marks,
  running,
  events,
  t0,
  onOpen,
  onFocusEvent,
  onWidth,
  tipBelow,
}: {
  lane: Lane;
  marks: LaneTick[];
  running: boolean;
  events: RunEvent[];
  t0: number;
  onOpen: (id: string) => void;
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
  onWidth?: (px: number) => void;
  /** The TOP row has no room above it — its tick preview opens downward
   *  instead of being clipped by the toolbar (owner 2026-07-26). */
  tipBelow?: boolean;
}) {
  const lang = useLang();
  const live = running && lane.state === "working";
  const names = laneNames(lane);
  return (
    <div className="spectrum-lane">
      <button
        type="button"
        className="spectrum-rail"
        title={t(lang, "sp.openTrace", { id: lane.id })}
        onClick={() => onOpen(lane.id)}
      >
        <span className="spectrum-rail-head">
          <span
            className={`dot ${lane.state === "failed" ? "error" : lane.state === "working" ? "accent" : lane.state === "completed" ? "ok" : "faint"}${live ? " pulse" : ""}`}
            aria-hidden="true"
          />
          <span className="spectrum-id mono">{names.title}</span>
          {names.chip !== null && (
            <span className="spectrum-label mono" title={names.chip}>
              {names.chip}
            </span>
          )}
          {lane.pendingGate && <span className="spectrum-gate mono pulse">{t(lang, "sp.gateOpen")}</span>}
        </span>
        <span className="spectrum-task" title={lane.task}>
          {lane.task === "" ? t(lang, "sp.noTask") : lane.task}
        </span>
        <span className="spectrum-meta mono tabular">
          {t(lang, `map.life.${lane.state}`)}
          {lane.inTokens + lane.outTokens > 0 &&
            ` · ${formatTokens(lane.inTokens)} in / ${formatTokens(lane.outTokens)} out`}
        </span>
      </button>
      <SpectrumBand
        lane={lane}
        marks={marks}
        events={events}
        t0={t0}
        onFocusEvent={onFocusEvent}
        onWidth={onWidth}
        tipBelow={tipBelow}
      />
    </div>
  );
}

export function SpectrumView(props: {
  events: RunEvent[];
  /** Live view only — replays are never "running". */
  running: boolean;
  onOpenTrace: (agentId: string) => void;
  /** Drill into ONE event from the band; absent = no per-event trace hand-off. */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  // Pure props.events fold. The event SOURCE (own session, replay, or an entered
  // fleet) is chosen upstream in App.tsx; Spectrum just renders whatever flat
  // stream it is handed — one lane per agent, live and replay through one path.
  const running = props.running;
  const model = useMemo(() => buildSpectrum(props.events), [props.events]);
  // What this view actually put on screen. The fan-out criterion cannot be settled
  // from the server's stream for a scenario, which never reaches it, so the face
  // reports its own lane count as the witness for what it rendered.
  useEffect(() => {
    if (model.lanes.length >= 2) beacon("spectrum", null, model.lanes.length);
  }, [model.lanes.length]);
  // One measured width for the whole tab. Every band sits in the same grid
  // column, so the first to report settles it, and the slice the view counts is
  // the slice the bands draw. Until a band has measured, BAND_W stands in.
  const [bandW, setBandW] = useState(BAND_W);
  const slices = useMemo(() => model.lanes.map((l) => sliceLane(l.ticks, FULL, bandW)), [model.lanes, bandW]);
  const hidden = slices.reduce((n, s) => n + s.hidden, 0);
  const span = model.t1 - model.t0;

  return (
    <div className="spectrum-view" data-reveal>
      <div className="spectrum-toolbar">
        <span className="spectrum-legend" role="list" aria-label={t(lang, "sp.legendAria")}>
          {LEGEND.map((k) => (
            <span key={k} role="listitem" className="spectrum-legend-item mono">
              <span className="spectrum-legend-mark" style={{ background: TICK_COLOR[k] }} />
              {k}
            </span>
          ))}
        </span>
        <span className="spectrum-count mono tabular">
          {t(lang, "sp.count", { n: model.totalEvents, lanes: model.lanes.length })}
          {span > 0 && ` · ${formatDuration(span)}`}
          {running && ` · ${t(lang, "sp.live")}`}
        </span>
      </div>

      {model.lanes.length === 0 ? (
        <div className="spectrum-empty">
          <p>{t(lang, "sp.empty")}</p>
          <p className="spectrum-empty-sub">{t(lang, "sp.emptyHint")}</p>
        </div>
      ) : (
        <div className="spectrum-lanes" role="list" aria-label={t(lang, "sp.lanesAria")}>
          {model.lanes.map((lane, laneIndex) => (
            <div key={lane.id} className="spectrum-lane-group">
              <LaneRow
                lane={lane}
                marks={slices[laneIndex].marks}
                running={running}
                events={props.events}
                t0={model.t0}
                onOpen={props.onOpenTrace}
                onFocusEvent={props.onFocusEvent}
                onWidth={laneIndex === 0 ? setBandW : undefined}
                tipBelow={laneIndex === 0}
              />
              {lane.thinking !== "" && (
                <ThinkingDisclosure text={lane.thinking} active={running && lane.state === "working"} />
              )}
            </div>
          ))}
        </div>
      )}

      {hidden > 0 && (
        <p className="spectrum-note mono">
          {t(lang, hidden === 1 ? "sp.hiddenMark" : "sp.hiddenMarks", { n: hidden })}
        </p>
      )}
    </div>
  );
}
