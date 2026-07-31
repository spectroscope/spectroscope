// The translation control (owner 2026-07-27: "einmal sinnvoll übersetzen im
// hintergrund und dann überall nutzen"). A button, a sheet, and the toggle that
// switches the whole app between the record and the translation.
//
// What changed with the event-level rework: this sheet no longer OWNS the
// translation. It starts a run in state/translate.ts and reads its progress;
// the result lands in every view at once, because every view is a fold over the
// same RunEvent[]. So the sheet is a control panel now, not a reading surface —
// the reading happens in the chat, the trace, the text feed and the lab.
//
// Four rules the design is built on:
//  1. The record survives, and it is ONE CLICK away — TranslateToggle sits next
//     to the trigger and flips back to the original. This gets used on other
//     people's incident evidence.
//  2. The run is a background job. Closing the sheet (or Escape) leaves it
//     running; only "stop" stops it.
//  3. Only prose is sent. state/translate.ts and translate/units.ts decide what
//     that means; commands, paths and tool output never leave the browser, and
//     the sheet says so before the reader clicks anything.
//  4. No button that fails. GET /api/translate/engines says what this install
//     can actually run, and an engine that cannot run says why instead.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { eventsToJsonl } from "../state/textFeed";
import {
  TARGETS,
  fetchTranslateEngines,
  planFor,
  resetTranslation,
  setEngine,
  setTarget,
  setThinking,
  startTranslation,
  stopTranslation,
  toggleShow,
  useTranslation,
  withTranslation,
} from "../state/translate";
import type { Engine, EngineReport, Engines, Passage, Plan, TranslationState } from "../state/translate";
import type { Lang } from "../i18n/i18n";

export type { Engine };

/** What a closed sheet costs to know. */
const EMPTY_PLAN: Plan = { units: [], passages: [] };

/** The engine the sheet starts on: local when it can run (nothing leaves the
 *  machine), otherwise the configured provider, otherwise none. */
export function preferredEngine(engines: Engines | null): Engine | null {
  if (!engines) return null;
  if (engines.local.available) return "local";
  if (engines.cloud.available) return "cloud";
  return null;
}

/** The i18n key explaining why an engine is out, or null when it is available. */
export function reasonKey(report: EngineReport): string | null {
  if (report.available) return null;
  switch (report.reason) {
    case "no-binary":
      return "tr.out.noBinary";
    case "no-model":
      return "tr.out.noModel";
    case "needs-key":
      return "tr.out.needsKey";
    case "provider-is-local":
      return "tr.out.providerIsLocal";
    default:
      return "tr.out.generic";
  }
}

/** What a run will send. Passages are calls, so `calls` is also its length. */
export interface TextCost {
  calls: number;
  /**
   * Whitespace-separated tokens, COUNTED rather than divided out of the
   * character count. A words-per-character constant would be a number this app
   * does not have, and the sheet would be stating it as if it did.
   */
  words: number;
  chars: number;
}

/**
 * What translating a plan costs, in the terms the sheet states it.
 *
 * @param passages the plan's calls
 * @return the calls, and how much prose is in them
 */
export function costOf(passages: readonly Passage[]): TextCost {
  let words = 0;
  let chars = 0;
  for (const passage of passages) {
    words += passage.text.match(/\S+/g)?.length ?? 0;
    chars += passage.text.length;
  }
  return { calls: passages.length, words, chars };
}

/**
 * The reasoning's share of a plan — the number the checkbox is about.
 *
 * Read off the SAME plan the run will use rather than by planning the stream a
 * second time: a passage carries what kind of text it is, so the share is exact
 * and free. A plan built without the reasoning reports zero, because such a plan
 * genuinely does not know how large the reasoning is; the sheet says that in
 * words instead of showing a figure it does not have.
 *
 * @param plan the plan the sheet is previewing
 * @return the reasoning part of its cost
 */
export function reasoningCost(plan: Plan): TextCost {
  return costOf(plan.passages.filter((passage) => passage.kind === "thinking"));
}

/**
 * A size a reader can hold in their head. Small counts stay exact — rounding
 * seven words away would read as nothing at all — and larger ones keep their
 * leading digits, because past a few thousand the magnitude is the whole point.
 *
 * @param words a counted number of words
 * @return the same number, rounded to its magnitude
 */
export function roughly(words: number): number {
  const step = stepFor(words);
  return Math.round(words / step) * step;
}

function stepFor(words: number): number {
  if (words < 100) return 1;
  if (words < 1000) return 10;
  if (words < 10000) return 100;
  return 1000;
}

/** Whether the run button may be armed at all. */
export function canRun(engines: Engines | null, engine: Engine | null, passages: number): boolean {
  if (!engines || !engine || passages === 0) return false;
  return engines[engine].available;
}

/**
 * The one-click way back to the record. Rendered wherever a translated stream
 * is shown — next to the trigger in the chat header, and in the tab row, so
 * the record is one click away on the trace, the text feed and the lab too.
 *
 * A lens, not a swap button: it carries the same fixed label as the reasoning
 * lens next door and says with its pressed state which text is on screen. A
 * label that changed with the state would have to be read before it could be
 * trusted, and this is the control that gets used under pressure.
 */
export function TranslateToggle(props: { viewKey?: string }) {
  const viewKey = props.viewKey ?? "live";
  const lang = useLang();
  const state = useTranslation(viewKey);
  if (state.byId.size === 0) return null;
  const original = state.show === "original";
  return (
    <button
      type="button"
      className={original ? "trace-lens mono trace-lens--on" : "trace-lens mono"}
      aria-pressed={original}
      onClick={() => toggleShow(viewKey)}
    >
      {t(lang, "tr.original")}
    </button>
  );
}

export function TranslatePanel(props: { events: readonly RunEvent[]; viewKey?: string }) {
  const viewKey = props.viewKey ?? "live";
  const lang = useLang();
  const state = useTranslation(viewKey);
  const [open, setOpen] = useState(false);
  const [engines, setEngines] = useState<Engines | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);

  // Only while the sheet is open. This trigger lives in the chat header of a
  // LIVE session, where the stream grows every animation frame, and planning
  // walks and splits every unit of it — a cost nobody is looking at.
  //
  // The reasoning choice is a dependency, not a filter applied afterwards: it
  // changes which units are extracted, so the preview has to be re-planned for
  // it. startTranslation reads the same choice out of the same state, which is
  // what keeps this preview and the run it starts describing the same work.
  const plan = useMemo(
    () => (open ? planFor(props.events, state.thinking) : EMPTY_PLAN),
    [open, props.events, state.thinking],
  );
  const cost = useMemo(() => costOf(plan.passages), [plan]);
  const reasoning = useMemo(() => reasoningCost(plan), [plan]);

  // The probe runs on every open: a model can finish downloading, or a key can
  // be set in Settings, while this panel sits closed.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEnginesError(null);
    void fetchTranslateEngines().then(
      (probed) => {
        if (!alive) return;
        setEngines(probed);
        const preferred = preferredEngine(probed);
        if (state.engine === null && preferred !== null) setEngine(viewKey, preferred);
      },
      (failed: unknown) => {
        if (!alive) return;
        // Absent stays absent: without the probe we offer nothing.
        setEngines(null);
        setEnginesError(failed instanceof Error ? failed.message : String(failed));
      },
    );
    return () => {
      alive = false;
    };
    // state.engine is read, not tracked: a re-probe on every choice is noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewKey]);

  // Escape closes the sheet and leaves the run alone — it is a background job.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const running = state.status === "running";
  const armed = canRun(engines, state.engine, plan.passages.length) && !running;

  // No stream, nothing translated: no control. The chat also renders INSIDE the
  // lab, where it is handed a stepper's projection and no stream of its own —
  // a trigger there could only ever plan zero passages, and would address the
  // live session while the reader is looking at an archive. An empty session
  // gets the same answer for the same reason: there is nothing to translate.
  if (props.events.length === 0 && state.byId.size === 0) return null;

  return (
    <>
      <button
        type="button"
        className="trace-lens mono"
        title={t(lang, "tr.buttonTitle")}
        onClick={() => setOpen(true)}
      >
        {t(lang, "tr.button")}
      </button>
      <TranslateToggle viewKey={viewKey} />

      {/* Portalled to the body like ParticleField: the trigger can then live
          anywhere, including inside a positioned corner box, without that box's
          stacking context deciding whether the sheet is visible. */}
      {open &&
        createPortal(
          <div className="km-backdrop" onClick={() => setOpen(false)} role="presentation">
            <div
              className="km-panel ob-panel"
              role="dialog"
              aria-modal="true"
              aria-label={t(lang, "tr.title")}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="km-head">
                <span className="km-title">{t(lang, "tr.title")}</span>
                <button
                  type="button"
                  className="km-close"
                  onClick={() => setOpen(false)}
                  aria-label={t(lang, "common.close")}
                >
                  ×
                </button>
              </div>

              {/* What is NOT translated, before anything is sent. */}
              <p className="ob-intro">{t(lang, "tr.lede")}</p>
              <p className="ob-foot-note">{t(lang, "tr.applied")}</p>

              <ul className="ob-opts">
                {(["local", "cloud"] as const).map((id) => {
                  const report = engines?.[id];
                  const why = report ? reasonKey(report) : null;
                  const badge = id === "local" ? "local" : (report?.provider ?? "cloud");
                  const chosen = state.engine === id;
                  return (
                    <li key={id} className="ob-opt">
                      <div className="ob-opt-head">
                        <span className="ob-opt-badge mono">{badge}</span>
                        <span className="ob-opt-title">{t(lang, `tr.engine.${id}`)}</span>
                        {report?.available && (
                          <span className="ob-opt-tag mono">{report.label ?? report.model ?? ""}</span>
                        )}
                      </div>
                      <p className="ob-opt-body">{t(lang, `tr.engine.${id}.body`)}</p>
                      {why !== null && (
                        <p className="ob-opt-body">
                          {t(lang, why)}
                          {report?.detail !== undefined && ` — ${report.detail}`}
                        </p>
                      )}
                      <div className="ob-opt-head">
                        <button
                          type="button"
                          className={chosen ? "trace-lens mono trace-lens--on" : "trace-lens mono"}
                          aria-pressed={chosen}
                          disabled={!report?.available || running}
                          onClick={() => setEngine(viewKey, id)}
                        >
                          {t(lang, chosen ? "tr.engine.chosen" : "tr.engine.choose")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {enginesError !== null && (
                <p className="ob-opt-body">{t(lang, "tr.enginesFailed", { msg: enginesError })}</p>
              )}

              {/* The reasoning is a choice with the price next to it, and it sits
                  ABOVE the run button so the price is read on the way to it. It
                  is opt-in in translate/units.ts for a measured reason: on a
                  real transcript the reasoning is the larger half of the text,
                  so including it roughly doubles both the wire and the wall
                  clock. It defaults ON all the same, because a session whose
                  answers are translated and whose reasoning is not reads as
                  half broken, and a slower run beats a confusing one.

                  Locked while a run is in flight: the plan above is what the
                  run in flight is working through, and letting the choice move
                  under it would leave the sheet describing work nobody started. */}
              <div className="tr-cost">
                <label className="tr-check">
                  <input
                    type="checkbox"
                    checked={state.thinking}
                    disabled={running}
                    onChange={(e) => setThinking(viewKey, e.target.checked)}
                  />
                  {t(lang, "tr.thinking")}
                </label>
                {plan.passages.length === 0 ? (
                  <p className="ob-foot-note">{t(lang, "tr.nothing")}</p>
                ) : (
                  <>
                    {/* Passages and roughly how much text. The exact character
                        count rides along as the title for anyone who wants it,
                        because a byte count is an answer to a different question
                        than "how long will this take". */}
                    <p
                      className="ob-foot-note"
                      title={t(lang, "tr.costExact", { c: cost.chars.toLocaleString(lang) })}
                    >
                      {t(lang, "tr.plan", { u: plan.units.length, n: plan.passages.length })}{" "}
                      {t(lang, "tr.cost", { w: roughly(cost.words).toLocaleString(lang) })}
                    </p>
                    <p className="ob-foot-note">
                      {state.thinking
                        ? t(lang, "tr.thinkingIn", {
                            n: reasoning.calls,
                            w: roughly(reasoning.words).toLocaleString(lang),
                          })
                        : t(lang, "tr.thinkingOut")}
                    </p>
                  </>
                )}
              </div>

              <div className="ob-foot">
                <span className="ob-foot-note">
                  {t(lang, "tr.target")}{" "}
                  {TARGETS.map((target) => (
                    <button
                      key={target.code}
                      type="button"
                      className={
                        state.target === target.code ? "trace-lens mono trace-lens--on" : "trace-lens mono"
                      }
                      aria-pressed={state.target === target.code}
                      disabled={running}
                      onClick={() => setTarget(viewKey, target.code)}
                    >
                      {target.name}
                    </button>
                  ))}
                </span>
                {running ? (
                  <button type="button" className="ghost" onClick={() => stopTranslation(viewKey)}>
                    {t(lang, "tr.stop")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={!armed}
                    onClick={() => void startTranslation(viewKey, props.events)}
                  >
                    {t(lang, "tr.run", { n: plan.passages.length })}
                  </button>
                )}
              </div>

              {state.status !== "idle" && <RunReport lang={lang} state={state} />}

              {state.byId.size > 0 && (
                <div className="ob-foot">
                  <TranslateToggle viewKey={viewKey} />
                  <ExportButton
                    label={t(lang, "tr.export")}
                    title={t(lang, "tr.exportTitle")}
                    name={`${viewKey}.${state.target}.jsonl`}
                    build={() => eventsToJsonl(withTranslation(props.events, state)).join("\n") + "\n"}
                  />
                  <button type="button" className="ghost" onClick={() => resetTranslation(viewKey)}>
                    {t(lang, "tr.reset")}
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Progress, the model that did it, and what did NOT come back. */
function RunReport(props: { lang: Lang; state: TranslationState }) {
  const { lang, state } = props;
  return (
    <>
      <div className="tf-explain-head">
        <span className="tf-explain-title mono">{t(lang, "tr.result")}</span>
        {state.meta && (
          <span className="tf-explain-model mono">
            {state.meta.provider} · {state.meta.model} → {state.meta.target}
          </span>
        )}
        <span className="tf-explain-honesty">
          {t(lang, "tr.progress", { done: state.finished, total: state.passages })} · {t(lang, "tr.honesty")}
        </span>
      </div>

      {state.status === "running" && <div className="tf-explain-foot">{t(lang, "tr.running")}</div>}
      {state.status === "done" && <div className="tf-explain-foot">{t(lang, "tr.done")}</div>}
      {state.status === "stopped" && <div className="tf-explain-foot">{t(lang, "tr.stopped")}</div>}
      {state.status === "error" && (
        <div className="tf-explain-foot tf-explain-foot--error">
          {t(lang, "tr.failed", { msg: state.error ?? "?" })}
        </div>
      )}
      {/* Named, not hidden: those fields still read in the original language. */}
      {state.failed.size > 0 && (
        <div className="tf-explain-foot tf-explain-foot--error">
          {t(lang, "tr.failedUnits", { n: state.failed.size })}{" "}
          {t(lang, "tr.failedPassage", { msg: [...state.failed.values()][0] })}
        </div>
      )}
    </>
  );
}

/**
 * The translated session as a file (owner: "auch gerne anbieten das neue jsonl
 * zu exportieren, dann kann man beim nächsten mal gleich das neue nehmen").
 * Built in the browser from the stream the views are already rendering, so the
 * file and the screen can never disagree.
 */
function ExportButton(props: { label: string; title: string; name: string; build: () => string }) {
  const save = (): void => {
    const url = URL.createObjectURL(new Blob([props.build()], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = props.name;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button type="button" className="ghost" title={props.title} onClick={save}>
      {props.label}
    </button>
  );
}
