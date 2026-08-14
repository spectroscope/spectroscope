// The agent's browser cue, answered (card 241).
//
// The owner's field report: "öffne einen browser mit www.test.de" made the
// agent's browser reach flip the session TAB to a whole-surface browser, and
// the UI broke to the point of a restart. His ruling: live driving happens in
// the DOCK PANEL; the tab stays the state/replay door the operator opens by
// hand.
//
// So the cue — the session's own browser_action events on the live socket,
// the same announcement card 226's re-watch counts — opens the dock's browser
// panel: opens it if closed, raises it if folded (openDockPanel does both).
// It flips no tab and no segment, and it answers at most ONCE per run: an
// operator who closed the panel mid-run has answered the question, and the
// app must not re-ask it every verb (card 222: the app is not the operator).
// A run_start re-arms the reveal, so the next run may announce itself again.
//
// The desktop shell's nav.browser command lands on the same function through
// the shell command router, so both roads — the RunEvent cue and the shell's
// segment request — obey one rule.

import type { RunEvent } from "../events";
import { openDockPanel, openRightPanel } from "./layout";

/** Whether this run's one reveal has been used up. */
let spent = false;

/**
 * Reveals the dock's browser panel, at most once per run.
 *
 * Idempotent against the layout store (openDockPanel/openRightPanel both are),
 * and silent after the first call of a run — the operator's later close is a
 * decision, not a race to win.
 */
export function revealBrowserPanel(): void {
  if (spent) return;
  spent = true;
  openRightPanel();
  openDockPanel("browser");
}

/**
 * Reads one live batch: a run_start re-arms the reveal, a browser_action
 * spends it. Called from the app's one event funnel, beside the other live
 * stores.
 *
 * @param batch the animation-frame batch the socket delivered
 */
export function browserRevealPushLive(batch: RunEvent[]): void {
  for (const event of batch) {
    const type = (event as { type?: string }).type;
    if (type === "run_start") spent = false;
    else if (type === "browser_action") revealBrowserPanel();
  }
}

/** Test-only. */
export function __resetBrowserRevealForTests(): void {
  spent = false;
}
