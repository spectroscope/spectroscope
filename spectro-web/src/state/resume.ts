// Pure helper for the session-resume feature: size up the stored history so
// the UI can say, honestly and BEFORE the next request, how much old context
// is about to ride back up to the LLM. The numbers mirror what
// SessionStore.loadSession reconstructs into provider messages (prompts,
// assistant text, tool calls and tool outputs); thinking deltas never re-enter
// the provider history, so they are deliberately NOT counted.

import type { RunEvent } from "../events";
import { foldLocalLine, windowTrace, type UiState } from "./reducer";
import type { LocalLine } from "./pageCommands";
import { cutOpenRuns } from "./runView";

/**
 * The state a resumed session hands to the live socket.
 *
 * A resume is the one seam in the app where a finished record turns into a
 * stream that has no end: the JSONL is folded whole (card 116 — a finite fold
 * keeps every row), and then the very same object is what new frames append to.
 * Seeding it unbounded left the live path without the limit every other live
 * state has, and the cut still came — at whichever later frame happened to
 * arrive, taking thousands of rows out from under a reader who had done nothing.
 *
 * Cutting here instead costs the same rows and buys two things: the pane states
 * its window on the first render rather than on some later one, and each
 * following frame copies a bounded array (measured over 2000 live frames on top
 * of a 9000-row history: 12.9 ms seeded whole, 7.4 ms seeded windowed).
 *
 * Not "keep the seeded rows and window only what grows": that leaves the array
 * unbounded for a long session, and unbounded is what the window is for — a
 * 50 000-frame stream folds in 179.8 ms windowed and 2998.9 ms uncapped.
 */
export function seedResumedLive(folded: UiState): UiState {
  // Card 265: a resume re-folds a STORED history into live state, and the server
  // never re-parks the calls in it. A question left hanging in that history
  // therefore has nobody on the other end — an answer sent for it is dropped by
  // callId and the bar would sit there for the rest of the session.
  //
  // Copied only when there IS something to clear: this function's own contract is
  // that a session which fits comes back object for object, and its test asserts
  // identity rather than equality.
  const withoutAsks = folded.pendingAsks.length === 0 ? folded : { ...folded, pendingAsks: [] };
  // Card 586 (review I4): a run the history left without its run_end will not
  // end; it is cut, so the continued chat's text and files stay out of it.
  const runs = cutOpenRuns(withoutAsks.runs);
  return windowTrace(runs === withoutAsks.runs ? withoutAsks : { ...withoutAsks, runs });
}

/**
 * Card 577: the lines the page added to a stored session's chat while it was
 * on screen (pageCommands.ts), for the resume that continues it. Only the
 * session the resume continues gives its lines; another one on screen gives
 * none.
 *
 * @param shown the stored session on screen, or null
 * @param id    the session the resume continues
 * @return its lines in the order they were added
 */
export function pageLinesOf(
  shown: { id: string; pageLines?: readonly LocalLine[] } | null,
  id: string,
): readonly LocalLine[] {
  return shown !== null && shown.id === id ? (shown.pageLines ?? []) : [];
}

/**
 * Card 577: the resumed state with the stored chat's page lines after its
 * history, each once and in order, folded as App folds them (foldLocalLine).
 * The stored file never held them. Only the lines addLocalLine kept travel;
 * another page-only turn, such as the line abandonResumeFrames adds when a
 * model pick did not arrive, does not.
 *
 * @param resumed the state the resume folded from the stored file
 * @param lines   the lines, from {@link pageLinesOf}
 * @return the state, the same object when there are none
 */
export function withPageLines(resumed: UiState, lines: readonly LocalLine[]): UiState {
  return lines.reduce(
    (state, line) => foldLocalLine(state, line.text, { tone: line.tone, openPlaybook: line.openPlaybook }),
    resumed,
  );
}

export interface ResumeSummary {
  /** Every stored JSONL line that will be re-folded into the UI. */
  events: number;
  /** User prompts in the history (main run_starts). */
  prompts: number;
  /** Characters of provider-visible history (prompts + answers + tool i/o). */
  approxChars: number;
  /** The usual chars/4 estimate of the re-upload size. */
  estTokens: number;
}

export function summarizeHistory(events: RunEvent[]): ResumeSummary {
  // Mirror SessionStore.loadSession: only the MAIN agent's events re-enter the
  // provider history. The main agent is found STRUCTURALLY — the first
  // run_start without a parentId — and a subagent's deltas/tool i/o stay with
  // the child (its results reach the parent as tool_result output, which IS
  // counted on the main side).
  let mainId: string | null = null;
  for (const e of events) {
    if (e.type === "run_start" && e.parentId == null) {
      mainId = e.agentId;
      break;
    }
  }
  let prompts = 0;
  let chars = 0;
  for (const e of events) {
    const owner = (e as { agentId?: string }).agentId;
    if (owner !== undefined && mainId !== null && owner !== mainId) continue;
    switch (e.type) {
      case "run_start":
        if (e.parentId == null) {
          prompts += 1;
          chars += e.prompt.length;
        }
        break;
      case "text_delta":
        chars += e.text.length;
        break;
      case "tool_call":
        chars += e.name.length + JSON.stringify(e.input ?? null).length;
        break;
      case "tool_result":
        chars += e.output.length;
        break;
      default:
        break; // thinking_delta, usage, permission_*, ... never re-enter the provider history
    }
  }
  return {
    events: events.length,
    prompts,
    approxChars: chars,
    estTokens: Math.round(chars / 4),
  };
}
