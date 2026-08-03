// The time axis under the lanes.
//
// It reads in WALL CLOCK, not in run-relative offsets. Over a four day
// transcript "t+63.6 h" is close to useless where "Thu 09:14" is immediate. The
// relative offset has not gone anywhere: it is still on the band's tooltip,
// where "how far into the run" is the question actually being asked.
//
// Dumb wiring. The step ladder, the daylight-saving-safe alignment and the
// formatting are all pure and pinned in timeAxis.ts.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { axisLabel, axisTicks, axisX } from "./timeAxis";
import type { Window } from "./viewport";

const AXIS_W = 1000;
const AXIS_H = 18;
/** The band's own pad, so a label and the mark it belongs to share one origin. */
const AXIS_PAD_X = 4;

export function SpectrumAxis({
  win,
  t0,
  t1,
  cols,
}: {
  win: Window;
  t0: number;
  t1: number;
  /** The measured band width, which decides how many labels fit without collision. */
  cols: number;
}) {
  const lang = useLang();
  const ticks = axisTicks(win, t0, t1, cols);

  return (
    <div className="spectrum-axis" role="img" aria-label={t(lang, "sp.axisAria")}>
      {/* The graduations are svg so they stretch with the band and stay on their
          marks. The labels below are HTML: preserveAspectRatio="none" would
          stretch svg text horizontally with the viewBox. */}
      <svg viewBox={`0 0 ${AXIS_W} ${AXIS_H}`} preserveAspectRatio="none">
        {ticks.map((tick) => {
          const x = AXIS_PAD_X + axisX(tick, win, AXIS_W - 2 * AXIS_PAD_X);
          return <line key={tick.t} className="spectrum-axis-tick" x1={x} x2={x} y1={0} y2={5} />;
        })}
      </svg>
      {ticks.map((tick) => {
        const frac = (AXIS_PAD_X + axisX(tick, win, AXIS_W - 2 * AXIS_PAD_X)) / AXIS_W;
        // A label centred on the first or last graduation would hang off the
        // band. Near an edge it grows inward instead.
        const shift = frac < 0.06 ? "translateX(0)" : frac > 0.94 ? "translateX(-100%)" : "translateX(-50%)";
        return (
          <span
            key={tick.t}
            className="spectrum-axis-label mono tabular"
            style={{ left: `${frac * 100}%`, transform: shift }}
          >
            {axisLabel(tick.t, tick.step, lang)}
          </span>
        );
      })}
    </div>
  );
}
