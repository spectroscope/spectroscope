// One row per session (card 458).
//
// The rail used to carry a hardwired "Live session" row for the socket this
// page holds, and the stored row of the same session beside it. The owner:
// "Einen Eintrag für die Session, und wenn man da draufklickt, kann man
// weiterschreiben." So the held sessions are merged INTO the stored list here,
// keyed by id, and the click is decided here too. Pure functions, so the rule
// is tested without a DOM.

import type { SessionMeta } from "../events";
import type { RunState } from "../components/runIndicator";

/** A session this page holds a socket to, as the rail needs it. */
export interface HeldRow {
  readonly id: string;
  /** The first prompt of the session, the row's title until a real one lands. */
  readonly firstPrompt: string;
  /** When the page learned the session, epoch ms. Orders a row with no file yet. */
  readonly startedAt: number;
  readonly running: boolean;
  /** Card 459: what the row asks of the reader, if anything (state/sessionSet.ts). */
  readonly attention: "answer" | "model" | null;
}

/**
 * The stored list with the held sessions merged in, every id exactly once.
 *
 * A held session that is already stored keeps its stored row, title and pin
 * included. One the store does not list yet (a fresh session before its file
 * shows up in the list) goes to the top, drawn from its first prompt.
 *
 * @return the stored list itself when nothing new is added
 */
export function mergeHeldRows(stored: SessionMeta[], held: readonly HeldRow[]): SessionMeta[] {
  const known = new Set(stored.map((row) => row.id));
  const fresh = held.filter((row) => !known.has(row.id));
  if (fresh.length === 0) return stored;
  const rows: SessionMeta[] = [...fresh]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((row) => ({
      id: row.id,
      startedAt: row.startedAt,
      firstPrompt: row.firstPrompt,
      tokens: 0,
      stopReason: null,
    }));
  return [...rows, ...stored];
}

/** The dot of a row this page holds: a socket is attached, so it is live. */
export function heldRunState(row: HeldRow): RunState {
  return row.running ? "running" : "live";
}

/** What a click on a session row does. */
export type OpenDecision = { kind: "select"; id: string } | { kind: "open"; id: string };

/**
 * Decides a click on a session row. A session this page holds is selected, its
 * socket untouched; any other one opens. Card 458's lock (no other row while
 * one runs) is gone with card 459: a running session keeps its socket while
 * another is in view.
 *
 * @param opts.held the sessions this page holds
 */
export function openDecision(id: string, opts: { held: readonly HeldRow[] }): OpenDecision {
  if (opts.held.some((row) => row.id === id)) return { kind: "select", id };
  return { kind: "open", id };
}

/** Why a replayed session cannot be continued from here. */
export type ReadOnlyReason = "import" | "scenario" | "elsewhere";

/** What stands where the composer would be, for a session opened from the list. */
export type ReplayComposer = { kind: "continue" } | { kind: "readOnly"; reason: ReadOnlyReason };

/**
 * Whether a replayed session gets the composer.
 *
 * An import and a scenario have no file on this server to append to. A session
 * another window holds is refused by the server as a second writer (card 212),
 * so it opens read-only and says so instead of failing on the first message.
 *
 * @param opts.liveElsewhere session ids another socket on this server holds
 */
export function replayComposer(id: string, opts: { liveElsewhere: readonly string[] }): ReplayComposer {
  if (id.startsWith("import:")) return { kind: "readOnly", reason: "import" };
  if (id.startsWith("scenario:")) return { kind: "readOnly", reason: "scenario" };
  if (opts.liveElsewhere.includes(id)) return { kind: "readOnly", reason: "elsewhere" };
  return { kind: "continue" };
}

/** What a delete from the row menu has to do first (card 459, owner call 2). */
export type DeleteQuestion = "plain" | "releaseFirst" | "stopFirst" | "refused";

/**
 * Decides a delete from a row's menu.
 *
 * A session this page holds is let go before its file is deleted, or its
 * socket would append to a recreated file; a running one asks "still running,
 * stop it and delete?" first. A session another window holds is not deleted
 * from here: this page cannot stop that run.
 */
export function deleteQuestion(
  id: string,
  opts: { held: readonly HeldRow[]; liveElsewhere: readonly string[] },
): DeleteQuestion {
  const mine = opts.held.find((row) => row.id === id);
  if (mine !== undefined) return mine.running ? "stopFirst" : "releaseFirst";
  if (opts.liveElsewhere.includes(id)) return "refused";
  return "plain";
}

/** The i18n key of the one line a read-only session shows instead of the composer. */
export function readOnlyKey(reason: ReadOnlyReason): string {
  return `arch.readOnly.${reason}`;
}
