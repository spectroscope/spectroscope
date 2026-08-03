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
import { stepSeq } from "./bandScrub";
import { markX, seqAt, viewBoxX } from "./bandGeometry";
import { applyIntent, followMark, keyToIntent, wheelToIntent } from "./gestures";
import type { Window } from "./viewport";
import type { Lane, LaneTick, TickKind } from "./spectrumModel";

export const BAND_W = 1000;
const BAND_H = 32;
const BAND_PAD_X = 4;
/** The drawable span between the pads: the width every mapping measures against. */
const BAND_INNER = BAND_W - 2 * BAND_PAD_X;

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

function TickMark({ tick, win, highlighted }: { tick: LaneTick; win: Window; highlighted: boolean }) {
  const shape = TICK_SHAPE[tick.kind];
  const pending = tick.pending === true;
  const x = markX(tick.x, win, BAND_W, BAND_PAD_X) - shape.w / 2;
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
  win,
  minW,
  events,
  t0,
  onFocusEvent,
  onWidth,
  onWindow,
  tipBelow,
}: {
  lane: Lane;
  /** The slice of the axis on screen. Every band in the view is handed the same
   *  one, so the lanes stay comparable: two marks at the same height are two
   *  events at the same instant, at every zoom. */
  win: Window;
  /** The zoom floor for this stream, so a gesture cannot go past one second. */
  minW: number;
  /** Move the shared window. Absent when the whole stream already fits, which is
   *  most sessions: no viewport, no gestures, nothing to explain. */
  onWindow?: (next: Window) => void;
  /** The marks this band actually DRAWS: the lane's ticks already sliced to the
   *  window and the pixel budget. The band is dumb about how that was decided.
   *
   *  It does not hit-test these. Scrubbing, the keyboard walk and the trace
   *  hand-off all run over `lane.ticks`, so thinning the ink never costs a
   *  reader access to an event. See bandScrub.ts. */
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

  // The wheel handler reads these rather than closing over them, so the listener
  // is bound once. Re-binding a non-passive listener on every window change
  // would drop wheel events mid-gesture, which reads as the zoom stuttering.
  const latest = useRef({ win, minW, ticks: lane.ticks, onWindow });
  latest.current = { win, minW, ticks: lane.ticks, onWindow };

  // React's onWheel cannot promise a non-passive listener, and a passive one
  // cannot preventDefault, so ctrl+wheel would zoom the band AND the browser at
  // once. This has to be a manual registration.
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const now = latest.current;
      if (!now.onWindow) return;
      const rect = el.getBoundingClientRect();
      const px = viewBoxX(e.clientX - rect.left, rect.width, BAND_W);
      const dx = viewBoxX(e.deltaX, rect.width, BAND_W);
      if (px === null || dx === null) return;
      // A trackpad pinch arrives as a wheel with a synthetic ctrlKey; meta is
      // the same intent on a mouse. A plain vertical wheel is left alone so the
      // page can still scroll past twenty lanes.
      const intent = wheelToIntent(dx, e.deltaY, e.ctrlKey || e.metaKey, BAND_INNER);
      if (intent === null) return;
      e.preventDefault();
      now.onWindow(
        applyIntent(now.win, intent, {
          anchorPx: px - BAND_PAD_X,
          widthPx: BAND_INNER,
          minW: now.minW,
          ticks: now.ticks,
        }),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Hit-testing runs over lane.ticks, NOT over the marks that got drawn. The
  // slice is a decision about ink; making it a decision about reach would take a
  // busy lane's 826 events down to 39 openable ones with no way to get the rest
  // back. What is drawn got denser; what can be reached did not change.
  //
  // Bounded by the WINDOW though, which the arithmetic in bandGeometry does: a
  // pointer can only ask for something the band is showing it.
  const seqAtX = useCallback(
    (clientX: number): number | null => {
      const rect = bandRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const px = viewBoxX(clientX - rect.left, rect.width, BAND_W);
      if (px === null) return null;
      return seqAt(lane.ticks, px, BAND_W, BAND_PAD_X, win);
    },
    [lane.ticks, win],
  );

  const onMove = (e: MouseEvent<HTMLDivElement>) => setHoverSeq(seqAtX(e.clientX));
  const onLeave = () => setHoverSeq(null);

  // Read from the LANE, so the popup and the scrub line can sit on an event that
  // has no rect of its own. The line marks the true instant; the rect nearest it
  // is at most one pixel away and is the same colour.
  const tick = hoverSeq !== null ? (lane.ticks.find((k) => k.seq === hoverSeq) ?? null) : null;

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
    if (lane.ticks.length === 0) {
      return;
    }
    // The viewport keys first. keyToIntent hands back null for a BARE arrow, so
    // the scrub below keeps the keys it already owned; only shift+arrow pans.
    const intent = onWindow ? keyToIntent(e.key, e.shiftKey) : null;
    if (intent !== null && onWindow) {
      e.preventDefault();
      // No pointer means no deixis, so the reader's declared focus is the mark
      // they are hovering, and the middle of the window when there is none.
      const anchorPx =
        tick === null ? BAND_INNER / 2 : markX(tick.x, win, BAND_W, BAND_PAD_X) - BAND_PAD_X;
      onWindow(applyIntent(win, intent, { anchorPx, widthPx: BAND_INNER, minW, ticks: lane.ticks }));
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = stepSeq(lane.ticks, hoverSeq, e.key === "ArrowRight" ? 1 : -1);
      setHoverSeq(next);
      // The walk reaches every event, so a zoomed window has to follow it out
      // rather than let the scrub line leave the band.
      const landed = next === null ? null : (lane.ticks.find((k) => k.seq === next) ?? null);
      if (landed !== null && onWindow) onWindow(followMark(win, landed.x, minW));
    } else if (e.key === "Enter" && hoverSeq !== null) {
      e.preventDefault();
      open(hoverSeq);
    } else if (e.key === "Escape") {
      setHoverSeq(null);
    }
  };

  const event = tick ? events[tick.seq] : undefined;
  const preview = event ? eventPreview(event) : null;
  const ts =
    event && typeof (event as { ts?: unknown }).ts === "number" ? (event as { ts: number }).ts : null;
  const rel = ts !== null && ts >= t0 ? formatDuration(ts - t0) : null;
  // The mark's true center anchors both the scrub line and the popup; near the
  // band edges the popup flips its growth direction (left/right aligned instead
  // of centered) so a long preview never spills off the band. Through the same
  // mapping the marks are drawn with, so the line cannot drift off its own mark.
  const rawLeft = tick ? (markX(tick.x, win, BAND_W, BAND_PAD_X) / BAND_W) * 100 : 0;
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
        {marks.map((m) => (
          <TickMark key={`${m.seq}-${m.kind}`} tick={m} win={win} highlighted={m.seq === hoverSeq} />
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
