// Card 504, last fix round: what the Lab's chat shows of the goal and the loop.
// The Lab folds only the events it has stepped (the dam), and goal_info and
// loop_info are socket-only frames about the session as it is now, not part of
// the recording. On the live run the Lab's chat takes them from the live
// record, so the goal line, the loop chip and the gear's Clear work there as in
// the main chat. An archive keeps its own fold.

import type { Turn, UiState } from "../state/reducer";

/** The parts of a live record's state the Lab's chat takes over. App hands
 *  the whole record's state, so `turns` is there for withCommandMarks. */
export type LiveGoalLoop = Pick<UiState, "goal" | "goalVerdict" | "loop" | "runTurn"> & {
  turns?: readonly Turn[];
};

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

/**
 * Card 576, fix round: the Lab folds its chat from the stream it steps, which
 * never sees a frame leave, so its error turns cannot know they answer a
 * command typed in the composer, and its Chat mounts anew on every tab
 * switch. On the live run each error takes the live record's mark, the k-th
 * error onto the k-th: both folds read the same events in the same order.
 *
 * @param ui        the Lab chat's state
 * @param liveTurns the live record's turns, or null for an archive
 * @return the state with the marks; `ui` itself when none is new
 */
export function withCommandMarks(ui: UiState, liveTurns: readonly Turn[] | null | undefined): UiState {
  if (liveTurns == null) return ui;
  const marked = liveTurns.filter((turn) => turn.kind === "error").map((turn) => turn.afterCommand === true);
  if (!marked.includes(true)) return ui;
  let k = 0;
  let changed = false;
  const turns = ui.turns.map((turn) => {
    if (turn.kind !== "error") return turn;
    const mark = marked[k++] === true;
    if (!mark || turn.afterCommand === true) return turn;
    changed = true;
    return { ...turn, afterCommand: true as const };
  });
  return changed ? { ...ui, turns } : ui;
}
