// Card 361 — the right dock's two widths, on the page.
//
// The owner met a hard edge on his external monitor and asked why. Three caps
// ran in series and none of them was his: the drag reserved 360 pixels for the
// chat, the store clamped at a literal 1200, and the stylesheet capped the
// render eight pixels tighter still. Which one BOUND depended on the window —
// below roughly a 1560px row the reserve decided, at or above it the ceiling —
// which is why relaxing only one of them would have changed nothing on the
// screen he was looking at. Both became settings, with today's values as
// defaults, and both are drawn here.
//
// One block, not two: they share a reach and a subject. Two blocks would put
// two sentences over one question ("how wide may the dock get"), and the reader
// would have to work out that the answer is whichever of them binds first —
// which is exactly the thing the hint above the pair says out loud.

import { t, type Lang } from "../i18n/i18n";
import type { SettingsView } from "../state/serverSettings";
import { OriginRow } from "./settingsOrigin";
import { ReachBlock } from "./settingsReach";

/** The two keys, with the floor each input refuses to go under. The dock's own
 *  minimum is the ceiling's floor: a ceiling below it would make every drag
 *  illegal, and readDockWidths heals such a value back to the shipped one
 *  anyway — the input says so before the healing has to. */
const FIELDS = [
  ["chatReserveWidth", 0],
  ["dockMaxWidth", 260],
] as const;

/** Reads a width out of the resolved view, tolerating a null the server sends
 *  for a field no layer set. */
function px(view: SettingsView, field: string): number {
  const raw = view.effective[field];
  return typeof raw === "number" ? raw : 0;
}

/**
 * The dock-width block of the settings page's general room.
 *
 * @param props.view   the resolved settings view
 * @param props.lang   the operator's language
 * @param props.onSave writes a partial patch to the user scope
 */
export function DockWidthSettings({
  view,
  lang,
  onSave,
}: {
  view: SettingsView;
  lang: Lang;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <div className="settings-label">{t(lang, "set.secDockWidth")}</div>
      <p className="settings-note">{t(lang, "set.dockWidthHint")}</p>
      <ReachBlock lang={lang} fields={["chatReserveWidth", "dockMaxWidth"]} note="set.dockWidthApplies">
        <div className="settings-grid">
          {FIELDS.map(([field, floor]) => (
            <label key={field} className="settings-field" data-dock-field={field}>
              <span>{t(lang, `set.${field}`)}</span>
              <input
                type="number"
                min={floor}
                value={px(view, field)}
                onChange={(e) => onSave({ [field]: Number(e.target.value) })}
              />
              <p className="settings-note">{t(lang, `set.${field}Note`)}</p>
              <OriginRow view={view} field={field} lang={lang} onReset={() => onSave({ [field]: null })} />
            </label>
          ))}
        </div>
      </ReachBlock>
    </>
  );
}
