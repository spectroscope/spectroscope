// The state graph as a top-level view: a third one beside agents and fleets,
// not a tab inside a session. A session's "graph" tab draws what a run DID; this
// draws what a StateGraph IS, and the two answer different questions.
//
// The pane decides what a file pick MEANS; App holds which pair of artifacts is
// on screen. Reading them is artifact.ts's job and drawing them is
// StateGraphView's.
//
// That one fact sits in App and not here because App unmounts this arm the
// moment `nav` leaves "stategraph": measured 2026-08-11, loading the demo and
// stepping through sessions and back drew the invitation again, with the
// artifacts gone. Card 175's other cure — keeping the pane mounted behind
// `display: none` — would also work, and the view takes no layout measurements
// that a hidden mount could get wrong. It loses on cost: a whole second
// surface, its file input and its canvas, in the DOM of every session view, to
// preserve one nullable field that belongs beside `nav` anyway. The view's own
// state — orientation, cursor, picked node — is lifted the same way now
// (viewState.ts holds the shape; App holds the object), so a segment switch
// resets nothing.
//
// Nothing loads by itself, and there is no spinner. A StateGraph's topology is
// fixed at compile(), before a token flows: an empty pane is not a pane waiting
// for something to arrive, it is a pane with no run attached. The honest thing
// to show is the invitation.

import { useCallback, useRef, useState } from "react";
import { StateGraphView } from "./StateGraphView";
import type { StateGraphViewState } from "./viewState";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
// The reference pair — the same CRAG run the owner's template page embeds, so
// the demo button draws something real rather than a shape somebody drew to look
// plausible.
//
// It is a byte-identical MIRROR of docs/graph-view-reference/crag-payload.*,
// kept here because the original is outside vite's fs.allow root. Measured
// 2026-08-11: importing the docs path answers "403 Restricted" from `vite dev`
// and "Denied ID" from vitest — server.fs.allow defaults to
// searchForWorkspaceRoot(), which stops at spectro-web where the lockfile is.
// StateGraphPane.test.tsx hashes both copies so the mirror cannot fork.
import demoGraph from "./demo/crag-payload.graph.jsonl?raw";
import demoState from "./demo/crag-payload.state.jsonl?raw";
import ragGraph from "./demo/simple-rag.graph.jsonl?raw";
import ragState from "./demo/simple-rag.state.jsonl?raw";
import cragGraph from "./demo/crag.graph.jsonl?raw";
import cragState from "./demo/crag.state.jsonl?raw";
import reactGraph from "./demo/react-tools.graph.jsonl?raw";
import reactState from "./demo/react-tools.state.jsonl?raw";
import failingGraph from "./demo/failing-run.graph.jsonl?raw";
import failingState from "./demo/failing-run.state.jsonl?raw";

/** The two artifacts of one run, plus where they came from — the view's props. */
export interface LoadedRun {
  graphJsonl: string;
  stateJsonl: string | null;
  source: string;
}

/** One file out of a picker: the name decides which half it is. */
export interface Picked {
  name: string;
  text: string;
}

export const DEMO_SOURCE = "crag-payload.graph.jsonl";

/** Every chrome string this pane reaches for, so the localisation can find them
 *  in one place instead of by grepping the JSX. */
const K = {
  claim: "sg.claim",
  emptyTitle: "sg.empty.title",
  emptyWhy: "sg.empty.why",
  emptyPair: "sg.empty.pair",
  orphanState: "sg.empty.orphanState",
  load: "sg.load",
  demo: "sg.demo",
  scenarios: "sg.scenarios",
} as const;

export const PANE_KEYS: readonly string[] = Object.values(K);

/** A fresh copy of the bundled reference run. Fresh because the caller puts it
 *  into React state, and the two imported strings are module-level constants
 *  shared with every other caller. */
export function demoRun(): LoadedRun {
  return { graphJsonl: demoGraph, stateJsonl: demoState, source: DEMO_SOURCE };
}

/** One bundled scenario: a real pair off a real run, offered by name. */
export interface Scenario {
  source: string;
  /** The human name the sidebar rail shows, per language — the fleet list's
   *  "Review fan-out · 3 subagents" idiom. The shelf keeps the file name:
   *  mono, and the name IS the story there. */
  title: { de: string; en: string };
  run: () => LoadedRun;
}

/** The scenario shelf, the way the agent scenarios are offered: a named list,
 *  one click each. Every entry was WRITTEN BY the Java engine
 *  (DemoScenariosTest, -Ddemos.out) — a hand-written artifact would drift from
 *  the writer the first time a field moves, and the point of a demo is that it
 *  is true. The reference run leads; then the four shapes worth teaching: the
 *  linear rag, the corrective loop, a two-turn conversation on one thread, and
 *  a run that dies honestly. */
export const SCENARIOS: readonly Scenario[] = [
  {
    source: DEMO_SOURCE,
    title: { de: "Referenz-Lauf · die vermessene Vorlage", en: "Reference run · the measured template" },
    run: demoRun,
  },
  {
    source: "simple-rag.graph.jsonl",
    title: { de: "Simple RAG · lineare Pipeline", en: "Simple RAG · linear pipeline" },
    run: () => ({ graphJsonl: ragGraph, stateJsonl: ragState, source: "simple-rag.graph.jsonl" }),
  },
  {
    source: "crag.graph.jsonl",
    title: { de: "CRAG · Korrekturschleife", en: "CRAG · corrective loop" },
    run: () => ({ graphJsonl: cragGraph, stateJsonl: cragState, source: "crag.graph.jsonl" }),
  },
  {
    source: "react-tools.graph.jsonl",
    title: { de: "ReAct-Tools · zwei Turns, ein Thread", en: "ReAct tools · two turns, one thread" },
    run: () => ({
      graphJsonl: reactGraph,
      stateJsonl: reactState,
      source: "react-tools.graph.jsonl",
    }),
  },
  {
    source: "failing-run.graph.jsonl",
    title: { de: "Fehlschlag · ein ehrlicher node_error", en: "Failing run · an honest node_error" },
    run: () => ({
      graphJsonl: failingGraph,
      stateJsonl: failingState,
      source: "failing-run.graph.jsonl",
    }),
  },
];

/** The sidebar rail of scenarios — the fleet list's idiom, offered
 *  PERMANENTLY: once a run is loaded the empty-state shelf is gone, and the
 *  owner's call is that the scenarios stay reachable the way the fleet
 *  scenarios are. Lives in this package so its pins sit beside the shelf's;
 *  the Sidebar renders it inside its stategraph arm. */
export function ScenarioRail({
  active,
  onSelect,
}: {
  /** The source of the run on screen, so its row reads as the active one. */
  active: string | null;
  onSelect: (run: LoadedRun) => void;
}) {
  const lang = useLang();
  return (
    <nav className="session-list scenario-list" aria-label={t(lang, K.scenarios)}>
      {SCENARIOS.map((s) => (
        <button
          type="button"
          key={`sg-scenario:${s.source}`}
          className={`session-row scenario-row${active === s.source ? " active" : ""}`}
          title={s.source}
          onClick={() => onSelect(s.run())}
        >
          <span className="session-title">
            <svg className="scenario-glyph" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
              <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
            </svg>
            {s.title[lang]}
          </span>
          <span className="session-meta">
            {lang === "de" ? "state graph szenario · demo" : "state graph scenario · demo"}
          </span>
        </button>
      ))}
    </nav>
  );
}

type Half = "graph" | "state" | "unknown";

function classify(name: string): Half {
  if (name.endsWith(".graph.jsonl")) return "graph";
  if (name.endsWith(".state.jsonl")) return "state";
  return "unknown";
}

/**
 * Folds a file pick onto what is already drawn.
 *
 * A file picker cannot reach a sibling, so the pair legitimately arrives in two
 * gestures in either order: a lone `.state.jsonl` must ATTACH to the drawing on
 * screen rather than replace it. The mirror rule matters more — a new drawing
 * arriving alone DROPS the previous values, because payloads join on runId and
 * keeping them would put run A's numbers under run B's nodes, which a reader has
 * no way to see.
 */
export function foldPick(current: LoadedRun | null, picked: Picked[]): LoadedRun | null {
  if (picked.length === 0) return current;
  const state = picked.find((p) => classify(p.name) === "state") ?? null;
  // "unknown" counts as the drawing: it is the half that renders on its own, and
  // the reference page's picker accepts .json and .ndjson too.
  const graph = picked.find((p) => classify(p.name) !== "state") ?? null;
  if (graph === null) {
    if (state === null || current === null) return current;
    return { ...current, stateJsonl: state.text };
  }
  return { graphJsonl: graph.text, stateJsonl: state?.text ?? null, source: graph.name };
}

/**
 * Folds what StateGraphView's own picker hands back, through the same rule.
 *
 * That picker keeps `find(…) ?? wanted[0]`, so picking the values file alone
 * delivers it here as the drawing — with `source` naming a `.state.jsonl`, the
 * only evidence that survives the call. Rebuilding a pick out of the three
 * arguments keeps one implementation of the rule instead of a second one that
 * drifts: the second name only has to CLASSIFY, since the real one is gone.
 */
export function foldViewLoad(
  current: LoadedRun | null,
  graphJsonl: string,
  stateJsonl: string | null,
  source: string,
): LoadedRun | null {
  const picked: Picked[] = [{ name: source, text: graphJsonl }];
  if (stateJsonl !== null) picked.push({ name: `${source}.state.jsonl`, text: stateJsonl });
  return foldPick(current, picked);
}

export interface StateGraphPaneProps {
  /** The pair of artifacts on screen, or null while none is loaded. */
  run: LoadedRun | null;
  /** Where a pick lands. Called with the folded result, null included. */
  onRun: (next: LoadedRun | null) => void;
  /** Orientation, cursor and pick — App-owned like the run, and for the same
   *  reason: this pane unmounts on every segment switch. */
  view: StateGraphViewState;
  onView: (next: StateGraphViewState) => void;
}

export function StateGraphPane({ run, onRun, view, onView }: StateGraphPaneProps) {
  const lang = useLang();
  // A pick that changed nothing is the one case a user reads as a broken button:
  // a lone values file with no drawing to attach it to. Local on purpose — it
  // describes the last gesture, not the run, so losing it on a segment change
  // is correct.
  const [orphan, setOrphan] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const openFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    const chosen = [...files];
    void Promise.all(chosen.map((f) => f.text())).then((texts) => {
      const next = foldPick(
        run,
        chosen.map((f, i) => ({ name: f.name, text: texts[i] })),
      );
      setOrphan(next === null);
      onRun(next);
    });
  };

  const onViewLoad = useCallback(
    (graphJsonl: string, stateJsonl: string | null, source: string) => {
      onRun(foldViewLoad(run, graphJsonl, stateJsonl, source));
    },
    [run, onRun],
  );

  const picker = (
    <input
      ref={fileRef}
      type="file"
      multiple
      accept=".jsonl,.ndjson,.json"
      hidden
      onChange={(e) => openFiles(e.target.files)}
    />
  );

  if (run === null) {
    return (
      <div className="sg sg--empty">
        <header className="sg-head">
          <p className="sg-claim">{t(lang, K.claim)}</p>
        </header>
        <div className="sg-empty">
          <h2 className="sg-empty-h">{t(lang, K.emptyTitle)}</h2>
          <p className="sg-empty-why">{t(lang, K.emptyWhy)}</p>
          <div className="sg-empty-actions">
            <button type="button" className="sg-empty-load" onClick={() => fileRef.current?.click()}>
              {t(lang, K.load)}
            </button>
          </div>
          {/* The scenario shelf, offered the way the agent scenarios are: one
              named chip per bundled run. Mono and by file name — the name IS
              the story, and a prettier label would be a second name to drift. */}
          <p className="sg-empty-scenarios-h">{t(lang, K.scenarios)}</p>
          <div className="sg-empty-scenarios">
            {SCENARIOS.map((s) => (
              <button
                key={s.source}
                type="button"
                className="sg-empty-scenario mono"
                onClick={() => onRun(s.run())}
              >
                {s.source.replace(".graph.jsonl", "")}
              </button>
            ))}
          </div>
          <p className="sg-empty-pair">{t(lang, K.emptyPair)}</p>
          {orphan && <p className="sg-warn">{t(lang, K.orphanState)}</p>}
          {picker}
        </div>
      </div>
    );
  }

  return (
    <StateGraphView
      graphJsonl={run.graphJsonl}
      stateJsonl={run.stateJsonl}
      source={run.source}
      view={view}
      onView={onView}
      onLoadFile={onViewLoad}
    />
  );
}
