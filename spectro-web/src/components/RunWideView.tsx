// Card 586: the wide view of a playbook or workflow run, in the chat's place.
//
// Top: the head of the run, as the panel has it, with "small" in place of
// "wide". Below: the run's graph. A playbook run draws its graph file in
// StateGraphView, with the names of its nodes on the cards; a workflow run has
// no graph file and draws its steps as a chain (RunChain). Below that: one
// entry in full. By default it is the current entry (the last open one, else
// the last); a pick of a node in the graph or the chain shows that node's
// latest entry, and a click on the empty canvas goes back to the default.
//
// The detail says who works on the entry with which model, what went in (the
// step's input text and the documents it reads), what came out (the output,
// the documents it wrote, the files its agents changed, the count of shell
// commands), the helpers of a fan-out, and for a decision its round and
// outcome. "In the chat" jumps to the entry.
//
// App shows the view while the layout's runWide is on, the dock shows the
// plan panel and the session has a run (state/layout.showsRunWide). It draws
// the graph with React Flow, so it loads from a chunk of its own
// (state/surfaceChunks.ts) and the entry stays without it. Styles:
// styles/run-panel.css.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  currentEntry,
  isUnfinished,
  runsTick,
  nodeStatuses,
  type RunEntry,
  type RunFile,
  type RunTrack,
} from "../state/runView";
import { useRunGraph } from "../state/useRunGraph";
import { StateGraphView } from "../stategraph/StateGraphView";
import { DEFAULT_VIEW, type StateGraphViewState } from "../stategraph/viewState";
import { RunChain } from "./RunChain";
import { RunHead, useNow } from "./RunPanel";
import { useRunPick } from "../state/runPick";
import {
  changeWord,
  decisionText,
  durationText,
  entryDuration,
  statusMark,
  statusWord,
  whoText,
} from "./runPanelModel";

export interface RunWideViewProps {
  /** The runs of the session, oldest first. */
  runs: RunTrack[];
  /** The session the runs belong to, for the graph file; null when it has none. */
  sessionId: string | null;
  /** Whether the session is live: a run without a run_end still runs. */
  live: boolean;
  /** "small": the chat comes back beside the panel. */
  onSmall: () => void;
  /** "In the chat" was pressed for the shown entry. */
  onJump: (entry: RunEntry) => void;
  /** A document or a file of the run was pressed. */
  onOpenPath: (run: RunTrack, path: string) => void;
}

/** The latest entry of a node, or null when the run never entered it. */
function latestEntryOf(run: RunTrack, node: string): RunEntry | null {
  for (let i = run.entries.length - 1; i >= 0; i--) {
    if (run.entries[i].node === node) return run.entries[i];
  }
  return null;
}

export function RunWideView({
  runs,
  sessionId,
  live,
  onSmall,
  onJump,
  onOpenPath,
}: RunWideViewProps): React.JSX.Element {
  const lang = useLang();
  const [index, pick] = useRunPick(runs);
  const ticking = runsTick(runs, live);
  const now = useNow(ticking);
  const run = runs.length > 0 ? runs[index] : null;
  const graph = useRunGraph(sessionId, run, live);
  // The pick and the graph's view belong to one run: another run shown in the
  // picker starts on its own default.
  const [picked, setPicked] = useState<{ runId: string; node: string } | null>(null);
  const [graphView, setGraphView] = useState<{ runId: string; view: StateGraphViewState } | null>(null);
  const nodes = run?.nodes;
  const nodeLabels = useMemo(
    () => Object.fromEntries((nodes ?? []).map((n) => [n.id, n.name])) as Record<string, string>,
    [nodes],
  );
  if (run === null) return <div className="run-wide-view" />;

  const selected = picked !== null && picked.runId === run.runId ? picked.node : null;
  const view: StateGraphViewState = {
    ...(graphView !== null && graphView.runId === run.runId ? graphView.view : DEFAULT_VIEW),
    picked: selected,
  };
  const entry = selected !== null ? latestEntryOf(run, selected) : currentEntry(run);
  const select = (node: string | null): void => setPicked(node === null ? null : { runId: run.runId, node });

  let area: ReactNode;
  if (run.kind !== "playbook") {
    area = <RunChain run={run} selected={selected} onSelect={select} />;
  } else if (graph === "") {
    area = <p className="run-wide-empty">{t(lang, "run.wide.noGraph")}</p>;
  } else {
    area = (
      <StateGraphView
        graphJsonl={graph}
        stateJsonl={null}
        source={run.runId}
        view={view}
        onView={(next) => {
          setGraphView({ runId: run.runId, view: next });
          select(next.picked);
        }}
        nodeLabels={nodeLabels}
        keys={false}
      />
    );
  }

  return (
    <div className="run-wide-view run-panel run-panel--wide">
      <RunHead
        runs={runs}
        index={index}
        live={live}
        now={now}
        wide={true}
        onPick={(i) => {
          pick(i);
          setPicked(null);
        }}
        onToggleWide={onSmall}
      />
      <div className={`run-wide-graph run-wide-graph--${run.kind === "playbook" ? "graph" : "chain"}`}>
        {area}
      </div>
      {entry !== null
        ? entryDetail({ lang, run, entry, now, unfinished: isUnfinished(run, live), onJump, onOpenPath })
        : selected !== null && nodeDetail(lang, run, selected)}
    </div>
  );
}

/**
 * One entry in full. A plain function, not a component: it holds no state,
 * and its elements are the view's own.
 */
function entryDetail({
  lang,
  run,
  entry: e,
  now,
  unfinished,
  onJump,
  onOpenPath,
}: {
  lang: Lang;
  run: RunTrack;
  entry: RunEntry;
  now: number;
  unfinished: boolean;
  onJump: (entry: RunEntry) => void;
  onOpenPath: (run: RunTrack, path: string) => void;
}): React.JSX.Element {
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
  const openPath = (path: string) => () => onOpenPath(run, path);
  const hasIn = e.input !== null || e.reads.length > 0;
  const hasOut = e.output !== null || e.documents.length > 0;
  const hasFiles = files.length > 0 || e.shellCalls > 0;

  return (
    <section className={`run-detail run-card--${e.status}`} data-entry={e.key}>
      <header className="run-detail-head">
        <span className="run-mark">{statusMark(e.status, e.kind === "decision")}</span>
        <h4 className="run-detail-name">{e.name}</h4>
        <span className="run-card-time">{time}</span>
        <button type="button" className="run-in-chat" onClick={() => onJump(e)}>
          {t(lang, "run.wide.inChat")}
        </button>
      </header>
      {decision !== null && <p className="run-card-decision">{decision}</p>}
      <dl className="run-detail-rows">
        {who !== "" && (
          <>
            <dt>{t(lang, "run.wide.who")}</dt>
            <dd>{who}</dd>
          </>
        )}
        {hasIn && (
          <>
            <dt>{t(lang, "run.wide.in")}</dt>
            <dd>
              {e.input !== null && cutText(e.input, e.inputChars, lang)}
              {e.reads.length > 0 && (
                <ul className="run-files">
                  {e.reads.map((r, i) => (
                    <li key={i}>
                      {r.path !== undefined ? (
                        <>
                          <button type="button" className="run-path" onClick={openPath(r.path)}>
                            {r.doc}
                          </button>
                          <span className="run-path-text">{r.path}</span>
                        </>
                      ) : (
                        <span className="run-doc">{r.doc}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </>
        )}
        {hasOut && (
          <>
            <dt>{t(lang, "run.wide.out")}</dt>
            <dd>
              {e.output !== null && cutText(e.output, e.outputChars, lang)}
              {e.documents.length > 0 && (
                <ul className="run-files">
                  {e.documents.map((d, i) => (
                    <li key={i}>
                      <button type="button" className="run-path" onClick={openPath(d.path)}>
                        {d.doc}
                      </button>
                      <span className="run-path-text">{d.path}</span>
                      {change(lang, d.change)}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </>
        )}
        {hasFiles && (
          <>
            <dt>{t(lang, "run.wide.files")}</dt>
            <dd>
              {files.length > 0 && (
                <ul className="run-files">
                  {files.map((f) => (
                    <li key={f.path}>
                      <button type="button" className="run-path" onClick={openPath(f.path)}>
                        {f.path}
                      </button>
                      {change(lang, f.change)}
                    </li>
                  ))}
                </ul>
              )}
              {e.shellCalls > 0 && (
                <p className="run-card-shell">{t(lang, "run.panel.shell", { n: e.shellCalls })}</p>
              )}
            </dd>
          </>
        )}
        {e.children.length > 0 && (
          <>
            <dt>{t(lang, "run.wide.helpers")}</dt>
            <dd>
              <ul className="run-helpers">
                {e.children.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {e.error !== null && <p className="run-card-error">{e.error}</p>}
      {e.status === "running" && !unfinished && e.liveLine !== null && (
        <p className="run-card-live">{e.liveLine}</p>
      )}
    </section>
  );
}

/** A picked node the run has not entered: its name and whether it waits or was skipped. */
function nodeDetail(lang: Lang, run: RunTrack, id: string): ReactNode {
  const node = run.nodes.find((n) => n.id === id);
  if (node === undefined) return null;
  const status = nodeStatuses(run)[id];
  return (
    <section className={`run-detail run-card--${status}`} data-node={id}>
      <header className="run-detail-head">
        <span className="run-mark">{statusMark(status, node.kind === "decision")}</span>
        <h4 className="run-detail-name">{node.name}</h4>
        <span className="run-card-time">{statusWord(lang, status)}</span>
      </header>
    </section>
  );
}

/** A step's input or output text, and how long it was when the event cut it. */
function cutText(text: string, chars: number | null, lang: Lang): React.JSX.Element {
  return (
    <>
      <pre className="run-text">{text}</pre>
      {chars !== null && chars > text.length && (
        <p className="run-text-cut">{t(lang, "run.wide.cut", { shown: text.length, total: chars })}</p>
      )}
    </>
  );
}

/** The change word after a path, or nothing. */
function change(lang: Lang, c: RunFile["change"] | undefined): ReactNode {
  const word = changeWord(lang, c);
  return word === null ? null : <span className="run-change">{word}</span>;
}
