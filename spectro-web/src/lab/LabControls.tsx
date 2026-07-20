// The Lab's step toolbar: step back / Step, the Blöcke|Einzeln grain, the
// Flow dam switch with its tempo slider, the queue status and Reset.
// Self-contained on purpose — the stepper is a global store and every action
// is a module-level import, so the toolbar needs only the running flag from
// its parent.

import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  reset,
  setGrain,
  setMode,
  setSpeed,
  step,
  stepBack,
  useStepper,
} from "../state/stepper";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The tempo slider snaps in steps of this many milliseconds. */
const TEMPO_SLIDER_STEP_MS = 20;

export function LabControls(props: {
  /** True while the live run is active (drives the "waiting" hint). */
  running: boolean;
}) {
  const st = useStepper();
  const lang = useLang();
  const viewingLive = st.source === "live";
  const nextEvent = st.queue.length > 0 ? st.queue[0] : null;
  const damOpen = st.mode === "flow";

  return (
    <div className="lab-controls">
      <button
        type="button"
        className="ghost lab-back"
        onClick={stepBack}
        disabled={damOpen || st.applied.length === 0}
        title={t(lang, "lab.stepBackTitle")}
        aria-label="Step back"
      >
        ‹
      </button>
      <button
        type="button"
        className="soft-primary lab-step"
        onClick={step}
        disabled={damOpen || st.queue.length === 0}
        title={t(lang, "lab.stepTitle")}
      >
        Step
        {nextEvent !== null && !damOpen && <span className="lab-step-next mono">{nextEvent.type}</span>}
      </button>

      <div className="lab-grain" role="radiogroup" aria-label={t(lang, "lab.grainAria")}>
        {/* internal ids stay coarse/fine (persistence + tests); the labels
            say what they mean: blocks = meaningful groups (one thinking run,
            one answer, one event each), single = every JSONL line. */}
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

      {/* the dam switch — flow now auto-plays at the slider's pace */}
      <button
        type="button"
        className={`fx-switch${damOpen ? " fx-switch--on" : ""}`}
        role="switch"
        aria-checked={damOpen}
        onClick={() => setMode(damOpen ? "step" : "flow")}
      >
        <span className="fx-switch-label">Flow</span>
        <span className="fx-switch-track" aria-hidden="true">
          <span className="fx-switch-knob" />
        </span>
      </button>

      {/* Tempo — right = faster (shorter interval). Sets the flow pace. */}
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

      <span className="lab-queue tabular" aria-live="polite">
        {st.queue.length > 0
          ? t(lang, "lab.waiting", { n: st.queue.length })
          : props.running && viewingLive
            ? t(lang, "lab.waitingServer")
            : ""}
      </span>

      <button type="button" className="ghost lab-reset" onClick={reset} disabled={st.applied.length === 0}>
        {t(lang, "lab.reset")}
      </button>
    </div>
  );
}

/** The one-line reading aid under the Flow map, per language. */
export function LabHint() {
  const lang = useLang();
  return (
    <p className="lab-hint">
      {lang === "de" ? (
        <>
          Das Coral-Paket wandert pro <span className="mono">Step</span> eine Station weiter —
          links das <span className="mono">Agentensystem</span> (Agent + Betriebssystem), rechts
          die externen Dienste (<span className="mono">LLM</span>, Netz, MCP-Server).
        </>
      ) : (
        <>
          The coral packet moves one station per <span className="mono">Step</span> — the{" "}
          <span className="mono">agent system</span> (agent + operating system) on the left,
          the external services (<span className="mono">LLM</span>, network, MCP server) on the right.
        </>
      )}
    </p>
  );
}
