// Card 381: the one search field of the settings page, and what it finds.
//
// It stands ABOVE the room tabs, outside every room. That placement is the
// whole point and it is not cosmetic: the rooms are mounted and hidden rather
// than unmounted, so a box drawn inside one would be in the document at all
// times while being invisible five sixths of the time, which is exactly what
// the limits room's own box was.
//
// A result POINTS. It names the room and the section it lives in, and a click
// opens that room and scrolls to the anchor the deep link already uses. It
// does not hide the rest of the page: narrowing works on a list you can see
// and would mean hiding five rooms you cannot.

import { t, type Lang } from "../i18n/i18n";
import { settingsTabLabelKey } from "./settingsTabs";
import { settingsHitKindKey, type SettingsHit } from "./settingsSearch";

/** The box itself, plus the results under it. Stateless: the panel owns the
 *  query, because the limits list reads it too. */
export function SettingsSearch({
  lang,
  query,
  onQuery,
  hits,
  onPick,
}: {
  lang: Lang;
  query: string;
  onQuery: (next: string) => void;
  /** The matches, or null while the box is empty and nothing is being asked. */
  hits: SettingsHit[] | null;
  onPick: (hit: SettingsHit) => void;
}) {
  return (
    <div className="settings-search">
      <label className="settings-field settings-search-field">
        <span>{t(lang, "set.search")}</span>
        <input
          type="search"
          value={query}
          placeholder={t(lang, "set.searchHint")}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      {hits !== null && (
        <div className="settings-search-out">
          <p className="settings-note" aria-live="polite">
            {hits.length === 0 ? t(lang, "set.searchNone") : t(lang, "set.searchCount", { n: hits.length })}
          </p>
          {hits.length > 0 && (
            <ul className="settings-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button type="button" className="settings-hit" onClick={() => onPick(hit)}>
                    <span className="settings-hit-what">{hit.title}</span>
                    <span className="settings-hit-where">
                      {t(lang, settingsTabLabelKey(hit.tab))} · {hit.label}
                    </span>
                    <span className="settings-hit-kind">{t(lang, settingsHitKindKey(hit.origin))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
