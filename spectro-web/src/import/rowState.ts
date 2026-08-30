// Whether the import dialog may offer a transcript, and what to say when it may
// not. The dialog used to render every row in the store as a clickable button
// and find out on the click: the owner's 73.6 MB transcript sat in the list
// looking exactly like the loadable ones, and answered with a bare status code.
//
// Pure module: a listing row plus what the listing published about its own limit
// go in, one state comes out. ImportDialog is wiring.
//
// TWO bands, not three. There is deliberately no "this one will be slow"
// warning, and that is a measurement rather than an omission. Across the 20
// largest transcripts in the real store on 2026-08-03, line density ran from
// 42.8 to 257.6 lines per MiB, a six-fold spread, and average line length from
// 4.1 kB to 24.5 kB. Render cost is per row, so at any byte threshold a warning
// would fire on the wrong files in both directions. Counting lines would predict
// it, but that means reading every file in the listing, which is the cost the
// listing exists to avoid. So bytes govern the ceiling, where they are the
// actual fact, and govern nothing else.

import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";
import type { TranscriptFacts } from "./transcriptFacts";

/** One row of GET /api/claude/transcripts. */
export interface TranscriptRow {
  path: string;
  project: string;
  file: string;
  size: number;
  modifiedAt: number;
  /** The server's verdict on whether content() will serve this file. Absent from
   *  a server older than this field, which is why it is optional and why its
   *  absence means "no opinion" rather than "no". */
  loadable?: boolean;
}

/** What the listing published alongside its rows. */
export interface StoreLimits {
  /** The largest transcript the content endpoint will serve. */
  limitBytes: number;
  /** Whether the row cap dropped transcripts the store really holds. Absent from
   *  a server older than this field, which means "did not say" rather than "no". */
  truncated?: boolean;
}

/**
 * What the dialog may do with a row.
 *
 * There is deliberately no partial member. Card 116 removed the 5000-row import
 * truncation on the ground that a trace is evidence and a transcript that
 * silently begins in the middle has lost the part saying how the incident
 * started; announcing the truncation would not hand the beginning back. Anything
 * this module enables loads whole.
 */
export type RowState =
  { enabled: true; kind: "whole" } | { enabled: false; kind: "too-large"; reason: string };

const MIB = 1024 * 1024;

/**
 * Byte sizes the way the listing row already prints them, so the row label and
 * the refusal underneath it cannot disagree about the same file.
 *
 * @param bytes the size to render
 * @returns "73.6 MB" at a mebibyte and above, "41 kB" below it, never "0 kB"
 */
export function formatBytes(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/**
 * Why a row's click takes the session-file door instead of the run door.
 *
 * Two codes, and they are bitten apart on purpose: both end at the same single
 * file, and one code for the pair would let the dialog print "the agents were
 * left behind" over a session that never had any. Exported because the sentence
 * under the row is keyed on the CODE — a degrade matched by a prose substring
 * goes soft the day somebody rewords the copy, and rewording copy is the one
 * thing that happens to every string in this product.
 */
export const RUN_DOOR_REASONS = ["noAgents", "tooLarge"] as const;

/** One of {@link RUN_DOOR_REASONS}. */
export type RunDoorReason = (typeof RUN_DOOR_REASONS)[number];

/**
 * Which door a row's click takes, and the number the reader is told first.
 *
 * The owner, watching a session open with none of its agents: "you do not want
 * to be told: go find the folder yourself". So the DEFAULT is the run, the
 * session-file-only path stays reachable and clearly secondary, and a refusal
 * degrades loudly rather than back into something that looks like the old
 * behaviour.
 *
 * `agents` is not a second counter. It is the same number the row's
 * `workflow-agents xN` chip prints, off the same fold, because two counts of
 * one thing on one screen is how a panel starts contradicting itself.
 */
export type RowPlan =
  { door: "run"; agents: number } | { door: "session"; reason: RunDoorReason; agents: number };

/**
 * The one place that decides whether an import row is clickable.
 *
 * The server owns the verdict. This module never compares the size against a
 * ceiling of its own: a client that re-derives the comparison is how a `>`
 * drifts into a `>=` and the dialog starts offering the one file the server
 * refuses. The published limit is read only to say how far over the line a
 * refused file sits.
 *
 * @param row the listing row
 * @param limits what the same listing published about its limit, or null when
 *        the server did not say (an older build), in which case nothing here
 *        invents a number to refuse on
 * @param lang the UI-chrome language
 * @returns whether the row may be clicked, and why not when it may not
 */
export function rowState(row: TranscriptRow, limits: StoreLimits | null, lang: Lang): RowState;
/**
 * The same verdict, plus the door — for a caller that has asked about the row's
 * contents, whether or not the answer has landed.
 *
 * @param facts what the facts endpoint said about this row, or undefined when
 *        it has not answered yet: absent means "did not say", never zero
 */
export function rowState(
  row: TranscriptRow,
  limits: StoreLimits | null,
  lang: Lang,
  facts: TranscriptFacts | undefined,
): RowState & { plan: RowPlan };
export function rowState(
  row: TranscriptRow,
  limits: StoreLimits | null,
  lang: Lang,
  // A REST parameter, and it is load-bearing. JavaScript cannot tell an omitted
  // argument from an explicit `undefined` any other way, and those two are
  // different questions here: "just tell me if it is clickable" against "the
  // facts have not landed yet, which door do I take?". The second has an
  // answer — the run — and the first must not grow a field its callers never
  // asked for.
  ...asked: (TranscriptFacts | undefined)[]
): (RowState & { plan: RowPlan }) | RowState {
  const verdict = verdictOf(row, limits, lang);
  if (asked.length === 0) return verdict;
  const plan = doorFor(verdict.enabled, asked[0]);
  return verdict.enabled
    ? { enabled: true, kind: "whole", plan }
    : { enabled: false, kind: "too-large", reason: verdict.reason, plan };
}

/**
 * Which door, off the facts the dialog already holds for the row.
 *
 * Direct spawns count as much as a workflow run's do: 15% of the agent
 * transcripts in the real store are `Task` spawns under `subagents/` rather
 * than under a run directory, and a plan that read only `workflowAgents` would
 * send exactly those sessions down the session-only door with their agents one
 * directory away.
 *
 * Facts that have not landed take the run door. The list never waits for facts,
 * so a click can land on a row that has not filled in, and guessing "no agents"
 * there is the silence this card removes; guessing the other way costs nothing,
 * because a session with nothing beside it answers a bundle with empty arrays
 * and the merge of zero sidecars is today's single-file import byte for byte.
 *
 * @param loadable the server's verdict on the session file itself
 * @param facts what is known about the row, or undefined
 * @return the door, with the count the row is about to print
 */
function doorFor(loadable: boolean, facts: TranscriptFacts | undefined): RowPlan {
  const agents = (facts?.workflowAgents ?? 0) + (facts?.subagents ?? 0);
  // The session file itself is over the server's ceiling, so there is no run to
  // bring and no agents were left behind — a different fact from having none.
  if (!loadable) return { door: "session", reason: "tooLarge", agents };
  if (facts === undefined || agents > 0) return { door: "run", agents };
  return { door: "session", reason: "noAgents", agents };
}

/**
 * The verdict alone, unchanged since card 116.
 *
 * @param row the listing row
 * @param limits what the listing published about its limit, or null
 * @param lang the UI-chrome language
 * @return whether the row may be clicked, and why not when it may not
 */
function verdictOf(row: TranscriptRow, limits: StoreLimits | null, lang: Lang): RowState {
  if (row.loadable !== false) return { enabled: true, kind: "whole" };

  const size = formatBytes(row.size);
  const de = lang === "de";
  // Inline pair rather than an i18n key: a sibling workflow holds i18n.ts this
  // run. Same pattern and same reason as WorkspaceTab.tsx:370, folds back under
  // card 64.
  const reason =
    limits === null
      ? de
        ? `${size}, zu groß für diesen server`
        : `${size}, too large for this server`
      : de
        ? `${size}, dieser server liest höchstens ${formatBytes(limits.limitBytes)}`
        : `${size}, this server reads at most ${formatBytes(limits.limitBytes)}`;

  return { enabled: false, kind: "too-large", reason };
}

/**
 * What to say when the listing is not all of the store.
 *
 * The dialog rendered whatever rows arrived, so a transcript dropped by the row
 * cap was simply absent and nothing said it had been cut. A refused row at
 * least explains itself; a missing one reads as "the file is not in the store",
 * which sends the reader looking in the wrong place. The Files tree next door
 * has said this out loud since it was written.
 *
 * @param limits what the listing published about its limits, or null when the
 *        server did not answer at all
 * @param shown how many rows the dialog actually has
 * @param lang the UI-chrome language
 * @returns the notice, or null when the listing is complete or says nothing
 */
export function listingNotice(limits: StoreLimits | null, shown: number, lang: Lang): string | null {
  if (limits === null || limits.truncated !== true) return null;
  return t(lang, "imp.truncated", { n: shown });
}
