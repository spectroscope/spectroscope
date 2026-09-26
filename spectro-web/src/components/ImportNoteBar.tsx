// The bar that says what an import opened (card 440). The sentence is for every
// reader; the importer's own numbers sit behind a native details control, which
// a keyboard and a touch screen can both open.
import { t, type Lang } from "../i18n/i18n";
import { importBarText, type ImportBarState } from "./importBar";

export function ImportNoteBar({
  lang,
  bar,
  onClose,
}: {
  lang: Lang;
  bar: ImportBarState;
  onClose: () => void;
}) {
  const text = importBarText(lang, bar);
  return (
    <div className="import-note-bar" role="status">
      <div className="import-note-text">
        <span>{text.said}</span>
        <details className="import-note-details">
          <summary>{t(lang, "imp.details")}</summary>
          <span>{text.details}</span>
        </details>
      </div>
      <button type="button" className="ghost" onClick={onClose}>
        {t(lang, "common.close")}
      </button>
    </div>
  );
}
