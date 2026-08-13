// The options control at the head of the session list (card 214).
//
// One option today — density, normal or extended — and the panel is built to
// hold the ones that come later without being rebuilt: a section head, then one
// settings row per option, each a label on the left and its current value on the
// right. It ships with exactly one row rather than with empty ones: a control
// that offers a choice nobody can make is chrome pretending to be a switch, and
// the wider design this card was cut out of was sent back for precisely that.
//
// Popover mechanics — outside click, Escape, arrow keys, focus into the panel on
// open — mirror DisclosureMenu, which mirrors ComposerGear. No new dependency
// and no second idiom: this house already knows how a small panel behaves. The
// one difference is the direction: those two hang off the composer at the bottom
// of the window and open UPWARD, this one sits at the top of the rail and opens
// DOWNWARD, which is a stylesheet line rather than a prop.
//
// Since card 216 that direction has one exception, and it is measured rather
// than assumed: in a window too short to hold the panel below the trigger it
// flips up. See `sessOptsPlacement` for the band and the numbers.
//
// The values are real <button>s in a radiogroup rather than div rows, because
// the panel has to be operable from the keyboard and a button already answers
// Enter and Space without being taught. The arrow keys move AND choose, the way
// a radio group does everywhere else.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEventHandler } from "react";
import { DENSITIES, setDensity, useDensity, type Density } from "../state/density";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The gap the stylesheet leaves between the trigger and the panel, in px. Read
 *  here as well as drawn there, and the pair is pinned by a test: a decision
 *  made against a gap the panel is not drawn with is a decision about nothing. */
export const SESS_OPTS_GAP = 6;

/** Breathing room the panel keeps against the window edge, in px. */
const SESS_OPTS_EDGE = 8;

/** Which way the panel opens, from the room there actually is.
 *
 *  Down is the documented direction — card 214 chose it because this trigger
 *  sits at the TOP of the rail, unlike the two popovers that hang off the
 *  composer — and down is also the fallback when neither side fits, because a
 *  flip that puts the panel off the top edge only moves the problem.
 *
 *  Measured rather than written into a media query: the panel's top is a
 *  constant 310.7px down a pinned head, but that constant is a brand plus seven
 *  nav rows, and a height threshold in the stylesheet would go stale on the
 *  next row anyone adds — the same literal card 216 refused for `top:`. It has
 *  gone stale twice already without costing anything, which is the point: card
 *  201 added a nav row and card 217 took the options row away, and the decision
 *  below re-measured both times. */
export function sessOptsPlacement(m: {
  triggerTop: number;
  triggerBottom: number;
  panelHeight: number;
  viewportHeight: number;
}): "down" | "up" {
  const fitsBelow = m.triggerBottom + SESS_OPTS_GAP + m.panelHeight <= m.viewportHeight - SESS_OPTS_EDGE;
  if (fitsBelow) return "down";
  const fitsAbove = m.triggerTop - SESS_OPTS_GAP - m.panelHeight >= SESS_OPTS_EDGE;
  return fitsAbove ? "up" : "down";
}

export function SessionListOptions() {
  const lang = useLang();
  const density = useDensity();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const valueRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const at = DENSITIES.indexOf(density);

  // Where it opens is decided per opening, and again on resize while it is
  // open. Pinning the trigger fixed WHERE it is and left what it opens alone:
  // the panel hangs under a trigger whose bottom is a constant 304.7px down the
  // rail and needs a 419.8px window to land in one, while the trigger is
  // reachable from 304.7px. In the 115px band between those two a reader could
  // open a panel they could not touch — no scrolling brings it back, because it
  // is anchored inside the block that does not scroll. `useEffect` rather than
  // `useLayoutEffect`: this component is server-rendered by its own suite, and
  // a layout effect warns there. Nothing flashes for it — in every window that
  // has the room the answer is "down", which is where it already is.
  useEffect(() => {
    if (!open) {
      setPlacement("down");
      return;
    }
    const measure = (): void => {
      const pop = popRef.current;
      const trigger = triggerRef.current;
      if (pop === null || trigger === null) return;
      const t = trigger.getBoundingClientRect();
      setPlacement(
        sessOptsPlacement({
          triggerTop: t.top,
          triggerBottom: t.bottom,
          panelHeight: pop.getBoundingClientRect().height,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Focus lands on the current value when the panel opens: a menu button that
  // opens without moving focus strands keyboard users (DisclosureMenu's lesson,
  // written down there in the same words).
  useEffect(() => {
    if (!open) return;
    valueRefs.current[at < 0 ? 0 : at]?.focus();
  }, [open, at]);

  // Close on outside click / Escape. Escape hands focus back to the trigger, so
  // a keyboard reader is not dropped at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Move to a neighbouring value and take it — radio-group behaviour. */
  const step = (delta: number): void => {
    const next = DENSITIES[(at + delta + DENSITIES.length) % DENSITIES.length];
    if (next === undefined) return;
    setDensity(next);
    valueRefs.current[DENSITIES.indexOf(next)]?.focus();
  };

  const onValuesKeyDown: KeyboardEventHandler<HTMLSpanElement> = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    }
  };

  const title = t(lang, "sess.opts");

  return (
    <div className="wsg-anchor sess-opts" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className="sess-opts-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Two rails with a knob each — the settings affordance, no emoji. The
            knobs are punched out of the rail with the surface colour rather than
            drawn in a second hue: colour rides on lines in this house. */}
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 5.5h11M2.5 10.5h11" />
          <circle cx="6" cy="5.5" r="1.9" fill="var(--surface)" />
          <circle cx="10.5" cy="10.5" r="1.9" fill="var(--surface)" />
        </svg>
      </button>

      {open && (
        <div
          className={`wsg-pop sess-opts-pop${placement === "up" ? " sess-opts-pop--up" : ""}`}
          role="dialog"
          aria-label={title}
          ref={popRef}
        >
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{title}</span>
            </div>

            <div className="sess-opt-row">
              <span className="sess-opt-label" id="sess-opt-density">
                {t(lang, "dens.title")}
              </span>
              <span
                className="sess-opt-values"
                role="radiogroup"
                aria-labelledby="sess-opt-density"
                onKeyDown={onValuesKeyDown}
              >
                {DENSITIES.map((d: Density, i) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={density === d}
                    tabIndex={density === d ? 0 : -1}
                    ref={(el) => {
                      valueRefs.current[i] = el;
                    }}
                    className={`sess-opt-value${density === d ? " is-on" : ""}`}
                    title={t(lang, `dens.${d}.hint`)}
                    onClick={() => setDensity(d)}
                  >
                    {t(lang, `dens.${d}`)}
                  </button>
                ))}
              </span>
            </div>

            {/* What the chosen value means, spelled out. The words are the same
                ones each value carries as its hover text, so the panel says the
                same thing whichever way it is read. */}
            <p className="sess-opt-hint">{t(lang, `dens.${density}.hint`)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
