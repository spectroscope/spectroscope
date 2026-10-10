// Card 482: the line above a playbook run in the run view.

import { dict, t, type Lang } from "../i18n/i18n";
import type { PlaybookRunRow } from "../state/playbookRuns";

/** What the run view says about a run, and the two words it is built from. */
export interface RunStatus {
  text: string;
  live: boolean;
  /** The runner's stop reason (RunStop), null while the run has no end. */
  stop: string | null;
  /** The label of the end the path reached, null when it reached none. */
  result: string | null;
}

/** The stop reason in words, or the raw word when the dictionary has none. */
function reasonWords(lang: Lang, reason: string): string {
  const key = `pb.run.stop.${reason}`;
  return dict[key] !== undefined ? t(lang, key) : reason;
}

/**
 * The status line of one run.
 *
 * @param lang the window language
 * @param row the run as the run list gives it
 */
export function runStatus(lang: Lang, row: PlaybookRunRow): RunStatus {
  if (row.live) return { text: t(lang, "pb.run.live"), live: true, stop: null, result: null };
  if (row.stopReason === null) {
    return { text: t(lang, "pb.run.unrecorded"), live: false, stop: null, result: null };
  }
  const reason = reasonWords(lang, row.stopReason);
  // A run that reached an end names that end: the stop reason done alone
  // read as success for a run whose path ended on cancelled.
  if (row.result !== null) {
    return {
      text: t(lang, "pb.run.ended", { result: row.result, reason }),
      live: false,
      stop: row.stopReason,
      result: row.result,
    };
  }
  return { text: t(lang, "pb.run.stopped", { reason }), live: false, stop: row.stopReason, result: null };
}
