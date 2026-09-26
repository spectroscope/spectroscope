// Card 379: the rtk switch, the last section of the chat settings.
//
// The owner asked for it "unten in den chat einstellungen": the composer's
// settings menu, at the bottom. DisclosureMenu mounts this as its last section
// and nowhere else; the icon row under the field gets no rtk control (card 383
// counts that row).
//
// It is the first section of that menu that writes a SERVER setting. Every
// other section persists to localStorage, so this one carries a reach sentence
// and saves through the settings API, and the walker in settingsReach.test.tsx
// reads this file because it renders a reach block.
//
// When rtk does not resolve where the agent's shell looks, the section stays,
// the row is disabled, and the hint says what the server does then: every
// shell line runs as the model wrote it and no call fails for it
// (RtkFilter.apply returns the line unchanged when the oracle has no answer).

import { ReachBlock } from "./settingsReach";
import { putSettings } from "../state/serverSettings";
import { t, type Lang } from "../i18n/i18n";
import { rtkNextValue, type RtkFilterState } from "../state/rtkFilter";

export interface RtkFilterSectionProps {
  lang: Lang;
  /** What the row draws, from useRtkFilter. */
  rtk: RtkFilterState;
}

export function RtkFilterSection({ lang, rtk }: RtkFilterSectionProps) {
  const hint = !rtk.available ? "rtk.missing" : rtk.on ? "rtk.on.hint" : "rtk.off.hint";
  return (
    <div className="wsg-section">
      <div className="wsg-section-head">
        <span>{t(lang, "rtk.title")}</span>
        {rtk.available && rtk.version !== "" && (
          <span className="wsg-version">{t(lang, "rtk.version", { v: rtk.version })}</span>
        )}
      </div>
      <ReachBlock lang={lang} fields={["rtkFilter"]}>
        <div className="wsg-modes" role="group" aria-label={t(lang, "rtk.title")}>
          <div
            role="menuitemcheckbox"
            aria-checked={rtk.on}
            aria-disabled={!rtk.available}
            className={`wsg-mode-row${rtk.on ? " wsg-mode-row--active" : ""}${
              rtk.available ? "" : " wsg-mode-row--disabled"
            }`}
            onClick={() => {
              const next = rtkNextValue(rtk);
              if (next === null) return;
              rtk.setOn(next === "on");
              rtk.setError(null);
              void putSettings("user", { rtkFilter: next }).catch((e: unknown) => {
                rtk.setOn(next !== "on");
                rtk.setError(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            <span className="wsg-mode-marker" aria-hidden="true">
              {rtk.on ? "›" : ""}
            </span>
            <span className="wsg-mode-body">
              <span className="wsg-mode-name mono">{t(lang, rtk.on ? "rtk.on" : "rtk.off")}</span>
              <span className="wsg-mode-hint">{t(lang, hint)}</span>
            </span>
          </div>
        </div>
        {rtk.available && <p className="settings-note">{t(lang, "rtk.warning")}</p>}
        {rtk.error !== null && <p className="settings-note">{t(lang, "rtk.saveFailed", { e: rtk.error })}</p>}
      </ReachBlock>
    </div>
  );
}
