// The Spectrum tab — the fleet on one screen. One horizontal lane per agent
// (the brand image: every agent is a spectral line), every event a discrete
// mark. The rail opens the whole agent in Trace; the band is a scrubber — hover
// an event for its type + a mini preview, click to open THAT event in Trace.
// Pure presentation: the folding lives in spectrumModel.ts, live and replay
// render through the same path.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { formatDuration, formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { ThinkingDisclosure } from "../components/ThinkingDisclosure";
import { buildSpectrum } from "./spectrumModel";
import type { Lane, TickKind } from "./spectrumModel";
import { SpectrumBand, TICK_COLOR } from "./SpectrumBand";

/** The legend mirrors the wire vocabulary — protocol terms, not translated. */
const LEGEND: TickKind[] = ["token", "reasoning", "tool", "gate", "subagent", "lifecycle"];

function LaneRow({ lane, running, events, t0, onOpen, onFocusEvent }: {
  lane: Lane;
  running: boolean;
  events: RunEvent[];
  t0: number;
  onOpen: (id: string) => void;
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const live = running && lane.state === "working";
  return (
    <div className="spectrum-lane">
      <button
        type="button"
        className="spectrum-rail"
        title={t(lang, "sp.openTrace", { id: lane.id })}
        onClick={() => onOpen(lane.id)}
      >
        <span className="spectrum-rail-head">
          <span className={`dot ${lane.state === "failed" ? "error" : lane.state === "working" ? "accent" : lane.state === "completed" ? "ok" : "faint"}${live ? " pulse" : ""}`} aria-hidden="true" />
          <span className="spectrum-id mono">{lane.id}</span>
          {lane.label !== null && <span className="spectrum-label mono">{lane.label}</span>}
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
      <SpectrumBand lane={lane} events={events} t0={t0} onFocusEvent={onFocusEvent} />
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
  const dropped = model.lanes.reduce((n, l) => n + l.dropped, 0);
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
          {model.lanes.map((lane) => (
            <div key={lane.id} className="spectrum-lane-group">
              <LaneRow
                lane={lane}
                running={running}
                events={props.events}
                t0={model.t0}
                onOpen={props.onOpenTrace}
                onFocusEvent={props.onFocusEvent}
              />
              {lane.thinking !== "" && (
                <ThinkingDisclosure
                  text={lane.thinking}
                  active={running && lane.state === "working"}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {dropped > 0 && (
        <p className="spectrum-note mono">{t(lang, "sp.dropped", { n: dropped })}</p>
      )}
    </div>
  );
}
