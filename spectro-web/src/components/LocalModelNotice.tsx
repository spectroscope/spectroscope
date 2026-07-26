// The built-in model's first-use notice (card 91): an honest, one-time sheet
// the moment spectro-local becomes the active backend. Since the catalogue the
// claims are PER MODEL — a tool-capable Qwen must not be introduced with the
// old "no tools" line, and the reasoning specialist must not promise tools.
// Reuses the onboarding sheet's km-/ob- vocabulary. Escape and the backdrop
// dismiss WITHOUT setting the flag (only "got it" does — an accidental Escape
// must not eat the one-time tutorial moment).

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { fetchLocalCatalog, type CatalogModel } from "../state/localModel";

export function LocalModelNotice(props: {
  /** The active model id from provider_info — decides which claims are true. */
  model?: string;
  onGotIt: () => void;
  onClose: () => void;
}) {
  const lang = useLang();
  const { onClose } = props;
  const [entry, setEntry] = useState<CatalogModel | null>(null);

  // One catalogue fetch names the model and its capabilities. Until it lands
  // (or if it fails) the sheet stays generic rather than guessing wrong.
  useEffect(() => {
    let alive = true;
    void fetchLocalCatalog().then(
      (c) => {
        if (!alive) return;
        setEntry(c.models.find((m) => m.id === props.model) ?? null);
      },
      () => {
        /* generic copy is the honest fallback */
      },
    );
    return () => {
      alive = false;
    };
  }, [props.model]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label = entry?.label ?? props.model ?? "";
  // Without a catalogue entry we do not know whether this model calls tools, and
  // the no-tools line would be a false claim about four of the five. Fall back to
  // what is true of every local model in these sizes.
  const limitsKey = !entry
    ? "lmn.limits.generic"
    : entry.nativeTools
      ? "lmn.limits.local"
      : "lmn.limits.noTools";

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

        <p className="ob-intro">{t(lang, "lmn.lede", { model: label })}</p>

        <ul className="ob-opts">
          <li className="ob-opt">
            <div className="ob-opt-head">
              <span className="ob-opt-badge mono">local</span>
              <span className="ob-opt-title">{t(lang, "lmn.goodTitle")}</span>
            </div>
            <p className="ob-opt-body">
              {entry ? t(lang, `local.model.${entry.id}.goodFor`) : t(lang, "lm.intro")}
            </p>
          </li>
          <li className="ob-opt">
            <div className="ob-opt-head">
              <span className="ob-opt-badge mono">limits</span>
              <span className="ob-opt-title">{t(lang, "lmn.limitsTitle")}</span>
            </div>
            <p className="ob-opt-body">{t(lang, limitsKey)}</p>
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
