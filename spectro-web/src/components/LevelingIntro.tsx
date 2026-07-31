// The one screen a fresh home sees before anything else: what the ladder is,
// and an actual choice.
//
// The concept's original plan was a silent ladder default. The owner overruled
// it after playing the prototype, and the reason holds up: a product that
// quietly hides its own surfaces has decided something on the user's behalf.
// Offering the ladder as the interesting path while putting "open everything"
// right next to it costs one screen and removes the whole class of complaint.
//
// Asked once per home. An existing home never sees it at all.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function LevelingIntro(props: { onChoose: (mode: "ladder" | "checklist") => void }) {
  const lang = useLang();
  return (
    <div className="lvl-intro-scrim">
      <div className="lvl-intro" role="dialog" aria-label={t(lang, "leveling.intro.title")}>
        <h2 className="lvl-intro__title">{t(lang, "leveling.intro.title")}</h2>
        <p className="lvl-intro__body">{t(lang, "leveling.intro.body")}</p>
        <p className="lvl-intro__body lvl-intro__body--dim">{t(lang, "leveling.intro.honest")}</p>
        <div className="lvl-intro__choice">
          <button
            type="button"
            className="lvl-intro__pick lvl-intro__pick--primary"
            onClick={() => props.onChoose("ladder")}
          >
            {t(lang, "leveling.intro.ladder")}
          </button>
          <button type="button" className="lvl-intro__pick" onClick={() => props.onChoose("checklist")}>
            {t(lang, "leveling.intro.everything")}
          </button>
        </div>
        <p className="lvl-intro__foot">{t(lang, "leveling.intro.foot")}</p>
      </div>
    </div>
  );
}
