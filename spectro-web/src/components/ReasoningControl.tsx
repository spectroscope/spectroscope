// The reasoning seg (card 88) — shared by the header provider picker and the
// Settings "session defaults" section, the providerModelField pattern: one
// brain, two hosts. Renders NOTHING until the capability record for the
// (provider, model) pair is known, and nothing at all for control "none" —
// the UI must not offer what the model cannot do. Cells write the per-model
// choice store; the WIRE send lives in App (one site), which watches the
// store for the ACTIVE pair.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  cellClick,
  fetchCapability,
  noneNote,
  segCells,
  setReasoningChoice,
  useReasoningChoice,
  type ReasoningCapability,
  type SegCell,
} from "../state/reasoning";

/** The record for one pair, null while unknown (loading, blank pair, dark
 *  server). Refetches on a pair change; the module cache makes reopening the
 *  picker free. */
export function useReasoningCapability(provider: string, model: string): ReasoningCapability | null {
  const [cap, setCap] = useState<ReasoningCapability | null>(null);
  useEffect(() => {
    setCap(null);
    if (provider === "" || model === "") return;
    let alive = true;
    void fetchCapability(provider, model).then((c) => {
      if (alive) setCap(c);
    });
    return () => {
      alive = false;
    };
  }, [provider, model]);
  return cap;
}

/** A cell's visible text: on/off translate, effort tokens are wire vocabulary. */
function cellLabel(lang: "de" | "en", cell: SegCell): string {
  if (cell.kind === "on") return t(lang, "rc.on");
  if (cell.kind === "off") return t(lang, "rc.off");
  return cell.id;
}

/** The hover line: the greyed-out reason wins, a pressed explicit choice
 *  offers the way back, everything else says what a click requests. */
function cellTitle(lang: "de" | "en", cell: SegCell, explicit: boolean): string {
  if (cell.reason === "no-off") return t(lang, "rc.noOff");
  // The cap names the RECORD's offMaxEffort, never the cell it greys out.
  if (cell.reason === "cap") return t(lang, "rc.offCap", { level: cell.capAt ?? "" });
  if (cell.pressed && explicit) return t(lang, "rc.clearTitle");
  if (cell.kind === "on") return t(lang, "rc.onTitle");
  if (cell.kind === "off") return t(lang, "rc.offTitle");
  return t(lang, "rc.effortTitle", { level: cell.id });
}

export function ReasoningControl({
  provider,
  model,
  showNone = false,
}: {
  provider: string;
  model: string;
  /** Settings wants an honest "no control on this model" line where the
   *  header picker just stays quiet. Only a KNOWN none-record shows it —
   *  an unanswered probe never claims anything. */
  showNone?: boolean;
}) {
  const lang = useLang();
  const cap = useReasoningCapability(provider, model);
  const choice = useReasoningChoice(provider, model);

  if (cap === null) return null;
  if (cap.control === "none") {
    // No cells either way; Settings still says which of the two silences this
    // is — a model that reasons without a switch, or one that never reasons.
    if (!showNone) return null;
    const key = noneNote(cap) === "thinks" ? "rc.noneThinks" : "rc.noneQuiet";
    return <span className="provider-field-note">{t(lang, key)}</span>;
  }

  const cells = segCells(cap, choice);
  return (
    <div className="trace-seg reasoning-seg" role="group" aria-label={t(lang, "rc.aria")}>
      <span className="trace-seg-label mono">{t(lang, "rc.label")}</span>
      {cells.map((cell) => {
        // "explicit" drives the click-again-to-clear affordance in the title:
        // pressed-by-default and pressed-by-choice look the same but differ.
        const explicit =
          (cell.kind === "off" && choice.mode === "off") ||
          (cell.kind === "on" && choice.mode === "on") ||
          (cell.kind === "effort" && choice.mode === "on" && choice.effort === cell.id);
        return (
          <button
            key={cell.id}
            type="button"
            className="mono"
            aria-pressed={cell.pressed}
            disabled={cell.disabled}
            title={cellTitle(lang, cell, explicit)}
            onClick={() => setReasoningChoice(provider, model, cellClick(cap, choice, cell.id))}
          >
            {cellLabel(lang, cell)}
          </button>
        );
      })}
    </div>
  );
}
