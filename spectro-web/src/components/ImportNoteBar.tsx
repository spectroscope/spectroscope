// The bar that says what an import opened (card 440). The sentence is for every
// reader; the importer's own numbers sit behind a native details control, which
// a keyboard and a touch screen can both open. A Copilot events.jsonl that
// arrived without its folder gets a button that opens the folder picker (card
// 605, task 12); the picked files go to whoever opens the import dialog.
import { useRef, type ChangeEvent } from "react";
import { t, type Lang } from "../i18n/i18n";
import { importBarText, type ImportBarState } from "./importBar";

export function ImportNoteBar({
  lang,
  bar,
  onClose,
  onPickFolder,
}: {
  lang: Lang;
  bar: ImportBarState;
  onClose: () => void;
  /** The files of the folder the person picked from the bar. */
  onPickFolder?: (files: File[]) => void;
}) {
  const text = importBarText(lang, bar);
  const dirRef = useRef<HTMLInputElement>(null);
  const folder = bar.copilotFolder !== undefined && onPickFolder !== undefined;
  const onFolder = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    // The same folder twice must fire twice: a file input keeps its value.
    e.target.value = "";
    if (files.length > 0) onPickFolder?.(files);
  };
  return (
    <div className="import-note-bar" role="status">
      <div className="import-note-text">
        <span>{text.said}</span>
        <details className="import-note-details">
          <summary>{t(lang, "imp.details")}</summary>
          <span>{text.details}</span>
        </details>
      </div>
      {folder && (
        <>
          {/* webkitdirectory is not in React's input typing; the spread puts
              the attribute on the element without claiming it is. */}
          <input
            ref={dirRef}
            type="file"
            hidden
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={onFolder}
          />
          <button type="button" className="ghost" onClick={() => dirRef.current?.click()}>
            {t(lang, "imp.copilot.pickFolder")}
          </button>
        </>
      )}
      <button type="button" className="ghost" onClick={onClose}>
        {t(lang, "common.close")}
      </button>
    </div>
  );
}
