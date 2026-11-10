// Card 604: the files tab. One fold of the session's events (fold.ts) feeds a
// toolbar with the view switch, the agent chips and the summary line, a
// timeline with the tab's own cursor, an explorer of the files the run changed
// or read, and the detail of one call. Section 4 of the design
// (docs/superpowers/specs/2026-11-09-files-tab-design.md) is the authority.
//
// Everything a click, a key or a drag changes is state of this component, set
// by its handler; nothing a test needs waits for an effect. Only play runs on a
// timer. The explorer, the timeline and the detail keep no state of their own
// and take the language as a prop, so they run the same whether React mounts
// them or a test calls them.
//
// The cursor is the tab's own (C2): it never calls the session's stepper and
// never changes the route.
//
// Card 605: a Report button after the model controls opens the report sheet
// (FilesReportSheet.tsx) over the ledger the panes show. Closing the sheet
// returns the focus to the button.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { RunEvent } from "../events";
import { agentAccent } from "../format";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { DEFAULT_INTERVAL_MS } from "../state/stepper";
import { cursorLimit, FOLLOW, initialCursor, stepCall, whenLabel, type Cursor } from "./cursor";
import { FilesCreated } from "./FilesCreated";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { useShownLedger, type ReadingMode } from "./filesAnalysis";
import { FilesModelControls } from "./FilesModelControls";
import { FilesOperations, FilesOpList } from "./FilesOperations";
import { FilesReportSheet } from "./FilesReportSheet";
import { FilesTimeline, timelineAxis } from "./FilesTimeline";
import {
  fileRows,
  foldFiles,
  summarize,
  type FileCall,
  type FileLedger,
  type FileRow,
  type FilesSummary,
} from "./fold";
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
  /** The session's title, for the report; null when the session has none. */
  title: string | null;
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
const NO_AGENTS: ReadonlySet<string> = new Set();

/** The agents with file calls, in the order they first made one. */
function agentsOf(ledger: FileLedger): string[] {
  const seen = new Set<string>();
  for (const call of ledger.calls) seen.add(call.agentId);
  return [...seen];
}

/** The agents the chips leave on, or null for all of them. */
function shownAgents(agents: readonly string[], hidden: ReadonlySet<string>): ReadonlySet<string> | null {
  return hidden.size === 0 ? null : new Set(agents.filter((agent) => !hidden.has(agent)));
}

/**
 * The selection after a call is picked: the path given, else the path already
 * selected when the call touched it, else the call's first path.
 */
function selectionFor(call: FileCall, before: FilesSelection, path?: string | null): FilesSelection {
  if (path !== undefined && path !== null) return { call: call.callIndex, path };
  const keep = before.path !== null && call.touches.some((touch) => touch.path === before.path);
  return { call: call.callIndex, path: keep ? before.path : (call.touches[0]?.path ?? null) };
}

/** True while the focus is in a field, where the arrow keys move the caret. */
function typing(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (el === null || el === undefined) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

export function FilesView(props: FilesViewProps): JSX.Element {
  const { viewKey, events, startAt, onStartHandled, onFocusEvent, onOpenPath, title } = props;
  const lang = useLang();
  const heuristic = useMemo(() => foldFiles(events), [events]);
  // With a model's reading shown, the merged ledger replaces the heuristic one downstream.
  const [readingMode, setReadingMode] = useState<ReadingMode>("heuristic");
  const { ledger, analysis, modelShown } = useShownLedger(viewKey, heuristic, readingMode, events);
  const agents = useMemo(() => agentsOf(ledger), [ledger]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_AGENTS);
  const shown = useMemo(() => shownAgents(agents, hidden), [agents, hidden]);
  const rows = useMemo(() => fileRows(ledger, shown), [ledger, shown]);
  const summary = useMemo(() => summarize(ledger, rows, shown), [ledger, rows, shown]);
  const calls = useMemo(
    () => (shown === null ? ledger.calls : ledger.calls.filter((call) => shown.has(call.agentId))),
    [ledger, shown],
  );
  const axis = useMemo(() => timelineAxis(ledger, events), [ledger, events]);
  const [view, setView] = useState<FilesViewName>("all");
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [selection, setSelection] = useState<FilesSelection>(NOTHING);
  const [cursor, setCursor] = useState<Cursor>(FOLLOW);
  const [playing, setPlaying] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const reportButton = useRef<HTMLButtonElement>(null);
  // Another session on screen starts with nothing selected, every agent shown,
  // the cursor at its end and no report sheet.
  const [shownKey, setShownKey] = useState(viewKey);
  if (shownKey !== viewKey) {
    setShownKey(viewKey);
    setSelection(NOTHING);
    setHidden(NO_AGENTS);
    setCursor(FOLLOW);
    setPlaying(false);
    setReportOpen(false);
  }
  // The event a route opened the tab at places the cursor, once per route.
  const [taken, setTaken] = useState<RunEvent | null>(null);
  if (startAt !== taken) {
    setTaken(startAt);
    if (startAt !== null) setCursor(initialCursor(events, startAt));
  }
  useEffect(() => {
    if (startAt !== null) onStartHandled();
  }, [startAt, onStartHandled]);

  // Play: one call per tick at the transport's default pace. The timer reads
  // the latest render through a ref, so new events do not restart it.
  const latest = useRef({ calls, cursor, events, ledger, ordinals: axis.ordinals });
  useEffect(() => {
    latest.current = { calls, cursor, events, ledger, ordinals: axis.ordinals };
  });
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const now = latest.current;
      const next = stepCall(now.calls, now.cursor, now.events, 1);
      if (next === now.cursor || next.follow) {
        setPlaying(false);
        setCursor(FOLLOW);
        return;
      }
      const call = now.ledger.calls[(now.ordinals.get(next.at) ?? 0) - 1];
      if (call !== undefined) setSelection((before) => selectionFor(call, before));
      setCursor(next);
    }, DEFAULT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing]);

  if (ledger.calls.length === 0) {
    return (
      <div className="files-tab">
        <p className="files-empty">{t(lang, "filesTab.empty")}</p>
      </div>
    );
  }

  const limit = cursorLimit(cursor, events);
  const callAt = (callIndex: number): FileCall | undefined =>
    ledger.calls[(axis.ordinals.get(callIndex) ?? 0) - 1];

  /** A call picked on the timeline, in a list or by a key: selected, and the cursor stands on it. */
  const pickCall = (call: FileCall, path?: string | null): void => {
    setSelection((before) => selectionFor(call, before, path));
    setCursor({ follow: false, at: call.callIndex });
  };

  /** A press on a call's mark, row or card; it stops play. */
  const pickAt = (callIndex: number, path?: string | null): void => {
    const call = callAt(callIndex);
    if (call === undefined) return;
    setPlaying(false);
    pickCall(call, path);
  };

  /**
   * A press on a file: its latest change at or before the cursor, or its latest
   * touch there when it was only read; its first touch when the cursor has not
   * reached it yet. The cursor stays.
   */
  const selectRow = (row: FileRow): void => {
    const seen = row.touches.filter((touch) => touch.callIndex <= limit);
    const from = seen.length > 0 ? seen : row.touches.slice(0, 1);
    const changes = from.filter((touch) => touch.kind !== "read");
    const pick = changes.length > 0 ? changes : from;
    setSelection({ call: pick[pick.length - 1].callIndex, path: row.path });
  };

  /** Lets the selected file go; the call stays selected, so the detail keeps showing it. */
  const releasePath = (): void => setSelection((before) => ({ call: before.call, path: null }));

  /** The detail's change stepper: the cursor moves with the change it shows. */
  const selectFromDetail = (next: FilesSelection): void => {
    setSelection(next);
    if (next.call !== null) setCursor({ follow: false, at: next.call });
    setPlaying(false);
  };

  const place = (next: Cursor): void => {
    setPlaying(false);
    setCursor((before) => (!before.follow && !next.follow && before.at === next.at ? before : next));
  };

  const togglePlay = (): void => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // At the end there is nothing ahead, so play starts again at the first call.
    if (calls.length > 0 && (cursor.follow || stepCall(calls, cursor, events, 1) === cursor))
      pickCall(calls[0]);
    setPlaying(true);
  };

  const closeReport = (): void => {
    setReportOpen(false);
    reportButton.current?.focus();
  };

  const toggleAgent = (agent: string): void =>
    setHidden((before) => {
      const next = new Set(before);
      if (before.has(agent)) next.delete(agent);
      // The last agent shown stays on, so the tab never filters itself empty.
      else if (agents.every((other) => other === agent || before.has(other))) return before;
      else next.add(agent);
      return next;
    });

  /** ArrowLeft and ArrowRight step through the calls the chips leave on, from the selection while the cursor follows. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const from: Cursor =
      cursor.follow && selection.call !== null ? { follow: false, at: selection.call } : cursor;
    const next = stepCall(calls, from, events, e.key === "ArrowRight" ? 1 : -1);
    if (next === from || next.follow) return;
    const call = callAt(next.at);
    if (call === undefined) return;
    e.preventDefault();
    setPlaying(false);
    pickCall(call);
  };

  const listProps = {
    lang,
    ledger,
    calls,
    ordinals: axis.ordinals,
    limit,
    selection,
    agents: agents.length > 1,
    onPick: pickAt,
  };
  const detail = (pickKey?: string): JSX.Element => (
    <FilesDetail
      lang={lang}
      events={events}
      ledger={ledger}
      rows={rows}
      selection={selection}
      diffStyle={diffStyle}
      limit={limit}
      onSelect={selectFromDetail}
      onFocusEvent={onFocusEvent}
      onOpenPath={onOpenPath}
      pickKey={pickKey}
    />
  );

  return (
    <div className="files-tab" data-view={view} tabIndex={0} onKeyDown={onKeyDown}>
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
        {agents.length > 1 && (
          <div className="files-chips" role="group" aria-label={t(lang, "filesTab.agents.aria")}>
            {agents.map((agent) => {
              const on = !hidden.has(agent);
              return (
                <button
                  key={agent}
                  type="button"
                  data-agent={agent}
                  aria-pressed={on}
                  className={on ? "files-chip files-chip--on" : "files-chip"}
                  style={{ "--files-agent": agentAccent(agent) } as CSSProperties}
                  onClick={() => toggleAgent(agent)}
                >
                  <span className="files-chip__dot" aria-hidden="true" />
                  {agent}
                </button>
              );
            })}
          </div>
        )}
        <FilesModelControls
          lang={lang}
          viewKey={viewKey}
          mode={readingMode}
          onMode={setReadingMode}
          events={events}
          ledger={heuristic}
          analysis={analysis}
        />
        <button
          type="button"
          ref={reportButton}
          className="files-report__open"
          data-action="report"
          aria-haspopup="dialog"
          aria-expanded={reportOpen}
          onClick={() => setReportOpen(true)}
        >
          {t(lang, "filesTab.report.button")}
        </button>
        {reportOpen && (
          <FilesReportSheet
            lang={lang}
            events={events}
            ledger={ledger}
            sessionId={viewKey}
            title={title}
            onClose={closeReport}
          />
        )}
        <p className="files-summary">{summaryLine(lang, summary, modelShown)}</p>
      </section>
      <FilesTimeline
        lang={lang}
        ledger={ledger}
        events={events}
        axis={axis}
        rows={rows}
        calls={calls}
        cursor={cursor}
        playing={playing}
        selection={selection}
        onPick={pickAt}
        onSelectRow={selectRow}
        onCursor={place}
        onPlay={togglePlay}
        onFollow={() => {
          setPlaying(false);
          setCursor(FOLLOW);
        }}
      />
      {view === "created" ? (
        <FilesCreated
          lang={lang}
          ledger={ledger}
          rows={rows}
          ordinals={axis.ordinals}
          limit={limit}
          onShowInDiff={(callIndex, path) => {
            setView("diff");
            pickAt(callIndex, path);
          }}
        />
      ) : view === "operations" ? (
        <div className="files-stage">
          <FilesOperations {...listProps} />
          {detail("filesTab.detail.pickCall")}
        </div>
      ) : (
        <div className={view === "all" ? "files-panes files-panes--three" : "files-panes"}>
          <FilesExplorer
            lang={lang}
            rows={rows}
            selected={selection.path}
            limit={limit}
            firstSeen={(row) => whenLabel(lang, row.firstT, axis.ordinals.get(row.firstCall) ?? 0)}
            onSelect={(row) => (row.path === selection.path ? releasePath() : selectRow(row))}
          />
          {view === "all" && <FilesOpList {...listProps} rows={rows} onShowAll={releasePath} />}
          {detail()}
        </div>
      )}
    </div>
  );
}

/** The summary line: each count in bold inside its sentence part. */
function summaryLine(lang: Lang, s: FilesSummary, modelShown: boolean): ReactNode[] {
  const parts: ReactNode[] = [
    bold(
      lang,
      s.recordedChanged === 1 ? "filesTab.summary.recordedOne" : "filesTab.summary.recorded",
      s.recordedChanged,
    ),
    " · ",
    bold(
      lang,
      modelShown ? "filesTab.summary.probableModel" : "filesTab.summary.probable",
      s.probableChanged,
    ),
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
