// Card 604: the model controls in the files tab's toolbar. A switch between
// the heuristic alone and the heuristic plus a model's reading; with the
// second, a picker for a provider and a model, the button that opens the
// consent sheet, a status line and, when the model did not answer in the
// asked-for JSON, its text as a note. Section 3 of the design is the authority.
//
// The picker starts empty, so nothing runs on the chat's model by accident,
// then offers the pair last chosen here while its provider is still offered.
// It lists cloud and local providers only: the built-in model is not offered
// (C6). A provider that cannot run is listed, greyed, with its reason.
//
// Nothing is sent before the consent click. The "analyze with model" press
// builds the digest and asks the server's pre-flight; only the sheet's send
// press starts the reading (filesAnalysis.ts).

import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pickerOption } from "../components/providerPickerMode";
import { useProviderModels } from "../components/providerModelField";
import { t, type Lang } from "../i18n/i18n";
import {
  checkProviders,
  refreshProviders,
  useProviderRows,
  type ProviderRow,
} from "../state/providerRegistry";
import type { AnalysisState } from "../state/runAnalysis";
import { buildFilesDigest } from "./digest";
import { FilesConsent } from "./FilesConsent";
import {
  closeFilesConsent,
  loadPick,
  openFilesConsent,
  savePick,
  startFilesAnalysis,
  useFilesConsent,
  type ModelPick,
  type ReadingMode,
} from "./filesAnalysis";
import type { FileLedger } from "./fold";
import { readModelAnswer } from "./modelReading";

export type { ReadingMode };

export interface FilesModelControlsProps {
  lang: Lang;
  viewKey: string;
  mode: ReadingMode;
  onMode: (mode: ReadingMode) => void;
  /** The heuristic ledger: the digest is built from it, never from a merged one. */
  ledger: FileLedger;
  /** The session's reading, from useFilesAnalysis. */
  analysis: AnalysisState;
}

const MODES: readonly ReadingMode[] = ["heuristic", "model"];
const NO_PICK: ModelPick = { provider: "", model: "" };

/** The providers this analysis offers: cloud and local, never the built-in model (C6). */
export function offeredRows(rows: readonly ProviderRow[]): ProviderRow[] {
  return rows.filter((row) => row.kind === "cloud" || row.kind === "local");
}

/** A provider row as an option: greyed with its reason when it cannot run. */
function optionOf(lang: Lang, row: ProviderRow): { label: string; disabled: boolean } {
  // No provider is exempt here: the chat's own provider gets no pass.
  const option = pickerOption(row, "");
  const reason = option.reasonKey === null ? null : t(lang, option.reasonKey, option.vars);
  return { label: reason === null ? row.id : `${row.id}, ${reason}`, disabled: option.disabled };
}

export function FilesModelControls(props: FilesModelControlsProps): JSX.Element {
  const { lang, viewKey, mode, onMode, ledger, analysis } = props;
  const offered = offeredRows(useProviderRows());
  const [chosen, setChosen] = useState<ModelPick>(() => loadPick() ?? NO_PICK);
  const usable = offered.find((row) => row.id === chosen.provider && !pickerOption(row, "").disabled);
  const provider = usable?.id ?? "";
  const model = provider === "" ? "" : chosen.model;
  const fetched = useProviderModels(mode === "model" ? provider : "", undefined, {
    model,
    onModelChange: (next) => setChosen((before) => ({ ...before, model: next })),
    autoPick: false,
  }).models;
  const models = fetched.length > 0 ? fetched : (usable?.models ?? []);
  const consent = useFilesConsent(viewKey);
  const entries = useMemo(
    () => (analysis.status === "done" ? readModelAnswer(analysis.text) : null),
    [analysis],
  );

  // The registry as the server knows it, and a fresh look at the local servers,
  // whose state is the only guard against a server that is down.
  useEffect(() => {
    if (mode === "model") void refreshProviders().then(() => checkProviders("local"));
  }, [mode]);
  // A sheet belongs to the tab on screen; it does not wait for a later visit.
  useEffect(() => () => closeFilesConsent(viewKey), [viewKey]);

  const streaming = analysis.status === "running";
  const ready = provider !== "" && model.trim() !== "";

  const analyze = (): void => {
    if (!ready || streaming) return;
    const pick = { provider, model: model.trim() };
    savePick(pick);
    openFilesConsent(viewKey, pick, buildFilesDigest(ledger));
  };

  const run = (): void => {
    if (consent === null || consent.report?.available !== true || streaming) return;
    closeFilesConsent(viewKey);
    void startFilesAnalysis(viewKey, consent.digest.text, consent.pick, lang);
  };

  const pickMode = (next: ReadingMode): void => {
    if (next === "heuristic") closeFilesConsent(viewKey);
    onMode(next);
  };

  const status = statusLine(lang, analysis, entries, ready);
  return (
    <>
      <div className="files-model">
        <div className="files-seg" role="group" aria-label={t(lang, "filesTab.model.aria")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              data-action={`mode-${m}`}
              aria-pressed={mode === m}
              className={mode === m ? "files-seg__btn files-seg__btn--on" : "files-seg__btn"}
              onClick={() => pickMode(m)}
            >
              {t(lang, m === "model" ? "filesTab.model.withModel" : "filesTab.model.heuristic")}
            </button>
          ))}
        </div>
        {mode === "model" && (
          <>
            <select
              className="files-model__select"
              data-action="model-provider"
              aria-label={t(lang, "filesTab.model.provider")}
              value={provider}
              onChange={(e) => setChosen({ provider: e.target.value, model: "" })}
            >
              <option value="">{t(lang, "filesTab.model.chooseProvider")}</option>
              {offered.map((row) => {
                const option = optionOf(lang, row);
                return (
                  <option key={row.id} value={row.id} disabled={option.disabled}>
                    {option.label}
                  </option>
                );
              })}
            </select>
            {provider !== "" &&
              modelField(lang, model, models, (next) => setChosen((before) => ({ ...before, model: next })))}
            <button
              type="button"
              className="files-model__go"
              data-action="analyze-model"
              disabled={!ready || streaming}
              onClick={analyze}
            >
              {t(lang, analysis.status === "done" ? "filesTab.model.again" : "filesTab.model.analyze")}
            </button>
            {status !== null && (
              <span className="files-model__status" role="status">
                {status}
              </span>
            )}
          </>
        )}
      </div>
      {mode === "model" && analysis.status === "done" && entries === null && (
        <div className="files-model__note">
          <span className="files-model__note-title">{t(lang, "filesTab.model.noteTitle")}</span>
          <pre className="files-model__note-text">{analysis.text}</pre>
        </div>
      )}
      {mode === "model" &&
        consent !== null &&
        overlay(
          <FilesConsent
            lang={lang}
            consent={consent}
            running={streaming}
            onRun={run}
            onClose={() => closeFilesConsent(viewKey)}
          />,
        )}
    </>
  );
}

/** The model field: the provider's list when it has one, else a name to type. */
function modelField(
  lang: Lang,
  model: string,
  models: string[],
  onChange: (model: string) => void,
): JSX.Element {
  if (models.length === 0) {
    return (
      <input
        className="files-model__select"
        type="text"
        data-action="model-name"
        aria-label={t(lang, "filesTab.model.model")}
        placeholder={t(lang, "filesTab.model.modelPh")}
        value={model}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  // A remembered model the list no longer carries stays selectable, so the field never lies.
  const list = model !== "" && !models.includes(model) ? [model, ...models] : models;
  return (
    <select
      className="files-model__select"
      data-action="model-name"
      aria-label={t(lang, "filesTab.model.model")}
      value={model}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t(lang, "filesTab.model.chooseModel")}</option>
      {list.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

/** What the reading is doing, named after the model of the stream, never after the pick. */
function statusLine(
  lang: Lang,
  analysis: AnalysisState,
  entries: unknown[] | null,
  ready: boolean,
): string | null {
  const names =
    analysis.meta === null ? null : { provider: analysis.meta.provider, model: analysis.meta.model };
  switch (analysis.status) {
    case "running":
      return names === null ? t(lang, "filesTab.model.running") : t(lang, "filesTab.model.runningAs", names);
    case "error":
      return t(lang, "filesTab.model.failed", { msg: analysis.error ?? "?" });
    case "done":
      return t(
        lang,
        entries === null ? "filesTab.model.prose" : "filesTab.model.shown",
        names ?? { provider: "?", model: "?" },
      );
    default:
      return ready ? null : t(lang, "filesTab.model.choose");
  }
}

/** The sheet over the whole app; inline where there is no document, as on the server renderer the tests use. */
function overlay(sheet: JSX.Element): ReactNode {
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
