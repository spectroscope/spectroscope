// What the plan ledger says about a run that ended — the web's half of card
// 264, in ONE place because two faces read it: the footer under the live session
// and the foot of an exported document. They word it differently (their dicts
// are different) but they must never disagree about the verdict itself.
//
// The Java side computes the same thing at the loop's exit (PlanVerdict.java)
// and puts "unfinished" on the wire for the one case a value can carry. Here the
// rule is APPLIED rather than believed, for a reason: a file recorded before
// this card ended an abandoned run with "end_turn", and a reader that trusts the
// old value would contradict the Plan panel sitting next to it.
import type { PlanStep } from "./reducer";

/**
 * finished — a ledger exists and every step is completed.
 * unfinished — a ledger exists and at least one step is open.
 * unknown — the run ended on its own terms and no ledger was ever written;
 *   nobody can grade it, and "clean finish" would claim more than the record shows.
 * other — a brake, a cap, an abort or a failure ended the run: how it stopped is
 *   the more urgent fact, and the plan is not the story. Also the verdict of a
 *   truncated import whose "unfinished" arrived without its ledger.
 */
export type PlanVerdict = "finished" | "unfinished" | "unknown" | "other";

/** How many steps of the snapshot are not completed. */
export function openSteps(plan: PlanStep[] | null): number {
  return plan === null ? 0 : plan.filter((step) => step.status !== "completed").length;
}

/**
 * Grades a finished run from the two things the reducer already holds.
 *
 * @param lastStopReason the recorded stop reason, null while nothing has ended
 * @param plan the latest plan snapshot, null when the run never wrote one
 */
export function planVerdict(lastStopReason: string | null, plan: PlanStep[] | null): PlanVerdict {
  if (lastStopReason === null) return "other";
  const abandoned = lastStopReason === "unfinished" || (lastStopReason === "end_turn" && openSteps(plan) > 0);
  if (abandoned) return plan === null ? "other" : "unfinished";
  if (lastStopReason !== "end_turn") return "other";
  return plan === null ? "unknown" : "finished";
}
