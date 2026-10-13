// Card 586: the compact run panel, a playbook or workflow run beside the chat.
//
// Top: the run's name, task, status and time, a picker when the session holds
// more than one run, and the wide or small button. Below: a strip with one
// mark per node of the forward path, decisions as diamonds. Below that: one
// card per entry in time order, then the nodes not entered yet. A card says
// who works on it with which model, what it reads ("in"), what it wrote
// ("out"), the files its agents changed, how many shell commands ran, and,
// while it runs, the last line its agents streamed. A press on a card jumps to
// the entry; a press on a path opens it.
//
// The run's state is UiState.runs (state/runView.ts). How a run ended comes
// from its run_end alone (runOutcome); a stored run without one says so.
// Styles: styles/run-panel.css, imported by app.css.

import { useEffect, useState } from "react";
import { useRunPick } from "../state/runPick";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  isUnfinished,
  runsTick,
  nodeStatuses,
  runOutcome,
  type RunEntry,
  type RunFile,
  type RunTrack,
} from "../state/runView";
import {
  changeWord,
  decisionText,
  durationText,
  entryDuration,
  statusMark,
  statusWord,
  whoText,
} from "./runPanelModel";

/** How many file rows a card shows before it counts the rest. */
const FILE_ROWS = 5;

export interface RunPanelProps {
  /** The runs of the session, oldest first. */
  runs: RunTrack[];
  /** Whether the session is live: a run without a run_end still runs. */
  live: boolean;
  /** Whether the panel takes the full width of the chat tab. */
  wide: boolean;
  onToggleWide: () => void;
  /** A card was pressed. */
  onJump: (entry: RunEntry) => void;
  /** A document or a file of a run was pressed. */
  onOpenPath: (run: RunTrack, path: string) => void;
}

/** The current time, read again every second while `ticking`. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

export function RunPanel({
  runs,
  live,
  wide,
  onToggleWide,
  onJump,
  onOpenPath,
}: RunPanelProps): React.JSX.Element {
  const lang = useLang();
  const [index, pick] = useRunPick(runs);
  const ticking = runsTick(runs, live);
  const now = useNow(ticking);
  if (runs.length === 0) return <div className="run-panel" />;

  const run = runs[index];
  const unfinished = isUnfinished(run, live);
  const statuses = nodeStatuses(run);
  const entered = new Set(run.entries.map((e) => e.node));

  const openPath = (path: string) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    onOpenPath(run, path);
  };

  const card = (e: RunEntry): ReactNode => {
    const open = e.status === "running" || e.status === "waiting";
    let time: string;
    if (open && unfinished) time = t(lang, "run.panel.unfinished");
    else if (e.status === "waiting") time = t(lang, "run.panel.waiting");
    else if (open) time = t(lang, "run.panel.running", { time: durationText(now - e.startedTs) });
    else time = durationText(entryDuration(e));
    const who = whoText(lang, e);
    const decision = decisionText(lang, e);
    const documented = new Set(e.documents.map((d) => d.path));
    const files = e.files.filter((f) => !documented.has(f.path));
    const onKeyDown = (ev: ReactKeyboardEvent): void => {
      if (ev.target !== ev.currentTarget) return;
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      onJump(e);
    };
    return (
      <li key={e.key}>
        <article
          className={`run-card run-card--${e.status}`}
          data-entry={e.key}
          role="button"
          tabIndex={0}
          onClick={() => onJump(e)}
          onKeyDown={onKeyDown}
        >
          <div className="run-card-head">
            <span className="run-mark" title={statusWord(lang, e.status)}>
              {statusMark(e.status, e.kind === "decision")}
            </span>
            <span className="run-card-name">{e.name}</span>
            <span className="run-card-time">{time}</span>
          </div>
          {who !== "" && <div className="run-card-who">{who}</div>}
          {decision !== null && <div className="run-card-decision">{decision}</div>}
          {e.reads.length > 0 && (
            <div className="run-card-row">
              <span className="run-card-label">{t(lang, "run.panel.in")}</span>
              {e.reads.map((r, i) =>
                r.path !== undefined ? (
                  <button
                    key={i}
                    type="button"
                    className="run-path"
                    title={r.path}
                    onClick={openPath(r.path)}
                  >
                    {r.doc}
                  </button>
                ) : (
                  <span key={i} className="run-doc">
                    {r.doc}
                  </span>
                ),
              )}
            </div>
          )}
          {e.documents.length > 0 && (
            <div className="run-card-row">
              <span className="run-card-label">{t(lang, "run.panel.out")}</span>
              {e.documents.map((d, i) => (
                <span key={i} className="run-out">
                  <button type="button" className="run-path" title={d.path} onClick={openPath(d.path)}>
                    {d.doc}
                  </button>
                  {change(lang, d.change)}
                </span>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <ul className="run-files">
              {files.slice(0, FILE_ROWS).map((f) => (
                <li key={f.path}>
                  <button type="button" className="run-path" onClick={openPath(f.path)}>
                    {f.path}
                  </button>
                  {change(lang, f.change)}
                </li>
              ))}
              {files.length > FILE_ROWS && (
                <li className="run-files-more">
                  {t(lang, "run.panel.more", { n: files.length - FILE_ROWS })}
                </li>
              )}
            </ul>
          )}
          {e.shellCalls > 0 && (
            <div className="run-card-shell">{t(lang, "run.panel.shell", { n: e.shellCalls })}</div>
          )}
          {e.error !== null && <div className="run-card-error">{e.error}</div>}
          {e.status === "running" && !unfinished && e.liveLine !== null && (
            <div className="run-card-live">{e.liveLine}</div>
          )}
        </article>
      </li>
    );
  };

  return (
    <div className={`run-panel${wide ? " run-panel--wide" : ""}`}>
      <RunHead
        runs={runs}
        index={index}
        live={live}
        now={now}
        wide={wide}
        onPick={pick}
        onToggleWide={onToggleWide}
      />
      <div className="run-strip">
        {run.nodes.map((n) => (
          <span
            key={n.id}
            className={`run-node run-node--${statuses[n.id]}`}
            title={`${n.name}: ${statusWord(lang, statuses[n.id])}`}
          >
            {statusMark(statuses[n.id], n.kind === "decision")}
          </span>
        ))}
      </div>
      <ol className="run-cards">
        {run.entries.map(card)}
        {run.nodes
          .filter((n) => !entered.has(n.id))
          .map((n) => (
            <li key={`node:${n.id}`} className={`run-ghost run-ghost--${statuses[n.id]}`} data-node={n.id}>
              <span className="run-mark">{statusMark(statuses[n.id], n.kind === "decision")}</span>
              <span className="run-card-name">{n.name}</span>
              {statuses[n.id] === "skipped" && (
                <span className="run-card-time">{t(lang, "run.panel.skipped")}</span>
              )}
            </li>
          ))}
      </ol>
    </div>
  );
}

export interface RunHeadProps {
  /** The runs of the session, oldest first; at least one. */
  runs: RunTrack[];
  /** The shown run. */
  index: number;
  live: boolean;
  /** The current time, for the running time. */
  now: number;
  wide: boolean;
  onPick: (index: number) => void;
  onToggleWide: () => void;
}

/**
 * The head of a run, shared by the panel and the wide view: the run's name, a
 * picker when the session holds more than one run, the wide or small button,
 * the task, and a status line with the running time or how the run ended.
 */
export function RunHead({
  runs,
  index,
  live,
  now,
  wide,
  onPick,
  onToggleWide,
}: RunHeadProps): React.JSX.Element {
  const lang = useLang();
  const run = runs[index];
  const unfinished = isUnfinished(run, live);
  let status: string;
  if (run.endedTs !== null) {
    const took = run.durationMs ?? run.endedTs - run.startedTs;
    status = t(lang, "run.panel.ended", {
      time: durationText(took),
      result: statusWord(lang, runOutcome(run)),
    });
  } else if (unfinished) {
    status = t(lang, "run.panel.unfinished");
  } else {
    status = t(lang, "run.panel.running", { time: durationText(now - run.startedTs) });
  }
  const runWaits = run.endedTs === null && !unfinished && run.waitingOn !== null;
  const outcome = unfinished ? "unfinished" : runOutcome(run);
  return (
    <header className="run-head">
      <div className="run-head-row">
        <h3 className="run-title">
          {t(lang, "run.panel.title", { name: run.name !== "" ? run.name : run.kind })}
        </h3>
        {runs.length > 1 && (
          <select
            className="run-picker"
            aria-label={t(lang, "run.panel.runs")}
            value={String(index)}
            onChange={(ev) => onPick(Number(ev.target.value))}
          >
            {runs.map((r, i) => (
              <option key={i} value={String(i)}>
                {`${i + 1}. ${r.name !== "" ? r.name : r.kind}`}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="run-wide" aria-pressed={wide} onClick={onToggleWide}>
          {wide ? t(lang, "run.panel.small") : t(lang, "run.panel.wide")}
        </button>
      </div>
      {run.task !== null && <p className="run-task">{run.task}</p>}
      <p className={`run-status run-status--${outcome}`}>
        {status}
        {runWaits && <span className="run-status-waiting">{t(lang, "run.panel.waiting")}</span>}
      </p>
    </header>
  );
}

/** The change word after a path, or nothing. */
function change(lang: Lang, c: RunFile["change"] | undefined): ReactNode {
  const word = changeWord(lang, c);
  return word === null ? null : <span className="run-change">{word}</span>;
}
