// The state graph's export affordance: one button in the header row, the house
// export sheet behind it (ExportDialog's xd- chrome, no second idiom), two
// files out of it — the drawing as a self-contained SVG and the run summary as
// Markdown, both leaving through the shared saver.
//
// No preview pane on purpose: the sheet's other host previews a DOCUMENT whose
// options change what it says. Here each file is total — the drawing on screen
// IS the preview — and an iframe repeating it would be furniture.

import { useEffect, useState } from "react";
import type { StateGraphLayout } from "./layout";
import type { StateGraphRun } from "./artifact";
import { stateGraphSvg } from "./exportSvg";
import { stateGraphMarkdown } from "./exportMd";
import { saveTextFile } from "../export/save";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import "../styles/export-dialog.css";

/** The artifact's stem, which names both files: `crag-payload.graph.jsonl`
 *  exports as `crag-payload.svg` and `crag-payload.md`. */
export function exportStem(source: string): string {
  return source
    .replace(/\.(graph|state)\.jsonl$/, "")
    .replace(/\.jsonl$/, "")
    .replace(/\.json$/, "");
}

export interface StateGraphExportProps {
  run: StateGraphRun;
  /** The layout on screen — its orientation is the file's orientation. */
  laid: StateGraphLayout;
  /** The record the transport stands on; the SVG draws THAT moment. */
  upto: number;
  source: string;
}

export function StateGraphExport({ run, laid, upto, source }: StateGraphExportProps) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const stem = exportStem(source);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const saveSvg = (): void => {
    saveTextFile(`${stem}.svg`, stateGraphSvg({ run, laid, upto, source }), "image/svg+xml;charset=utf-8");
    setOpen(false);
  };

  const saveMd = (): void => {
    saveTextFile(
      `${stem}.md`,
      stateGraphMarkdown({ run, laid, source, lang }),
      "text/markdown;charset=utf-8",
    );
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t(lang, "exp.title")}
        onClick={() => setOpen(true)}
      >
        {t(lang, "exp.button")}
      </button>

      {open && (
        <div className="xd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="xd-modal" role="dialog" aria-modal="true" aria-label={t(lang, "exp.title")}>
            <div className="xd-head">
              <h2 className="xd-title">{t(lang, "exp.button")}</h2>
              <span className="xd-sub">{source}</span>
              <button type="button" className="xd-close" onClick={() => setOpen(false)}>
                {t(lang, "sg.export.close")}
              </button>
            </div>
            <div className="xd-options">
              <div className="xd-group">
                <p className="xd-legend">{t(lang, "sg.export.svg")}</p>
                <p className="xd-hint">{t(lang, "sg.export.svgHint")}</p>
                <div className="xd-actions">
                  <button type="button" onClick={saveSvg}>
                    {t(lang, "sg.export.download")} · {stem}.svg
                  </button>
                </div>
              </div>
              <div className="xd-group">
                <p className="xd-legend">{t(lang, "sg.export.md")}</p>
                <p className="xd-hint">{t(lang, "sg.export.mdHint")}</p>
                <div className="xd-actions">
                  <button type="button" onClick={saveMd}>
                    {t(lang, "sg.export.download")} · {stem}.md
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
