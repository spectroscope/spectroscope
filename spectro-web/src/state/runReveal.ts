// Card 586: a run that starts opens the run panel beside the chat, once per run.
//
// The cue is the session's own run_step run_start on the live socket. It opens
// the dock and its plan panel, where the run is drawn (opens it if closed,
// raises it if folded; openDockPanel does both). It answers at most once per
// run id: an operator who closed the panel during the run has answered, and a
// later batch of the same run must not ask again. A new run may.
//
// The pattern is state/browserReveal.ts, keyed by run id instead of re-armed
// by a run_start.

import type { RunEvent } from "../events";
import { openDockPanel, openRightPanel } from "./layout";

/** The run ids whose one reveal has been used up. */
const shown = new Set<string>();

/**
 * Reveals the dock's plan panel for a run, at most once per run id.
 *
 * @param runId the run's id, from its run_step lines
 * @param force card 586: a press on the chat's "open the run" asks by hand, so
 *   the panel opens whether or not the run's one reveal was used; it leaves
 *   that reveal as it was
 */
export function revealRunPanel(runId: string, force = false): void {
  if (!force) {
    if (shown.has(runId)) return;
    shown.add(runId);
  }
  openRightPanel();
  openDockPanel("plan");
}

/**
 * Reads one live batch: a run_step run_start reveals its run. Called from the
 * app's one event funnel, beside the browser reveal, for the session in view.
 *
 * @param batch the animation-frame batch the socket delivered
 */
export function runRevealPushLive(batch: RunEvent[]): void {
  for (const event of batch) {
    const e = event as { type?: string; phase?: string; runId?: unknown };
    if (e.type === "run_step" && e.phase === "run_start" && typeof e.runId === "string")
      revealRunPanel(e.runId);
  }
}

/** Test-only. */
export function __resetRunRevealForTests(): void {
  shown.clear();
}
