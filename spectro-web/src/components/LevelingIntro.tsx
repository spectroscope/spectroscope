// The one screen a fresh home sees before anything else: what the ladder is,
// and an actual choice.
//
// The concept's original plan was a silent ladder default. The owner overruled
// it after playing the prototype, and the reason holds up: a product that
// quietly hides its own surfaces has decided something on the user's behalf.
// Offering the ladder as the interesting path while putting "open everything"
// right next to it costs one screen and removes the whole class of complaint.
//
// Card 387 widened it from two answers to three. The mode has carried three
// values since the ladder shipped; only this screen was built with two, so
// "open everything and keep the tutorial away" wrote checklist, kept the pill
// in the tab bar, and sent the reader into the settings for the other half of
// their own answer. The buttons are now drawn from the mode list itself, so
// this file names no mode: a screen that types its own subset of a list is how
// the narrow callback got here in the first place.
//
// Asked once per home. An existing home never sees it at all.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { LEVELING_MODES, SUGGESTED_MODE, type LevelingMode } from "../state/leveling";

export function LevelingIntro(props: { onChoose: (mode: LevelingMode) => void }) {
  const lang = useLang();
  return (
    <div className="lvl-intro-scrim">
      <div className="lvl-intro" role="dialog" aria-label={t(lang, "leveling.intro.title")}>
        <h2 className="lvl-intro__title">{t(lang, "leveling.intro.title")}</h2>
        <p className="lvl-intro__body">{t(lang, "leveling.intro.body")}</p>
        <p className="lvl-intro__body lvl-intro__body--dim">{t(lang, "leveling.intro.honest")}</p>
        <div className="lvl-intro__choice">
          {LEVELING_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-mode={mode}
              className={
                mode === SUGGESTED_MODE ? "lvl-intro__pick lvl-intro__pick--primary" : "lvl-intro__pick"
              }
              onClick={() => props.onChoose(mode)}
            >
              <span className="lvl-intro__pick-name">{t(lang, `leveling.intro.${mode}`)}</span>
              <span className="lvl-intro__pick-hint">{t(lang, `leveling.intro.${mode}.hint`)}</span>
            </button>
          ))}
        </div>
        <p className="lvl-intro__foot">{t(lang, "leveling.intro.foot")}</p>
      </div>
    </div>
  );
}
