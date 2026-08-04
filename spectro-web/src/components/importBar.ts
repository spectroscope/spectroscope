// The bar that says what an import was, and which session it belongs to.
//
// The bar is dismissible, so holding it in its own state is right. What was
// missing is the other half: it describes ONE loaded file, and the reader can
// leave that file without dismissing anything. Stamping the session id on the
// bar and checking it at render time is the whole fix, and it is a pure
// function so the rule is pinned rather than left to a stray effect.

import { t, type Lang } from "../i18n/i18n";
import type { SubagentTranscript } from "../import/subagentFile";
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

/**
 * What the bar says about a file that was one agent's transcript (card 152).
 *
 * A subagent transcript presented as an ordinary session is a second false
 * statement on top of the one the counts made: the reader is told this is a
 * session, when it is one agent lifted out of another session's run. The file
 * names its own agent, and often the session it ran under and the kind of agent
 * it was, so the bar can state all three without inventing any of them.
 *
 * Every clause is conditional, the rule import/sourceNotes.ts states in full: a
 * fact the file does not carry produces NOTHING, not a blank and not a
 * placeholder id. The parent session is a pointer to where the rest of the run
 * lives, which is the one thing a reader of this file goes looking for.
 *
 * @param lang the chrome language
 * @param sub  what the file said about itself, or nothing for a session file
 * @return the sentence, or null when there is nothing of the kind to say
 */
export function subagentNote(lang: Lang, sub: SubagentTranscript | null | undefined): string | null {
  if (!sub) return null;
  const parts = [t(lang, "imp.subagent", { agent: sub.agentId })];
  if (sub.attributionAgent !== undefined)
    parts.push(t(lang, "imp.subagentKind", { kind: sub.attributionAgent }));
  if (sub.sessionId !== undefined) parts.push(t(lang, "imp.subagentSession", { session: sub.sessionId }));
  return parts.join(" ");
}
