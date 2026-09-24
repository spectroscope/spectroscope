// A field's provenance badge and its reset affordance.
//
// Lifted out of SettingsPanel.tsx by card 281, unchanged. The progress section
// is its own component and needs the same badge; leaving the definition in the
// panel would have made the two import each other. One definition, two callers,
// no copy — which is the same reason SettingsWriter takes SpectroConfig's list
// object rather than re-typing it.

import { layerLabel, originLabel, type SettingsView } from "../state/serverSettings";
import { t, type Lang } from "../i18n/i18n";

/** A field's provenance badge, plus a "reset to the layer below" affordance
 *  shown only when the USER scope actually set this field — there is nothing
 *  to fall back FROM otherwise, so the button stays hidden rather than
 *  writing a no-op patch.
 *
 *  Card 386: a value a settings file held below its key's floor was skipped
 *  on read, so the badge names the layer that supplies the value now, and a
 *  line beside it names the skipped value, its layer and the floor. A value
 *  skipped in the user settings file keeps the reset, because the reset is
 *  what clears it from that file.
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
  const skipped = (view.belowFloor ?? []).filter((entry) => entry.key === field);
  const resettable =
    view.layers.user?.[field] !== undefined ||
    skipped.some((entry) => entry.layer === "user" && entry.file === view.files.user);
  const title = resetTitle ?? t(lang, "set.reset");
  return (
    <span className="origin-row">
      <span className="origin-badge">{originLabel(view.origins[field], lang)}</span>
      {skipped.map((entry) => (
        <span key={`${entry.layer}:${entry.file}`} className="origin-skipped" data-below-floor={field}>
          {t(lang, "set.originBelowFloor", {
            value: entry.value,
            layer: layerLabel(entry.layer, lang),
            floor: entry.floor,
          })}
        </span>
      ))}
      {resettable && (
        <button type="button" className="origin-reset" title={title} aria-label={title} onClick={onReset}>
          ↺
        </button>
      )}
    </span>
  );
}
