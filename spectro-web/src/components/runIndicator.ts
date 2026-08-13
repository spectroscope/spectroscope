// What the circle in front of a sidebar row means.
//
// The honest limit, written here rather than discovered later: the rail's list
// comes from GET /api/sessions, which reads stored JSONL only. No endpoint
// reports which sessions are currently live — the server's connection map is
// private and has no accessor. So a stored row can only ever be "open" or
// "idle", and only the rows THIS page is connected to can be "live" or
// "running".
//
// "open" therefore means "no run_end ever closed this file", which is a fact
// about the file, not a claim about a process. It must not pulse: an
// unfinished file from three days ago is not running, and a dot saying so
// would be the same defect as a number somebody remembers.

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
