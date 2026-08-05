// The overview strip: the WHOLE axis, always, under a zoomed view.
//
// At two hundred times in you are inside half a percent of the domain with no
// way to tell which of the day's episodes you are in. The strip is the primary
// orientation surface and the lanes are the detail.
//
// It is a viewport over a record, not an editing timeline, and it is drawn to
// say so. The window is an OUTLINE and the axis outside it is never dimmed:
// dimming means "this will be discarded", and nothing here discards anything.
// There are no trim handles, no razor, no draggable marks. Every one of those
// affordances would promise an operation this app does not have.
//
// Dumb wiring. The bins, the heights and the drag arithmetic are all pure and
// pinned in overview.ts, gestures.ts and viewport.ts.

import { useMemo, useRef, useState, type PointerEvent } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { stripGripAt, stripResize, stripWindowFromPointer, type StripGrip } from "./gestures";
import { useWheelZoom } from "./useWheelZoom";
import { barHeight, densityProfile } from "./overview";
import { TICK_COLOR } from "./SpectrumBand";
import type { LaneTick } from "./spectrumModel";
import type { Window } from "./viewport";

const STRIP_W = 1000;
/** How close a pointer has to be to an end to take hold of it. Six device
 *  pixels: the same order as a window-edge grab anywhere else, and small enough
 *  that the middle of a modest window is still a pan. */
const GRAB_PX = 6;
const STRIP_H = 30;

export function SpectrumStrip({
  ticks,
  win,
  minW,
  cols,
  onWindow,
}: {
  /** Every lane's marks together: the strip is the estate, not one agent. */
  ticks: LaneTick[];
  win: Window;
  minW: number;
  /** Column count, taken from the measured width so one bar is one device pixel. */
  cols: number;
  onWindow: (next: Window) => void;
}) {
  const lang = useLang();
  const ref = useRef<HTMLDivElement>(null);
  // Memoized on the marks alone. The profile is a picture of the whole and does
  // not change when the window moves, so dragging must not recompute it.
  const columns = useMemo(() => densityProfile(ticks, cols), [ticks, cols]);
  const peak = useMemo(() => columns.reduce((m, c) => (c.count > m ? c.count : m), 0), [columns]);

  const latest = useRef({ win, minW, onWindow });
  latest.current = { win, minW, onWindow };

  /** Which end this drag took hold of, for as long as it lasts. Held rather
   *  than recomputed per move: a fast drag outruns its own grab zone, and
   *  re-asking mid-gesture would drop the end and start panning instead. */
  const held = useRef<StripGrip>("body");
  /** What the pointer WOULD grab, so the cursor can say so before the press. */
  const [hover, setHover] = useState<StripGrip>("body");

  const drag = (e: PointerEvent<HTMLDivElement>, grip: StripGrip) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const now = latest.current;
    const px = e.clientX - rect.left;
    now.onWindow(
      grip === "body"
        ? stripWindowFromPointer(now.win, px, rect.width, now.minW)
        : stripResize(now.win, grip, px, rect.width, now.minW),
    );
  };

  // Pointer capture, so a drag that leaves the strip keeps steering it instead
  // of stopping dead at the edge, which is where a reader is usually heading.
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    held.current = rect
      ? stripGripAt(latest.current.win, e.clientX - rect.left, rect.width, GRAB_PX)
      : "body";
    e.currentTarget.setPointerCapture(e.pointerId);
    drag(e, held.current);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      drag(e, held.current);
      return;
    }
    // Not dragging: just say what this spot does. The ends are invisible on
    // purpose — no knobs are drawn, because a knob would have to be wider than
    // the window it sits on once the window is a hairline — so the cursor is
    // the whole of the affordance and it has to be right.
    const rect = ref.current?.getBoundingClientRect();
    setHover(rect ? stripGripAt(latest.current.win, e.clientX - rect.left, rect.width, GRAB_PX) : "body");
  };

  // The wheel gesture, the SAME one the lanes have (owner, 2026-08-05: "das cmd
  // scrollrad geht auf dem agents hover aber nicht auf dem zoom interface
  // hover"). The old note here said a wheel would need step arithmetic inline
  // in this file, where nothing could test it — true then, and answered since:
  // the arithmetic is gestures.ts and the DOM half is useWheelZoom, so this
  // surface borrows both rather than growing a second gesture.
  //
  // The strip is 1:1 with the whole span, so the pointer's fraction across it
  // IS the anchor: no viewBox conversion, and the drawable width is the element.
  useWheelZoom(ref, {
    win,
    minW,
    ticks,
    onWindow,
    measure: (e, rect) =>
      rect.width <= 0
        ? null
        : {
            anchorPx: e.clientX - rect.left,
            widthPx: rect.width,
            innerWidthPx: rect.width,
          },
  });

  const winX = win.a * STRIP_W;
  const winW = (win.b - win.a) * STRIP_W;

  return (
    <div
      className={`spectrum-strip${hover === "body" ? "" : " spectrum-strip--grip"}`}
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerLeave={() => setHover("body")}
      role="img"
      aria-label={t(lang, "sp.stripAria")}
    >
      <svg viewBox={`0 0 ${STRIP_W} ${STRIP_H}`} preserveAspectRatio="none">
        {columns.map((c, i) =>
          c.count === 0 ? null : (
            <rect
              key={i}
              x={(i / columns.length) * STRIP_W}
              width={STRIP_W / columns.length}
              // A gate or an error is drawn full height as a marker track. It is
              // what a reader scans for, and one denied write inside a thousand
              // token deltas must not average into a bar.
              y={c.marker ? 0 : STRIP_H - barHeight(c.count, peak, STRIP_H)}
              height={c.marker ? STRIP_H : barHeight(c.count, peak, STRIP_H)}
              fill={c.kind === null ? "var(--border)" : TICK_COLOR[c.kind]}
              opacity={c.marker ? 0.9 : 0.7}
            />
          ),
        )}
        {/* The window: an outline, never a fill, and nothing outside it is
            dimmed. At the zoom floor this degenerates into a single hairline,
            which is the truth about how wide the window is. No minimum drawn
            width, because that would draw a box wider than the thing it stands
            for. */}
        <rect
          className="spectrum-strip-win"
          x={winX}
          width={winW}
          y={0.5}
          height={STRIP_H - 1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
