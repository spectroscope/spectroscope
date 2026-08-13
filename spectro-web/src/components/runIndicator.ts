// What the circle in front of a sidebar row means.
//
// The limit this file used to state — "no endpoint reports which sessions are
// currently live, so a stored row can only ever be open or idle" — was true and
// is not any more. Card 212 gave the server a live registry and two ways to
// read it (the `live_sessions` socket frame, and GET /api/sessions/live under
// it), so a row this page holds no socket to can now honestly say running.
//
// What did NOT change is where the claim comes from. `running` is still only
// meaningful for a session somebody is observed to hold; the difference is that
// "somebody" is no longer "this page". `storedRunState` below is the one place
// that decides, so the rule lives in a pure function a test can hold rather
// than inside the rail's markup.
//
// "open" still means "no run_end ever closed this file", which is a fact about
// the file and not a claim about a process. It must not pulse: an unfinished
// file from three days ago is not running, and a dot saying so would be the
// same defect as a number somebody remembers.

import type { LiveSessionRow } from "../state/liveSessions";

/** The four things a row's circle can say. */
export type RunState = "running" | "live" | "open" | "idle";

/** Every state, for the callers that must cover all of them (labels, styles). */
export const RUN_STATES: readonly RunState[] = ["running", "live", "open", "idle"];

/**
 * What the circle in front of a row says.
 *
 * @param row.live       a socket of THIS page is attached to this session
 * @param row.running    that socket reports a run in flight
 * @param row.stopReason from SessionMeta; null/undefined/"" = no run_end
 */
export function runState(row: { live: boolean; running: boolean; stopReason?: string | null }): RunState {
  // `running` is only meaningful for a session we hold a socket to. A stored
  // row cannot be observed running, so the flag is ignored there rather than
  // trusted — a caller passing it by accident must not produce a lie.
  if (row.live) return row.running ? "running" : "live";
  const closed = row.stopReason !== null && row.stopReason !== undefined && row.stopReason !== "";
  return closed ? "idle" : "open";
}

/**
 * What ONE stored row's circle says, given everything the page knows about it.
 *
 * The order matters and is the whole card in six lines. The server's live set
 * wins, because it sees every run on the machine and this page sees one socket.
 * This page's own resume is the FALLBACK, not the rule — it is what a server
 * from before card 212 leaves behind, and dropping it would quietly regress
 * the rail against an older jar. A row nothing reports as live never borrows
 * this page's `liveRunning`, which was the old lie in reverse — `runState`
 * refuses to read `running` for a row nobody holds, so the flag is simply
 * handed over and its own guard does the refusing.
 *
 * @param view.row         the stored row: its id, and how its last run stopped
 * @param view.live        the server's live set (empty when nothing reports one)
 * @param view.resumeId    the stored session THIS page's socket is continuing
 * @param view.liveRunning whether THIS page's socket has a run in flight
 * @return the state the row's circle should show
 */
export function storedRunState(view: {
  row: { id: string; stopReason?: string | null };
  live: readonly LiveSessionRow[];
  resumeId: string | null;
  liveRunning: boolean;
}): RunState {
  const reported = view.live.find((session) => session.id === view.row.id);
  const mine = view.resumeId === view.row.id;
  return runState({
    live: reported !== undefined || mine,
    running: reported !== undefined ? reported.running : view.liveRunning,
    stopReason: view.row.stopReason,
  });
}

/**
 * The dot's classes, from the shared `.dot` family in base.css. No new
 * keyframes and no new colour: accent is what everything live wears here, warn
 * is what an unclosed file wears, and only the pulse carries the halo.
 */
export function runDotClass(state: RunState): string {
  switch (state) {
    case "running":
      return "dot accent pulse";
    case "live":
      return "dot accent";
    case "open":
      return "dot warn";
    case "idle":
      return "dot faint";
  }
}

/** The i18n key naming the state in words — colour alone never carries meaning. */
export function runLabelKey(state: RunState): string {
  return `nav.run.${state}`;
}
