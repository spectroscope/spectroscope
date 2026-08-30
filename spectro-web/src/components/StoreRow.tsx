// One row of the import dialog's store listing, and its two doors.
//
// It is its own component for one reason: while it was JSX inside
// `ImportDialog`, the only guard reachable was a substring search over the
// component's source, and a reviewer rewired the row to the session door with
// every case green. As an element it can be built in a test, its buttons found,
// and their handlers called — no DOM, no click, and no "does the line still say
// that?".
//
// What it owns is the WIRING of the plan `rowState` already decided: which door
// the row's own press takes, whether the escape beside it is offered, and
// whether the row may say what the press is about to bring. It decides nothing;
// two conditions live here and both are measured.

import type { ReactNode } from "react";

import { formatBytes, type RowState, type RowPlan, type TranscriptRow } from "../import/rowState";
import type { StoreDoor } from "../import/storeDoor";
import { relativeTime } from "../format";
import { t, type Lang } from "../i18n/i18n";

export function StoreRow(props: {
  tr: TranscriptRow;
  /** The verdict AND the door, from the one call the dialog already makes. */
  state: RowState & { plan: RowPlan };
  lang: Lang;
  /** "now" for the relative time, passed so a listing renders one clock. */
  now: number;
  /** A store load is in flight — for this row or any other. */
  busy: boolean;
  /** …and it is this row's. */
  loadingThis: boolean;
  /** What the dialog knows about this row beyond the listing: the first
   *  prompt, the gist, the facts chips. Built there because they are its
   *  state, rendered here so the row stays one element. */
  chips?: ReactNode;
  rowRef?: (el: HTMLButtonElement | null) => void;
  /** Open this row through a door. The row's own press passes the door the
   *  PLAN named; the escape passes "session". */
  onOpen: (door: StoreDoor) => void;
}): ReactNode {
  const { tr, state, lang, busy } = props;
  const runDoor = state.plan.door === "run";
  // Two different questions, and they were one condition until a reviewer found
  // the window between them. The LABEL needs a measured count and must not
  // print one nobody has. The ESCAPE only needs to know which door the press
  // takes. Gating both on the count meant the first press after the dialog
  // opens — facts still in flight, so the run door — carried no warning AND no
  // way out, on the one door that can pull a hundred megabytes.
  const bringsRun = runDoor && state.plan.agents > 0;

  return (
    <div className="import-store-line" role="listitem">
      <button
        type="button"
        className={state.enabled ? "import-store-row" : "import-store-row is-refused"}
        title={tr.path}
        disabled={!state.enabled || busy}
        aria-disabled={!state.enabled || busy}
        aria-busy={props.loadingThis}
        onClick={() => props.onOpen(state.plan.door)}
        ref={props.rowRef}
      >
        <span className="import-store-file mono">{tr.file}</span>
        {props.chips}
        <span className="import-store-meta">
          <span className="import-store-project">{tr.project}</span>
          <span className="tabular">
            {relativeTime(tr.modifiedAt, props.now, lang)} · {formatBytes(tr.size)}
          </span>
        </span>
        {bringsRun && (
          <span className="import-store-brings">
            {state.plan.runs === null || state.plan.bytes === null
              ? t(lang, "imp.run.brings", { agents: state.plan.agents })
              : t(lang, "imp.run.bringsWeighed", {
                  agents: state.plan.agents,
                  runs: state.plan.runs,
                  size: formatBytes(state.plan.bytes),
                })}
          </span>
        )}
        {!state.enabled && <span className="import-store-refused">{state.reason}</span>}
      </button>
      {/* The escape the owner asked for: secondary, labelled, and never the
          answer "go and find the folder yourself". */}
      {runDoor && state.enabled && (
        <button
          type="button"
          className="ghost import-store-only"
          disabled={busy}
          onClick={() => props.onOpen("session")}
        >
          {t(lang, "imp.run.only")}
        </button>
      )}
    </div>
  );
}
