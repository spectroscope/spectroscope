// A field's provenance badge and its reset affordance.
//
// Lifted out of SettingsPanel.tsx by card 281, unchanged. The progress section
// is its own component and needs the same badge; leaving the definition in the
// panel would have made the two import each other. One definition, two callers,
// no copy — which is the same reason SettingsWriter takes SpectroConfig's list
// object rather than re-typing it.

import { originLabel, type SettingsView } from "../state/serverSettings";
import { t, type Lang } from "../i18n/i18n";

/** A field's provenance badge, plus a "reset to the layer below" affordance
 *  shown only when the USER scope actually set this field — there is nothing
 *  to fall back FROM otherwise, so the button stays hidden rather than
 *  writing a no-op patch.
 *
 *  @param props.view       the resolved settings view, for origins and layers
 *  @param props.field      the field name this badge describes
 *  @param props.lang       the operator's language
 *  @param props.onReset    clears this field from the user scope
 *  @param props.resetTitle overrides the reset button's label
 *  @returns the badge row */
export function OriginRow({
  view,
  field,
  lang,
  onReset,
  resetTitle,
}: {
  view: SettingsView;
  field: string;
  lang: Lang;
  onReset: () => void;
  resetTitle?: string;
}) {
  const resettable = view.layers.user?.[field] !== undefined;
  const title = resetTitle ?? t(lang, "set.reset");
  return (
    <span className="origin-row">
      <span className="origin-badge">{originLabel(view.origins[field], lang)}</span>
      {resettable && (
        <button type="button" className="origin-reset" title={title} aria-label={title} onClick={onReset}>
          ↺
        </button>
      )}
    </span>
  );
}
