// Card 605: the sheet behind the files tab's Report button (design section 6).
// It shows the session's verdict level and sentence, and three outputs of one
// report: PDF through the print dialog of a hidden frame, the way
// components/ExportDialog.tsx prints, and HTML and CSV through saveTextFile.
// The report covers the whole session; the tab's filters do not apply (R6).
//
// The report is built once, from the events and the ledger the sheet opened
// with. The build takes about 300 ms on the largest real session, so the sheet
// shows first and builds after it was painted. The version line comes from
// GET /api/bundles, asked once. Both run in openReportSheet, which the
// container starts from an effect and a test can call by hand; the panel
// keeps no state of its own besides the print frame.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { releaseVersion } from "../components/about";
import type { RunEvent } from "../events";
import { saveTextFile } from "../export/save";
import { t, type Lang } from "../i18n/i18n";
import type { FileLedger } from "./fold";
import { buildReport, type FilesReport } from "./report";
import { reportCsv } from "./reportCsv";
import { reportFilename, reportHtml, verdictLine } from "./reportHtml";

export interface FilesReportSheetProps {
  lang: Lang;
  events: readonly RunEvent[];
  /** The ledger the tab shows: the merged one while a model reading is on screen. */
  ledger: FileLedger;
  /** The tab's viewKey. */
  sessionId: string;
  title: string | null;
  onClose: () => void;
  /** The server's release version; GET /api/bundles unless a test hands its own. */
  loadVersion?: () => Promise<string | null>;
}

/** The built report, or "failed" when the build threw. */
export type SheetReport = FilesReport | "failed";

const HTML_MIME = "text/html;charset=utf-8";
const CSV_MIME = "text/csv;charset=utf-8";
const OUTPUTS = ["pdf", "html", "csv"] as const;
/** A window that paints no frames still builds, after this long. */
const NO_FRAME_MS = 250;

/** GET /api/bundles, read with releaseVersion; null when the server does not say. */
export function fetchReportVersion(): Promise<string | null> {
  return fetch("/api/bundles")
    .then((r) => (r.ok ? r.json() : null))
    .then((c: unknown) => releaseVersion((c as { version?: unknown } | null)?.version))
    .catch(() => null);
}

/** Runs `job` once after the next paint: a frame, then a task; a timer covers a window without frames. */
function afterPaint(job: () => void): () => void {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    job();
  };
  const frame = window.requestAnimationFrame(() => window.setTimeout(once, 0));
  const timer = window.setTimeout(once, NO_FRAME_MS);
  return () => {
    done = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

/**
 * What the sheet starts when it opens: one version request and one deferred
 * build. `land` gets the report once it is built, and again with the version
 * when that arrives later. Nothing lands after the returned stop.
 *
 * @param build       builds the report, without a version
 * @param loadVersion the server's version, or null
 * @param land        receives the report to show
 * @param defer       schedules the build after the sheet was painted
 * @return stops both
 */
export function openReportSheet(
  build: () => FilesReport,
  loadVersion: () => Promise<string | null>,
  land: (report: SheetReport) => void,
  defer: (job: () => void) => () => void = afterPaint,
): () => void {
  let live = true;
  let built: FilesReport | null = null;
  let version: string | null = null;
  const show = (): void => {
    if (live && built !== null) land(version === null ? built : { ...built, version });
  };
  loadVersion().then(
    (v) => {
      version = v;
      show();
    },
    () => {},
  );
  const cancel = defer(() => {
    if (!live) return;
    try {
      built = build();
    } catch {
      land("failed");
      return;
    }
    show();
  });
  return () => {
    live = false;
    cancel();
  };
}

export function FilesReportSheet(props: FilesReportSheetProps): JSX.Element {
  const { lang, onClose } = props;
  // What the sheet opened with; it does not rebuild while open.
  const [opened] = useState(() => ({
    input: {
      events: props.events,
      ledger: props.ledger,
      sessionId: props.sessionId,
      title: props.title,
      version: null,
      now: Date.now(),
    },
    loadVersion: props.loadVersion ?? fetchReportVersion,
  }));
  const [report, setReport] = useState<SheetReport | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);
  useEffect(() => openReportSheet(() => buildReport(opened.input), opened.loadVersion, setReport), [opened]);
  return overlay(<ReportSheetPanel lang={lang} report={report} dialogRef={dialog} onClose={onClose} />);
}

export interface ReportSheetPanelProps {
  lang: Lang;
  /** null while the report builds. */
  report: SheetReport | null;
  dialogRef?: Ref<HTMLDivElement>;
  onClose: () => void;
}

export function ReportSheetPanel(props: ReportSheetPanelProps): JSX.Element {
  const { lang, report, onClose } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = report === null || report === "failed" ? null : report;

  const save = (ext: "html" | "csv"): void => {
    if (ready === null) return;
    const name = reportFilename(ext, ready.title, ready.exportedAt);
    if (ext === "html") saveTextFile(name, reportHtml(ready, lang), HTML_MIME);
    else saveTextFile(name, reportCsv(ready, lang), CSV_MIME);
  };

  // As ExportDialog prints: the document into a sandboxed frame, the dialog once it loaded.
  const print = (): void => {
    const el = frame.current;
    if (ready === null || el === null) return;
    el.onload = () => {
      el.contentWindow?.focus();
      el.contentWindow?.print();
    };
    el.srcdoc = reportHtml(ready, lang);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The tab's arrow keys step through calls; inside the sheet they belong to the sheet.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // The focus stays inside: Tab and Shift+Tab cycle the buttons that can take it.
    e.preventDefault();
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (buttons.length === 0) return;
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    const next =
      at < 0
        ? e.shiftKey
          ? buttons.length - 1
          : 0
        : (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  let verdict: JSX.Element;
  if (ready === null) {
    verdict = (
      <div className="files-report__verdict" role="status">
        <p className="files-report__line">
          {t(lang, report === "failed" ? "filesTab.report.failed" : "filesTab.report.building")}
        </p>
      </div>
    );
  } else {
    verdict = (
      <div
        className={`files-report__verdict files-report__verdict--${ready.verdict}`}
        data-level={ready.verdict}
      >
        <span className={`files-report__level files-report__level--${ready.verdict}`}>
          {t(lang, `filesTab.report.level.${ready.verdict}`)}
        </span>
        <p className="files-report__line">{verdictLine(ready, lang)}</p>
      </div>
    );
  }

  return (
    <div className="km-backdrop" onClick={onClose} role="presentation">
      <div
        className="km-panel files-report"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "filesTab.report.title")}
        tabIndex={-1}
        ref={props.dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="km-head">
          <span className="km-title">{t(lang, "filesTab.report.title")}</span>
          <button
            type="button"
            className="km-close"
            data-action="report-close"
            onClick={onClose}
            aria-label={t(lang, "common.close")}
          >
            ×
          </button>
        </div>
        {verdict}
        <div className="files-report__actions">
          {OUTPUTS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="files-report__btn"
              data-action={`report-${kind}`}
              disabled={ready === null}
              onClick={() => (kind === "pdf" ? print() : save(kind))}
            >
              {t(lang, `filesTab.report.${kind}`)}
            </button>
          ))}
        </div>
        <p className="ob-foot-note">{t(lang, "filesTab.report.pdfNote")}</p>
        <p className="ob-foot-note">{t(lang, "filesTab.report.scope")}</p>
        {/* allow-modals lets the sandboxed frame open the print dialog, same-origin
            lets this window call into it. Scripts stay off. */}
        <iframe
          className="files-report__frame"
          ref={frame}
          sandbox="allow-same-origin allow-modals"
          title={t(lang, "filesTab.report.frame")}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/** The sheet over the whole app; inline where there is no document, as on the server renderer the tests use. */
function overlay(sheet: JSX.Element): JSX.Element {
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
