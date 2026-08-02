// The bar that says what an import was, and which session it belongs to.
//
// The bar is dismissible, so holding it in its own state is right. What was
// missing is the other half: it describes ONE loaded file, and the reader can
// leave that file without dismissing anything. Stamping the session id on the
// bar and checking it at render time is the whole fix, and it is a pure
// function so the rule is pinned rather than left to a stray effect.

import type { SourceStats } from "../state/traceSource";

/** What the bar states, plus the session it states it about. */
export interface ImportBarState {
  /** The replay id this bar describes ("import:claude-code:<file>"). */
  sessionId: string;
  file: string;
  stats: SourceStats;
  /** A format's own extra sentence (the VS Code export's), or null. */
  note: string | null;
}

/**
 * The bar to render, if any.
 *
 * @param bar     the bar the last import raised, or null once dismissed
 * @param session the replay currently on screen, null for the live session
 * @return the bar when it describes THAT session, otherwise nothing
 */
export function shownImportBar(bar: ImportBarState | null, session: string | null): ImportBarState | null {
  return bar !== null && bar.sessionId === session ? bar : null;
}
