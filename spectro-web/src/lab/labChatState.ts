// Card 504, last fix round: what the Lab's chat shows of the goal and the loop.
// The Lab folds only the events it has stepped (the dam), and goal_info and
// loop_info are socket-only frames about the session as it is now, not part of
// the recording. On the live run the Lab's chat takes them from the live
// record, so the goal line, the loop chip and the gear's Clear work there as in
// the main chat. An archive keeps its own fold.

import type { UiState } from "../state/reducer";

/** The parts of a live record's state the Lab's chat takes over. */
export type LiveGoalLoop = Pick<UiState, "goal" | "goalVerdict" | "loop" | "runTurn">;

/**
 * @param ui   the Lab's stepped fold
 * @param live the live record's state, or null for an archive
 * @return the state the Lab's chat renders; `ui` itself when nothing differs
 */
export function labChatState(ui: UiState, live: LiveGoalLoop | null): UiState {
  if (live === null) return ui;
  if (
    ui.goal === live.goal &&
    ui.goalVerdict === live.goalVerdict &&
    ui.loop === live.loop &&
    ui.runTurn === live.runTurn
  ) {
    return ui;
  }
  return { ...ui, goal: live.goal, goalVerdict: live.goalVerdict, loop: live.loop, runTurn: live.runTurn };
}

/**
 * Last fix round 2026-10-12: the live goal and loop belong beside the live
 * end. Stepped back, the chat shows an old step, so it keeps the fold's.
 *
 * @param onLiveRun whether the Lab steps the live run (no archive open)
 * @param queued    events still waiting behind the Lab's cursor
 * @param live      the live record's state, or null
 * @return the live goal and loop to show, or null for the fold's own
 */
export function liveGoalLoopShown(
  onLiveRun: boolean,
  queued: number,
  live: LiveGoalLoop | null,
): LiveGoalLoop | null {
  return onLiveRun && queued === 0 ? live : null;
}
