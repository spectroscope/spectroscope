// The interactive spectral band: hover to scrub the NEAREST event to the cursor
// (ticks are 1-3px and dense, so a scrubber beats per-tick hit targets), a popup
// shows its type + a mini preview, and a click hands that exact event to the
// Trace. Keyboard: focus the band, arrow-scrub event to event, Enter opens.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { RunEvent } from "../events";
import { formatDuration } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { eventPreview } from "./eventPreview";
import type { Lane, LaneTick, TickKind } from "./spectrumModel";

export const BAND_W = 1000;
const BAND_H = 32;
const BAND_PAD_X = 4;

/** Discrete mark shapes per kind: crisp vertical bars, brand widths 1-3. */
const TICK_SHAPE: Record<TickKind, { w: number; h: number }> = {
  token: { w: 1.3, h: 10 },
  reasoning: { w: 1.8, h: 16 },
  tool: { w: 2.4, h: 18 },
  gate: { w: 3, h: 24 },
  subagent: { w: 2.4, h: 14 },
  lifecycle: { w: 1.2, h: 26 },
  error: { w: 3, h: 26 },
};

/** Exported so the legend renders the same event vocabulary + colors. */
export const TICK_COLOR: Record<TickKind, string> = {
  token: "var(--ev-token)",
  reasoning: "var(--ev-reasoning)",
  tool: "var(--ev-tool)",
  gate: "var(--ev-gate)",
  subagent: "var(--ev-subagent)",
  lifecycle: "var(--ev-lifecycle)",
  error: "var(--error)",
};

/** The index of the tick whose x-fraction is closest to `frac` (0..1), or null
 *  when there are none. Pure — the band's hit-test math, unit-tested apart from
 *  the DOM. Ties resolve to the earlier tick (strict `<`). */
export function nearestTick(ticks: readonly { x: number }[], frac: number): number | null {
  if (ticks.length === 0) {
    return null;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const dist = Math.abs(ticks[i].x - frac);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function TickMark({ tick, highlighted }: { tick: LaneTick; highlighted: boolean }) {
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
      opacity={highlighted ? 1 : tick.kind === "token" ? 0.75 : tick.kind === "lifecycle" ? 0.6 : 0.95}
    />
  );
}

export function SpectrumBand({
  lane,
  marks,
  events,
  t0,
  onFocusEvent,
  onWidth,
  tipBelow,
}: {
  lane: Lane;
  /** The marks this band actually draws: the lane's ticks already sliced to the
   *  window and the pixel budget. The band is dumb about how that was decided;
   *  it draws them, hit-tests them, and hands one to the trace. */
  marks: LaneTick[];
  /** Open the tick preview BELOW the band — the top row would clip it. */
  tipBelow?: boolean;
  /** The FULL event stream — a tick's `seq` indexes into it. */
  events: RunEvent[];
  /** Stream start (epoch ms) for the relative time on the popup. */
  t0: number;
  /** Open the trace focused on one event; absent = no drill-in wired. */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
  /** Report the band's real pixel width upward. Every lane is the same width
   *  (one grid), and the view slices with the SAME number it draws with, so the
   *  count under the lanes can never disagree with what is on screen. */
  onWidth?: (px: number) => void;
}) {
  const lang = useLang();
  const bandRef = useRef<HTMLDivElement>(null);
  // The scrubbed event's SEQ (= its index into `events`), or null when the
  // cursor is away. Keying on seq (not the mark's array index) survives a live
  // re-fold: which marks survive the slice shifts as the stream grows, so an
  // array index can point at a different event between renders. A seq cannot.
  const [hoverSeq, setHoverSeq] = useState<number | null>(null);

  useEffect(() => {
    const el = bandRef.current;
    if (!el || !onWidth) return;
    const measure = () => onWidth(el.clientWidth || BAND_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidth]);

  const nearest = useCallback(
    (clientX: number): number | null => {
      const rect = bandRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) {
        return null;
      }
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return nearestTick(marks, frac);
    },
    [marks],
  );

  const seqAt = (index: number | null): number | null => (index == null ? null : (marks[index]?.seq ?? null));
  const onMove = (e: MouseEvent<HTMLDivElement>) => setHoverSeq(seqAt(nearest(e.clientX)));
  const onLeave = () => setHoverSeq(null);

  const open = (seq: number | null) => {
    if (seq == null || !onFocusEvent) {
      return;
    }
    const event = events[seq]; // seq IS the event's index in the stream
    if (event) {
      onFocusEvent(lane.id, event);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (marks.length === 0) {
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      const curIdx = hoverSeq === null ? -1 : marks.findIndex((t) => t.seq === hoverSeq);
      const from = curIdx < 0 ? (step > 0 ? -1 : marks.length) : curIdx;
      const nextIdx = Math.min(marks.length - 1, Math.max(0, from + step));
      setHoverSeq(marks[nextIdx].seq);
    } else if (e.key === "Enter" && hoverSeq !== null) {
      e.preventDefault();
      open(hoverSeq);
    } else if (e.key === "Escape") {
      setHoverSeq(null);
    }
  };

  const tick = hoverSeq !== null ? (marks.find((t) => t.seq === hoverSeq) ?? null) : null;
  const event = tick ? events[tick.seq] : undefined;
  const preview = event ? eventPreview(event) : null;
  const ts =
    event && typeof (event as { ts?: unknown }).ts === "number" ? (event as { ts: number }).ts : null;
  const rel = ts !== null && ts >= t0 ? formatDuration(ts - t0) : null;
  // The mark's true center anchors both the scrub line and the popup; near the
  // band edges the popup flips its growth direction (left/right aligned instead
  // of centered) so a long preview never spills off the band.
  const rawLeft = tick ? ((BAND_PAD_X + tick.x * (BAND_W - 2 * BAND_PAD_X)) / BAND_W) * 100 : 0;
  const anchorPos = `${rawLeft}%`;
  const tipTransform =
    rawLeft < 15 ? "translateX(0)" : rawLeft > 85 ? "translateX(-100%)" : "translateX(-50%)";

  return (
    <div
      className="spectrum-band"
      ref={bandRef}
      tabIndex={0}
      role="group"
      aria-label={t(lang, "sp.bandAria", { id: lane.id })}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onKeyDown={onKey}
      onClick={() => open(hoverSeq)}
    >
      <svg viewBox={`0 0 ${BAND_W} ${BAND_H}`} preserveAspectRatio="none">
        <line x1="0" y1={BAND_H / 2} x2={BAND_W} y2={BAND_H / 2} className="spectrum-baseline" />
        {marks.map((t) => (
          <TickMark key={`${t.seq}-${t.kind}`} tick={t} highlighted={t.seq === hoverSeq} />
        ))}
      </svg>
      {tick && preview && (
        <>
          <span className="spectrum-scrub" style={{ left: anchorPos }} aria-hidden="true" />
          <div
            className={`spectrum-tip${tipBelow === true ? " spectrum-tip--below" : ""}`}
            style={{ left: anchorPos, transform: tipTransform }}
            role="tooltip"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="spectrum-tip-head">
              <span
                className="spectrum-tip-dot"
                style={{ background: TICK_COLOR[tick.kind] }}
                aria-hidden="true"
              />
              <span className="spectrum-tip-type mono">{preview.type}</span>
              {rel && <span className="spectrum-tip-time mono tabular">{rel}</span>}
            </div>
            {preview.detail !== "" && <p className="spectrum-tip-detail">{preview.detail}</p>}
            {onFocusEvent && <p className="spectrum-tip-foot mono">→ open in trace</p>}
          </div>
        </>
      )}
    </div>
  );
}
