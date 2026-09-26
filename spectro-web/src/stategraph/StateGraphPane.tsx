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
// The bundled scenarios, the shelf's list and the rail, live in scenarios.tsx
// (card 430): the rail is drawn by the sidebar, which the entry chunk carries,
// and this pane loads from a chunk of its own.
import { DEMO_SOURCE, SCENARIOS, ScenarioRail, demoRun, type LoadedRun, type Scenario } from "./scenarios";

export { DEMO_SOURCE, SCENARIOS, ScenarioRail, demoRun };
export type { LoadedRun, Scenario };

/** One file out of a picker: the name decides which half it is. */
export interface Picked {
  name: string;
  text: string;
}

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
