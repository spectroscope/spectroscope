// Card 493: the Local mode switch, the first section of the composer gear.
// One switch; on, it opens the rows of the values it wrote for this chat.
// A row whose value differs from what Local mode writes says so and offers a
// reset. The decisions live in state/localMode.ts and on the server; this
// file draws them and reports a change.
//
// Card 600: below them, a switch of its own for toolResultElision, the tool
// results cache. It is not one of Local mode's rows: it writes the user
// settings and is drawn whether Local mode is on or off.

import { useState } from "react";
import {
  formatRowValue,
  parseRowInput,
  type LocalModeInfo,
  type LocalModeRow,
  type ToolUseAnswer,
} from "../state/localMode";
import { t, type Lang } from "../i18n/i18n";
import { ReachBlock } from "./settingsReach";
import { saveToolResultCache, type ToolResultCacheState } from "../state/toolResultCache";

/** The label and the note of each row, by key. A key the server adds later
 *  is drawn with its own name and no note. */
const ROWS: Record<string, { label: string; note: string }> = {
  sessionsPerChat: { label: "wsg.lm.sessions", note: "wsg.lm.sessionsNote" },
  toolGroupsOff: { label: "wsg.lm.toolGroups", note: "wsg.lm.toolGroupsNote" },
  readSharePercent: { label: "wsg.lm.readShare", note: "wsg.lm.readShareProposal" },
  careParagraph: { label: "wsg.lm.care", note: "wsg.lm.careNote" },
};

function presetText(row: LocalModeRow): string {
  return formatRowValue({ ...row, value: row.preset });
}

/** A number typed into a row, sent when the field is left or Enter pressed. */
function NumberControl({
  lang,
  row,
  suffix,
  onEdit,
}: {
  lang: Lang;
  row: LocalModeRow;
  suffix: string;
  onEdit: (key: string, value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? formatRowValue(row);
  const commit = (): void => {
    if (draft === null) return;
    const parsed = parseRowInput(draft, row.floor);
    if (!parsed.ok) {
      setProblem(t(lang, parsed.problem.key, parsed.problem.params));
      return;
    }
    setProblem(null);
    setDraft(null);
    if (String(parsed.value) !== formatRowValue(row)) onEdit(row.key, parsed.value);
  };
  return (
    <span className="wsg-lm-control">
      <input
        type="number"
        className="wsg-local-value-input mono wsg-lm-number"
        aria-label={t(lang, ROWS[row.key]?.label ?? row.key)}
        min={row.floor ?? undefined}
        step={1}
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value);
          setProblem(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      {suffix !== "" && <span className="wsg-lm-suffix">{suffix}</span>}
      {problem !== null && <span className="settings-error wsg-inline-error">{problem}</span>}
    </span>
  );
}

export function LocalModeSection({
  lang,
  info,
  toolUse,
  model,
  onSwitch,
  onEdit,
  onReset,
  cache,
}: {
  lang: Lang;
  /** The server's last local_mode_info, or null before the first one. */
  info: LocalModeInfo | null;
  /** Whether the chat's model can call tools, or null while unknown. */
  toolUse: ToolUseAnswer | null;
  /** The chat's model, named in the warning. */
  model: string;
  onSwitch: (on: boolean) => void;
  onEdit: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
  /** Card 600: the tool results cache switch, read by the gear when it opens. */
  cache?: ToolResultCacheState;
}) {
  if (info === null) return null;
  return (
    <div className="wsg-section wsg-local-mode" data-local-mode={info.on ? "on" : "off"}>
      <label className="wsg-lm-switch">
        <input
          type="checkbox"
          role="switch"
          checked={info.on}
          aria-label={t(lang, "wsg.lm.title")}
          onChange={(e) => onSwitch(e.target.checked)}
        />
        <span className="wsg-lm-title">{t(lang, "wsg.lm.title")}</span>
      </label>
      <p className="wsg-tool-groups-note">{t(lang, "wsg.lm.hint")}</p>
      {info.on && toolUse?.toolUse === "no" && (
        <p className="settings-error wsg-lm-warning" role="note">
          {t(lang, "wsg.lm.noTools", { model })}
        </p>
      )}
      {info.on && (
        <ul className="wsg-lm-rows">
          {info.rows.map((row) => {
            const labels = ROWS[row.key];
            return (
              <li key={row.key} className="wsg-lm-row" data-local-key={row.key}>
                <span className="wsg-lm-line">
                  <span className="wsg-lm-label">
                    {labels === undefined ? row.key : t(lang, labels.label)}
                  </span>
                  {row.key === "toolGroupsOff" ? (
                    <span className="mono wsg-lm-value">{formatRowValue(row)}</span>
                  ) : row.key === "careParagraph" ? (
                    <input
                      type="checkbox"
                      className="wsg-lm-care"
                      aria-label={t(lang, "wsg.lm.care")}
                      checked={row.value === "on"}
                      onChange={(e) => onEdit(row.key, e.target.checked ? "on" : "off")}
                    />
                  ) : (
                    <NumberControl
                      lang={lang}
                      row={row}
                      suffix={row.key === "readSharePercent" ? "%" : ""}
                      onEdit={onEdit}
                    />
                  )}
                </span>
                {labels !== undefined && (
                  <span className="wsg-mode-hint wsg-lm-note">{t(lang, labels.note)}</span>
                )}
                {row.changed && (
                  <span className="wsg-lm-changed-line">
                    <span className="wsg-lm-changed">
                      {t(lang, row.key === "toolGroupsOff" ? "wsg.lm.changedFromLocal" : "wsg.lm.changed")}
                    </span>
                    <button type="button" className="ghost wsg-lm-reset" onClick={() => onReset(row.key)}>
                      {t(lang, "wsg.lm.reset", { value: presetText(row) })}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {info.saveError !== undefined && (
        <p className="settings-error wsg-inline-error">
          {t(lang, "wsg.tools.saveFailed", { reason: info.saveError })}
        </p>
      )}
      {cache !== undefined && (
        <div className="wsg-lm-cache">
          <ReachBlock lang={lang} fields={["toolResultElision"]}>
            <label className="wsg-lm-switch">
              <input
                type="checkbox"
                role="switch"
                checked={cache.on}
                disabled={!cache.known}
                aria-label={t(lang, "wsg.lm.cacheTitle")}
                onChange={(e) => saveToolResultCache(e.target.checked, cache)}
              />
              <span className="wsg-lm-title">{t(lang, "wsg.lm.cacheTitle")}</span>
            </label>
            <p className="wsg-tool-groups-note">{t(lang, "wsg.lm.cacheNote")}</p>
            {cache.readError !== null && (
              <p className="settings-error wsg-inline-error">
                {t(lang, "wsg.lm.cacheReadFailed", { reason: cache.readError })}
              </p>
            )}
            {cache.error !== null && (
              <p className="settings-error wsg-inline-error">
                {t(lang, "wsg.tools.saveFailed", { reason: cache.error })}
              </p>
            )}
          </ReachBlock>
        </div>
      )}
    </div>
  );
}
