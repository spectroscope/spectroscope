// The built-in model's first-use notice (card 91): an honest, one-time sheet
// the moment spectro-local becomes the active backend. VibeThinker-3B is a
// small bundled REASONING model — great for trying the mechanics, not meant
// for real work; the copy says exactly that. Reuses the onboarding sheet's
// km-/ob- vocabulary. Escape and the backdrop dismiss WITHOUT setting the
// flag (only "got it" does — an accidental Escape must not eat the one-time
// tutorial moment).

import { useEffect } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function LocalModelNotice(props: { onGotIt: () => void; onClose: () => void }) {
  const lang = useLang();
  const { onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="km-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="km-panel ob-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "lmn.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="km-head">
          <span className="km-title">{t(lang, "lmn.title")}</span>
          <button
            type="button"
            className="km-close"
            onClick={props.onClose}
            aria-label={t(lang, "common.close")}
          >
            ×
          </button>
        </div>

        <p className="ob-intro">{t(lang, "lmn.lede")}</p>

        <ul className="ob-opts">
          <li className="ob-opt">
            <div className="ob-opt-head">
              <span className="ob-opt-badge mono">demo</span>
              <span className="ob-opt-title">{t(lang, "lmn.goodTitle")}</span>
            </div>
            <p className="ob-opt-body">{t(lang, "lmn.good")}</p>
          </li>
          <li className="ob-opt">
            <div className="ob-opt-head">
              <span className="ob-opt-badge mono">limits</span>
              <span className="ob-opt-title">{t(lang, "lmn.limitsTitle")}</span>
            </div>
            <p className="ob-opt-body">{t(lang, "lmn.limits")}</p>
          </li>
        </ul>

        <div className="ob-foot">
          <span className="ob-foot-note">{t(lang, "lmn.real")}</span>
          <button type="button" className="primary" onClick={props.onGotIt}>
            {t(lang, "lmn.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}
