// The Spectrum tab — the fleet on one screen. One horizontal lane per agent
// (the brand image: every agent is a spectral line), every event a discrete
// mark, task/status/result and gate states readable at a glance. Clicking a
// lane hands its agent to the Trace view. Pure presentation: the folding
// lives in spectrumModel.ts, live and replay render through the same path.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { formatDuration, formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildSpectrum } from "./spectrumModel";
import type { Lane, LaneTick, TickKind } from "./spectrumModel";

/** Lane band geometry (SVG user units; the band stretches to its box). */
const BAND_W = 1000;
const BAND_H = 32;
const BAND_PAD_X = 4;

/** Discrete mark shapes per kind: crisp vertical bars, brand widths 1–3. */
const TICK_SHAPE: Record<TickKind, { w: number; h: number }> = {
  token: { w: 1.3, h: 10 },
  reasoning: { w: 1.8, h: 16 },
  tool: { w: 2.4, h: 18 },
  gate: { w: 3, h: 24 },
  subagent: { w: 2.4, h: 14 },
  lifecycle: { w: 1.2, h: 26 },
  error: { w: 3, h: 26 },
};

const TICK_COLOR: Record<TickKind, string> = {
  token: "var(--ev-token)",
  reasoning: "var(--ev-reasoning)",
  tool: "var(--ev-tool)",
  gate: "var(--ev-gate)",
  subagent: "var(--ev-subagent)",
  lifecycle: "var(--ev-lifecycle)",
  error: "var(--error)",
};

/** The legend mirrors the wire vocabulary — protocol terms, not translated. */
const LEGEND: TickKind[] = ["token", "reasoning", "tool", "gate", "subagent", "lifecycle"];

function TickMark({ tick }: { tick: LaneTick }) {
  const shape = TICK_SHAPE[tick.kind];
  const pending = tick.pending === true;
  const x = BAND_PAD_X + tick.x * (BAND_W - 2 * BAND_PAD_X) - shape.w / 2;
  return (
    <rect
      className={pending ? "pulse" : undefined}
      x={x}
      y={(BAND_H - shape.h) / 2}
      width={shape.w}
      height={shape.h}
      rx={0.6}
      fill={pending ? "var(--ev-pending)" : TICK_COLOR[tick.kind]}
      opacity={tick.kind === "token" ? 0.75 : tick.kind === "lifecycle" ? 0.6 : 0.95}
    />
  );
}

function LaneRow({ lane, running, onOpen }: { lane: Lane; running: boolean; onOpen: (id: string) => void }) {
  const lang = useLang();
  const live = running && lane.state === "working";
  return (
    <button
      type="button"
      className="spectrum-lane"
      title={t(lang, "sp.openTrace", { id: lane.id })}
      onClick={() => onOpen(lane.id)}
    >
      <span className="spectrum-rail">
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
      </span>
      <span className="spectrum-band" aria-hidden="true">
        <svg viewBox={`0 0 ${BAND_W} ${BAND_H}`} preserveAspectRatio="none">
          <line x1="0" y1={BAND_H / 2} x2={BAND_W} y2={BAND_H / 2} className="spectrum-baseline" />
          {lane.ticks.map((tick) => (
            <TickMark key={`${tick.seq}-${tick.kind}`} tick={tick} />
          ))}
        </svg>
      </span>
    </button>
  );
}

export function SpectrumView(props: {
  events: RunEvent[];
  /** Live view only — replays are never "running". */
  running: boolean;
  onOpenTrace: (agentId: string) => void;
}) {
  const lang = useLang();
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
          {props.running && ` · ${t(lang, "sp.live")}`}
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
            <LaneRow key={lane.id} lane={lane} running={props.running} onOpen={props.onOpenTrace} />
          ))}
        </div>
      )}

      {dropped > 0 && (
        <p className="spectrum-note mono">{t(lang, "sp.dropped", { n: dropped })}</p>
      )}
    </div>
  );
}
