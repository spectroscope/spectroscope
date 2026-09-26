// The state graph's bundled scenarios: the reference run and four shapes worth
// teaching, and the sidebar's rail that offers them. Split out of
// StateGraphPane.tsx for card 430: the sidebar draws the rail and the shell's
// stategraph.demo loads one, both from the entry chunk, while the pane itself
// loads from a chunk of its own. StateGraphPane re-exports all of it.

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

export const DEMO_SOURCE = "crag-payload.graph.jsonl";

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
    <nav className="session-list scenario-list" aria-label={t(lang, "sg.scenarios")}>
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
