// Why a run ended, in the operator's language (card 282).
//
// The report this exists for: a run ended on max_turns and the footer rendered
// "gestoppt · max_turns" — the wire word, untranslated, inside a German
// sentence. That is machine vocabulary shown to a person, and it is the same
// defect the cards around it are about, one surface further out.
//
// One module rather than a mapping in the footer and a second in the exporter:
// the exported document and the live page have to say the same thing about the
// same session, and card 264 already had to reunite them once for the plan
// verdict.

/**
 * Every value the harness writes into `run_end.stopReason`.
 *
 * Assembled from three places in the Java — Agent's provider-reason switch, the
 * STOP_REASON constants on the guard and the leash, and the goal check's
 * verdicts. `stopReason.test.ts` reads those sources off disk, so a fourth
 * source is caught the day it appears rather than the day somebody notices a
 * footer printing snake_case.
 */
export const STOP_REASONS: ReadonlySet<string> = new Set([
  // The provider's own reasons.
  "end_turn",
  "max_tokens",
  "tool_use",
  "aborted",
  // The harness's.
  "error",
  "max_turns",
  // Card 264: stopped mid-plan, which used to read as a clean finish.
  "unfinished",
  // Card 262: the operator ended it at the guard's question.
  "no_progress",
  // Card 266: still unfinished after every continuation was spent. NOT the same
  // as "no_progress" above, and the only thing that tells them apart is this
  // value — the leash has a decision of its own also called no_progress.
  "unfinished_after_continuations",
  // Card 267: the goal's check decided.
  "goal_met",
  "goal_unmet",
  "goal_untested",
]);

/**
 * The dict key that reads a stop reason.
 *
 * @param reason the wire value from `run_end.stopReason`
 * @returns the key for a known reason, or `stop.other`, which prints the raw
 *          value inside a sentence rather than on its own. A build one version
 *          behind a server is ordinary; showing the operator a word they cannot
 *          place is better than showing them nothing, and better than showing
 *          them the word with no sentence around it.
 */
export function stopReasonKey(reason: string): string {
  return STOP_REASONS.has(reason) ? `stop.${reason}` : "stop.other";
}
