// Card 604: the files tab. One fold of the session's events (fold.ts) feeds a
// toolbar with the view switch and the summary line, an explorer of the files
// the run changed or read, and the detail of one call. Section 4 of the design
// (docs/superpowers/specs/2026-11-09-files-tab-design.md) is the authority.
//
// Everything a click changes is state of this component, set by the click's
// handler; nothing waits for an effect. The explorer and the detail keep no
// state of their own and take the language as a prop, so they run the same
// whether React mounts them or a test calls them.

import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { fileRows, foldFiles, summarize, type FileRow, type FilesSummary } from "./fold";
import "./files.css";

export interface FilesViewProps {
  viewKey: string;
  events: readonly RunEvent[];
  /** The event a route opened the tab at (App's filesFocus). */
  startAt: RunEvent | null;
  /** Clears App's filesFocus once the tab has taken it. */
  onStartHandled: () => void;
  /** App's focusInTrace. */
  onFocusEvent: (agentId: string, event: RunEvent) => void;
  /** Opens a path in the Files panel; null when the session has no folder. */
  onOpenPath: ((path: string) => void) | null;
}

export type FilesViewName = "all" | "diff" | "created" | "operations";
export type DiffStyle = "unified" | "split";

const VIEWS: readonly FilesViewName[] = ["all", "diff", "created", "operations"];
const STYLES: readonly DiffStyle[] = ["unified", "split"];

/** The call the detail shows, and the file it was reached through, if any. */
export interface FilesSelection {
  call: number | null; // callIndex of a FileCall
  path: string | null; // FileRow.path
}

const NOTHING: FilesSelection = { call: null, path: null };

export function FilesView(props: FilesViewProps): JSX.Element {
  const { viewKey, events, startAt, onStartHandled, onFocusEvent, onOpenPath } = props;
  const lang = useLang();
  const ledger = useMemo(() => foldFiles(events), [events]);
  const rows = useMemo(() => fileRows(ledger, null), [ledger]);
  const summary = useMemo(() => summarize(ledger, rows, null), [ledger, rows]);
  const [view, setView] = useState<FilesViewName>("all");
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [selection, setSelection] = useState<FilesSelection>(NOTHING);
  // Another session on screen starts with nothing selected.
  const [shownKey, setShownKey] = useState(viewKey);
  if (shownKey !== viewKey) {
    setShownKey(viewKey);
    setSelection(NOTHING);
  }
  // The event a route opened the tab at; the cursor starts there.
  const [start, setStart] = useState<RunEvent | null>(null);
  if (startAt !== null && startAt !== start) setStart(startAt);
  useEffect(() => {
    if (startAt !== null) onStartHandled();
  }, [startAt, onStartHandled]);

  if (ledger.calls.length === 0) {
    return (
      <div className="files-tab">
        <p className="files-empty">{t(lang, "filesTab.empty")}</p>
      </div>
    );
  }

  /** A press on a file: its latest change, or its latest touch when it was only read. */
  const selectRow = (row: FileRow): void => {
    const changes = row.touches.filter((touch) => touch.kind !== "read");
    const from = changes.length > 0 ? changes : row.touches;
    setSelection({ call: from[from.length - 1].callIndex, path: row.path });
  };

  return (
    <div className="files-tab" data-view={view}>
      <section className="files-toolbar">
        <div className="files-seg" role="group" aria-label={t(lang, "filesTab.view.aria")}>
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              data-action={`view-${v}`}
              aria-pressed={view === v}
              className={view === v ? "files-seg__btn files-seg__btn--on" : "files-seg__btn"}
              onClick={() => setView(v)}
            >
              {t(lang, `filesTab.view.${v}`)}
            </button>
          ))}
        </div>
        <div className="files-seg" role="group" aria-label={t(lang, "filesTab.style.aria")}>
          {STYLES.map((s) => (
            <button
              key={s}
              type="button"
              data-action={`style-${s}`}
              aria-pressed={diffStyle === s}
              className={diffStyle === s ? "files-seg__btn files-seg__btn--on" : "files-seg__btn"}
              onClick={() => setDiffStyle(s)}
            >
              {t(lang, `filesTab.style.${s}`)}
            </button>
          ))}
        </div>
        <p className="files-summary">{summaryLine(lang, summary)}</p>
      </section>
      {view === "created" || view === "operations" ? (
        <p className="files-soon">{t(lang, "filesTab.view.soon")}</p>
      ) : (
        <div className="files-panes">
          <FilesExplorer lang={lang} rows={rows} selected={selection.path} onSelect={selectRow} />
          <FilesDetail
            lang={lang}
            events={events}
            ledger={ledger}
            rows={rows}
            selection={selection}
            diffStyle={diffStyle}
            onSelect={setSelection}
            onFocusEvent={onFocusEvent}
            onOpenPath={onOpenPath}
          />
        </div>
      )}
    </div>
  );
}

/** The summary line: each count in bold inside its sentence part. */
function summaryLine(lang: Lang, s: FilesSummary): ReactNode[] {
  const parts: ReactNode[] = [
    bold(
      lang,
      s.recordedChanged === 1 ? "filesTab.summary.recordedOne" : "filesTab.summary.recorded",
      s.recordedChanged,
    ),
    " · ",
    bold(lang, "filesTab.summary.probable", s.probableChanged),
    " · ",
    bold(lang, "filesTab.summary.read", s.onlyRead),
    " · ",
    bold(lang, s.shellCalls === 1 ? "filesTab.summary.shellOne" : "filesTab.summary.shell", s.shellCalls),
  ];
  if (s.shellCalls > 0) parts.push(", ", bold(lang, "filesTab.summary.scripts", s.unknownScripts));
  return parts.map((part, i) => <span key={i}>{part}</span>);
}

/** A dictionary sentence with its `{n}` drawn in bold. */
function bold(lang: Lang, key: string, n: number): ReactNode {
  const [before, after = ""] = t(lang, key).split("{n}");
  return (
    <>
      {before}
      <b>{n}</b>
      {after}
    </>
  );
}
