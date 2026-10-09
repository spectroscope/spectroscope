// Card 466: the tool groups in the composer gear. One checkbox per group the
// server named, checked while the group is sent to the model; the hint under
// each lists the tools it holds in this session. The decisions live in
// state/toolGroups.ts; this file only draws them and reports a change.
//
// Card 491: the sentence under the list that says when a change acts comes
// from the reach table (settingsReach.tsx), where toolGroupsOff is next-run, so
// the gear and the config reference chapter say the same thing.

import { groupHint, toggleGroup, type ToolGroupsInfo } from "../state/toolGroups";
import { t, type Lang } from "../i18n/i18n";
import { ReachBlock } from "./settingsReach";

export function ToolGroupsSection({
  lang,
  info,
  saved,
  onChange,
}: {
  lang: Lang;
  /** Whether a change is also saved in the workspace's local file. Without a
   *  pinned folder it holds for this session only: the scope tag is absent
   *  and a line says the choice is not saved. */
  saved: boolean;
  /** The server's last tool_groups_info, or null before the first one. Its
   *  saveError, when present, is shown in the gear's error line. */
  info: ToolGroupsInfo | null;
  /** Called with the full switched-off list after one checkbox changed. */
  onChange: (off: string[]) => void;
}) {
  if (info === null) return null;
  const order = info.groups.map((group) => group.name);
  return (
    <div className="wsg-section wsg-tool-groups">
      <div className="wsg-section-head">
        <span>{t(lang, "wsg.tools.title")}</span>
        {saved && <span className="wsg-scope-tag">{t(lang, "wsg.local.scope")}</span>}
      </div>
      <p className="wsg-tool-groups-note">{t(lang, "wsg.tools.note")}</p>
      {!saved && <p className="wsg-tool-groups-note">{t(lang, "wsg.tools.unsaved")}</p>}
      {info.saveError !== undefined && (
        <p className="settings-error wsg-inline-error">
          {t(lang, "wsg.tools.saveFailed", { reason: info.saveError })}
        </p>
      )}
      <ul className="wsg-tool-group-list">
        {info.groups.map((group) => {
          const hint = groupHint(group);
          return (
            <li key={group.name} className="wsg-tool-group-row">
              <label className="wsg-tool-group-label">
                <input
                  type="checkbox"
                  data-group={group.name}
                  checked={!info.off.includes(group.name)}
                  onChange={() => onChange(toggleGroup(info.off, group.name, order))}
                />
                <span className="wsg-mode-body">
                  <span className="wsg-mode-name mono">{group.name}</span>
                  <span className="wsg-mode-hint mono" title={hint}>
                    {hint === "" ? t(lang, "wsg.tools.none") : hint}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <ReachBlock lang={lang} fields={["toolGroupsOff"]} />
    </div>
  );
}
