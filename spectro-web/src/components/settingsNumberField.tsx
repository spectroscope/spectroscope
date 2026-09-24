// The settings page's number field (card 386).
//
// Thirteen fields used to save `Number(e.target.value)` on every change, and
// `Number("")` is 0. Clearing a field to retype it saved a zero the operator
// never chose; for the shell time limit that zero made every command of the
// next session time out at once.
//
// This field keeps what is typed as a draft and sends only what
// numberFieldPatch allows: a whole number at or above the key's floor, which
// the server hands over in the settings view. An empty field or a number below
// the floor sends nothing, says so under the input, and shows the saved value
// again once the field loses focus.

import { useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { floorOf, numberFieldPatch, type SettingsView } from "../state/serverSettings";

/** The saved value of a key, tolerating a null the server sends for a field no
 *  layer set. */
function saved(view: SettingsView, field: string): number {
  const raw = view.effective[field];
  return typeof raw === "number" ? raw : 0;
}

/**
 * One number input for one settings key.
 *
 * @param props.view   the resolved settings view: the saved value and the floor
 * @param props.field  the settings key this input writes
 * @param props.lang   the operator's language
 * @param props.onSave writes a one-key patch to the user scope
 * @returns the input, and a note while the draft is not saved
 */
export function NumberField({
  view,
  field,
  lang,
  onSave,
}: {
  view: SettingsView;
  field: string;
  lang: Lang;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const floor = floorOf(view, field);
  const [draft, setDraft] = useState<string | null>(null);
  const held = draft !== null && numberFieldPatch(field, draft, floor) === null;
  return (
    <>
      <input
        type="number"
        min={floor}
        value={draft ?? String(saved(view, field))}
        aria-invalid={held ? true : undefined}
        data-number-field={field}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const patch = numberFieldPatch(field, raw, floor);
          if (patch !== null) onSave(patch);
        }}
        onBlur={() => setDraft(null)}
      />
      {held && (
        <p className="settings-note" data-number-held={field}>
          {draft.trim() === ""
            ? t(lang, "set.numberEmpty")
            : t(lang, "set.numberHeld", { floor: floor ?? 0 })}
        </p>
      )}
    </>
  );
}
