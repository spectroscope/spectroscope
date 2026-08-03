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
export function rowState(row: TranscriptRow, limits: StoreLimits | null, lang: Lang): RowState {
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
