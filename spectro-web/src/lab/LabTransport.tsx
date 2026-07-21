// The Lab's replay transport (edu port): a floating "now" band that names the
// current station, the map, then a scrub bar below it — reset / prev / play /
// next plus a slider that walks the COARSE-step boundaries and a step counter.
// It replaces the old Step toolbar; grain + tempo move behind a small "advanced"
// disclosure, since a live run rarely needs them. Keyboard: space or → steps,
// ← steps back, f toggles flow, r resets (documented in the ? keymap). The map
// is passed as children so the band sits above it and the transport below.

import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  reset,
  seek,
  setGrain,
  setMode,
  setSpeed,
  step,
  stepBack,
  stepBoundaries,
  useStepper,
} from "../state/stepper";
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

export function LabTransport(props: { running: boolean; children: ReactNode }) {
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
        <span className="lab-now-label mono">{de ? now.de : now.en}</span>
        {st.queue.length > 0 ? (
          <span className="lab-now-queue mono tabular">{t(lang, "lab.waiting", { n: st.queue.length })}</span>
        ) : props.running && viewingLive ? (
          <span className="lab-now-queue mono">{t(lang, "lab.waitingServer")}</span>
        ) : null}
      </div>

      {props.children}

      <div className="lab-transport">
        <div className="lab-ctrl-btns">
          <button type="button" onClick={reset} disabled={cursor === 0}
            title={t(lang, "lab.reset")} aria-label={t(lang, "lab.reset")}>⟲</button>
          <button type="button" onClick={stepBack} disabled={flowing || cursor === 0}
            title={t(lang, "lab.stepBackTitle")} aria-label="Step back">‹</button>
          <button type="button" className="play" onClick={() => setMode(flowing ? "step" : "flow")}
            disabled={atEnd && !flowing} title={flowing ? "pause" : de ? "abspielen" : "play"}
            aria-label={flowing ? "pause" : "play"}>{flowing ? "❚❚" : "▸"}</button>
          <button type="button" onClick={step} disabled={flowing || atEnd}
            title={t(lang, "lab.stepTitle")} aria-label="Step forward">›</button>
        </div>
        <div className="lab-scrub">
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
          <span className="lab-counter mono tabular">
            {(de ? "schritt " : "step ") + stepIndex + " / " + maxIndex}
          </span>
        </div>
        <details className="lab-advanced">
          <summary title={de ? "grain + tempo" : "grain + tempo"}>{de ? "mehr" : "more"}</summary>
          <div className="lab-advanced-body">
            <div className="lab-grain" role="radiogroup" aria-label={t(lang, "lab.grainAria")}>
              {([["coarse", t(lang, "lab.blocks")], ["fine", t(lang, "lab.single")]] as const).map(([g, label]) => (
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
