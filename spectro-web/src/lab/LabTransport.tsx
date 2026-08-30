// The Lab's replay transport (edu port): a floating "now" band that names the
// current station, the map, then a scrub bar below it — reset / prev / play /
// next / end plus a slider that walks the COARSE-step boundaries and a step
// counter. It replaces the old Step toolbar; grain and the free tempo slider
// sit behind a small "advanced" disclosure, since a live run rarely needs them.
// Keyboard: space or → steps, ← steps back, f toggles flow, r resets
// (documented in the ? keymap). The map is passed as children so the band sits
// above it and the transport below.
//
// Card 299: the bar answered "where am I" three ways and "where is the
// interesting part" not at all. Over several hundred coarse steps that is the
// only question a presenter has. So the bar now carries CHAPTER TICKS (one per
// thing the run did that is worth stopping at, each one a control that seeks
// there), a wall clock beside the step counter, a jump to the end, and five
// speed pills with a real multiplier vocabulary instead of a bare "0.8×/s"
// with nothing to compare it to. Every reading behind them is pure and lives
// in state/stepper.ts; this file only draws them.
//
// The ticks sit in a row of their OWN, under the range input, and are thinned
// to a floor. Drawn over the slider — the first build — the 61 ticks a plain
// 60-turn run produces formed one unbroken row of 11px hit boxes and the scrub
// bar could no longer be dragged at all.
//
// The thinning ranks by KIND before position (stepper.ts, MARK_RANK). Its
// first build compared percentages only, and on a 60-turn run carrying one
// error it kept thirty turn boundaries and dropped the error — the exact
// opposite of what the ticks are for.

import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  MARK_MIN_GAP_PCT,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  SPEED_FACTORS,
  chapterMarks,
  clockLabel,
  endSeekTarget,
  intervalForFactor,
  markPositions,
  reset,
  runClock,
  seek,
  setGrain,
  setMode,
  setSpeed,
  speedFactorOf,
  step,
  stepBack,
  stepBoundaries,
  thinMarks,
  useStepper,
} from "../state/stepper";
import { agentDirectory } from "./agentDirectory";
import { markTag, momentLabel } from "./chapterLabel";
import { sceneNow } from "./sceneNow";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The tempo slider snaps in steps of this many milliseconds. */
const TEMPO_SLIDER_STEP_MS = 20;

/** True while the user is typing (the chat composer, the trace filter), so the
 *  transport keys never eat their keystrokes. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function LabTransport(props: {
  running: boolean;
  children: ReactNode;
  /** Optional control rendered at the now-band's right end (e.g. the
   *  compact/expanded card-view seg — shell chrome, not engine). */
  trailing?: ReactNode;
}) {
  const st = useStepper();
  const lang = useLang();
  const de = lang === "de";

  // The scrubber walks the coarse boundaries of the whole run — applied plus the
  // events still queued (a live run keeps growing; a replay is fixed).
  const all = [...st.applied, ...st.queue];
  const boundaries = stepBoundaries(all);
  const maxIndex = boundaries.length - 1;
  const cursor = st.applied.length;
  // Before the first step nothing has run; the folded scene's default focus would
  // read as "done", so name the start explicitly.
  const now = cursor === 0 ? { en: "ready to run", de: "bereit zum start" } : sceneNow(st.scene);
  let stepIndex = boundaries.indexOf(cursor);
  if (stepIndex < 0) stepIndex = boundaries.filter((b) => b <= cursor).length - 1;
  const flowing = st.mode === "flow";
  const atEnd = st.queue.length === 0;
  const viewingLive = st.source === "live";

  const scrubTo = (i: number): void => {
    if (flowing) setMode("step"); // scrubbing pauses auto-play
    seek(boundaries[Math.max(0, Math.min(maxIndex, i))]);
  };
  const jumpToEnd = (): void => {
    if (flowing) setMode("step");
    // The destination is a reading, not a literal — see endSeekTarget, which is
    // pinned against the last boundary the slider itself walks to.
    seek(endSeekTarget(all));
  };

  // The chapters, placed on the very boundaries the slider walks. A live run
  // grows, so both are read from `all` on every render rather than cached. The
  // thinning is not cosmetic: a 60-turn run draws 61 ticks 1.65% apart, and
  // ticks that touch cannot be aimed at individually.
  const marks = thinMarks(markPositions(chapterMarks(all), boundaries), MARK_MIN_GAP_PCT);
  // The same directory the moments panel reads, over the same whole run. A
  // spawn tick's sentence carries `{id}` — the raw agent id — and card 298
  // exists to keep exactly that off a screen; a tooltip is a smaller surface
  // than a list row, not a different rule.
  const dir = agentDirectory(all);
  // The wall clock, or null when this recording never carried one.
  const clock = runClock(all, cursor);
  const factor = speedFactorOf(st.intervalMs);

  // Keyboard transport — the Lab reads like the step controls. Guarded while
  // typing; the full list lives in the ? keymap. Tab-gated by this mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const onButton = el?.tagName === "BUTTON" || el?.tagName === "A";
      switch (e.key) {
        case " ":
          if (onButton) return; // let a focused button handle its own Space
          e.preventDefault();
          step();
          break;
        case "ArrowRight":
          e.preventDefault();
          step();
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepBack();
          break;
        case "f":
          setMode(st.mode === "flow" ? "step" : "flow");
          break;
        case "r":
          reset();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st.mode]);

  return (
    <>
      <div className="lab-now" aria-live="polite">
        <span className="lab-now-tag">{de ? "gerade" : "now"}</span>
        <span className="lab-now-dot" aria-hidden="true" />
        {/* CARD 319: what the run says and what is still waiting share ONE
            shrinkable item, so neither can re-decide how many lines the band
            takes while the owner steps. The `title` is the recovery the
            ellipsis owes him — the label clips his command to 17 characters at
            a 1280 window, and the tool-call panel's own clipped label has been
            recovered the same way since this card. */}
        <div className="lab-now-say">
          <span className="lab-now-label mono" title={de ? now.de : now.en}>
            {de ? now.de : now.en}
          </span>
          {st.queue.length > 0 ? (
            <span className="lab-now-queue mono tabular">
              {t(lang, "lab.waiting", { n: st.queue.length })}
            </span>
          ) : props.running && viewingLive ? (
            <span className="lab-now-queue mono">{t(lang, "lab.waitingServer")}</span>
          ) : null}
        </div>
        {props.trailing}
      </div>

      {props.children}

      <div className="lab-transport">
        <div className="lab-ctrl-btns">
          <button
            type="button"
            onClick={reset}
            disabled={cursor === 0}
            title={t(lang, "lab.reset")}
            aria-label={t(lang, "lab.reset")}
          >
            ⟲
          </button>
          <button
            type="button"
            onClick={stepBack}
            disabled={flowing || cursor === 0}
            title={t(lang, "lab.stepBackTitle")}
            aria-label="Step back"
          >
            ‹
          </button>
          <button
            type="button"
            className="play"
            onClick={() => setMode(flowing ? "step" : "flow")}
            disabled={atEnd && !flowing}
            title={flowing ? "pause" : de ? "abspielen" : "play"}
            aria-label={flowing ? "pause" : "play"}
          >
            {flowing ? "❚❚" : "▸"}
          </button>
          <button
            type="button"
            onClick={step}
            disabled={flowing || atEnd}
            title={t(lang, "lab.stepTitle")}
            aria-label="Step forward"
          >
            ›
          </button>
          <button
            type="button"
            onClick={jumpToEnd}
            disabled={atEnd}
            title={t(lang, "lab.jumpEnd")}
            aria-label={t(lang, "lab.jumpEnd")}
          >
            ⇥
          </button>
        </div>
        <div className="lab-scrub">
          <div className="lab-scrub-track">
            <input
              type="range"
              min={0}
              max={maxIndex}
              step={1}
              value={stepIndex}
              disabled={flowing}
              aria-label={de ? "replay-position" : "replay position"}
              onChange={(e) => scrubTo(Number(e.target.value))}
            />
            {marks.length > 0 && (
              <div className="lab-marks" role="group" aria-label={t(lang, "lab.marksAria")}>
                {marks.map((m, i) => {
                  const line = momentLabel(m.mark, markTag(m.mark, dir), lang);
                  return (
                    <button
                      key={`${m.mark.at}-${i}`}
                      type="button"
                      title={line}
                      aria-label={line}
                      // A pointer shortcut to a boundary the slider itself
                      // reaches with an arrow key. Tabbable, a long run would
                      // wedge dozens of stops between the slider and the speed
                      // pills with no way past them; the tick stays in the
                      // accessibility tree, out of the tab order.
                      tabIndex={-1}
                      className={`lab-mark lab-mark--${m.mark.kind}`}
                      style={{ left: `${m.pct}%` }}
                      onClick={() => scrubTo(m.index)}
                    />
                  );
                })}
              </div>
            )}
          </div>
          <span className="lab-counter mono tabular">
            {(de ? "schritt " : "step ") + stepIndex + " / " + maxIndex}
          </span>
          {/* Coarse steps are not time. The clock appears only where the
              recording carries one — see runClock. */}
          {clock !== null && (
            <span className="lab-clock mono tabular" title={t(lang, "lab.clockTitle")}>
              {clockLabel(clock.elapsedMs) + " / " + clockLabel(clock.totalMs)}
            </span>
          )}
        </div>
        <div className="lab-speed-pills" role="radiogroup" aria-label={t(lang, "lab.speedAria")}>
          {SPEED_FACTORS.map((f) => {
            const ms = intervalForFactor(f);
            return (
              <button
                key={f}
                type="button"
                role="radio"
                title={t(lang, "lab.speedPillTitle", { f: String(f), ms })}
                aria-checked={factor === f}
                className={`lab-speed-pill${factor === f ? " lab-speed-pill--on" : ""}`}
                onClick={() => setSpeed(ms)}
              >
                {`${f}×`}
              </button>
            );
          })}
        </div>
        <details className="lab-advanced">
          <summary title={de ? "grain + tempo" : "grain + tempo"}>{de ? "mehr" : "more"}</summary>
          <div className="lab-advanced-body">
            <div className="lab-grain" role="radiogroup" aria-label={t(lang, "lab.grainAria")}>
              {(
                [
                  ["coarse", t(lang, "lab.blocks")],
                  ["fine", t(lang, "lab.single")],
                ] as const
              ).map(([g, label]) => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={st.grain === g}
                  className={`lab-grain-opt${st.grain === g ? " lab-grain-opt--on" : ""}`}
                  onClick={() => setGrain(g)}
                  title={g === "coarse" ? t(lang, "lab.grainCoarseTitle") : t(lang, "lab.grainFineTitle")}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="lab-speed" title={t(lang, "lab.tempoTitle")}>
              <span className="lab-speed-label">{t(lang, "lab.tempo")}</span>
              <input
                type="range"
                min={MIN_INTERVAL_MS}
                max={MAX_INTERVAL_MS}
                step={TEMPO_SLIDER_STEP_MS}
                value={MIN_INTERVAL_MS + MAX_INTERVAL_MS - st.intervalMs}
                onChange={(e) => setSpeed(MIN_INTERVAL_MS + MAX_INTERVAL_MS - Number(e.target.value))}
                aria-label={t(lang, "lab.tempoTitle")}
              />
              <span className="lab-speed-rate mono tabular">{(1000 / st.intervalMs).toFixed(1)}×/s</span>
            </label>
          </div>
        </details>
      </div>
    </>
  );
}
