// The state graph as a top-level view: a third one beside agents and fleets,
// not a tab inside a session. A session's "graph" tab draws what a run DID; this
// draws what a StateGraph IS, and the two answer different questions.
//
// The pane owns exactly one fact — which pair of artifacts is on screen. Reading
// them is artifact.ts's job and drawing them is StateGraphView's, so App.tsx
// mounts this in one line and hands it nothing.
//
// Nothing loads by itself, and there is no spinner. A StateGraph's topology is
// fixed at compile(), before a token flows: an empty pane is not a pane waiting
// for something to arrive, it is a pane with no run attached. The honest thing
// to show is the invitation.

import { useCallback, useRef, useState } from "react";
import { StateGraphView } from "./StateGraphView";
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
} as const;

export const PANE_KEYS: readonly string[] = Object.values(K);

/** A fresh copy of the bundled reference run. Fresh because the caller puts it
 *  into React state, and the two imported strings are module-level constants
 *  shared with every other caller. */
export function demoRun(): LoadedRun {
  return { graphJsonl: demoGraph, stateJsonl: demoState, source: DEMO_SOURCE };
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

export function StateGraphPane() {
  const lang = useLang();
  const [run, setRun] = useState<LoadedRun | null>(null);
  // A pick that changed nothing is the one case a user reads as a broken button:
  // a lone values file with no drawing to attach it to.
  const [orphan, setOrphan] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Not memoised, and it reads `run` from this render rather than through the
  // updater form: deciding `orphan` is a second piece of state, and a state
  // updater that also calls a setter runs twice under StrictMode.
  const openFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    const chosen = [...files];
    void Promise.all(chosen.map((f) => f.text())).then((texts) => {
      const next = foldPick(
        run,
        chosen.map((f, i) => ({ name: f.name, text: texts[i] })),
      );
      setOrphan(next === null);
      setRun(next);
    });
  };

  const onViewLoad = useCallback((graphJsonl: string, stateJsonl: string | null, source: string) => {
    setRun((cur) => foldViewLoad(cur, graphJsonl, stateJsonl, source));
  }, []);

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
            <button type="button" className="sg-empty-demo" onClick={() => setRun(demoRun())}>
              {t(lang, K.demo)}
            </button>
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
      onLoadFile={onViewLoad}
    />
  );
}
