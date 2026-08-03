// The todo list an imported transcript carries (card 141), read as a list.
//
// A `task_reminder` attachment is the agent's own todo list with a status on
// every item. It is 26% of all attachments in the corpus and the single most
// frequent thing the importer used to leave on the floor. Rendering it as one
// compact json string puts a wall of braces in a column that ellipsizes, which
// is what the card refused: the most interesting thing on the discard pile
// would have arrived unreadable.
//
// Pure module: no React, no DOM. The markup lives in TraceView, the wire
// reading lives here, so what can drift is unit-tested.
//
// THE ITEM SHAPE, measured over 4,554 transcripts and 30,780 items:
//   id, subject, description, status, blocks, blockedBy   30,780 (all of them)
//   activeForm                                            29,177 (94.8%)
//   owner                                                    350  (1.1%)
//   blocks non-empty 678 (2.2%) · blockedBy non-empty 668 (2.2%)
//   statuses: completed 24,791 · pending 4,346 · in_progress 1,643, and nothing
//   else in the whole corpus
//   id is an ordinal, "1" to "36", which is what blocks and blockedBy point at
//
// Two rules follow from those numbers, and both are the card's own:
//   1. A field is carried only where the item carried something. blocks and
//      blockedBy are PRESENT AND EMPTY on 97.8% of items, so rendering them
//      unconditionally would print a label with nothing after it thirty
//      thousand times, which is the blank cell card 139 turned the model
//      column down for.
//   2. A list is rendered whole or not at all. An item with no subject or no
//      status has no line to draw; drawing the others and dropping it would
//      hide a task behind a prettier rendering. Refusing hands the reader back
//      the raw json, where every field is still on screen.

import { dict, t, type Lang } from "../i18n/i18n";

/**
 * Chrome label for a wire status; unknown statuses pass through unchanged
 * (forward compatibility, and the wire stays English either way).
 *
 * One vocabulary for the three statuses, in one place. It used to live in
 * PlanTab, which is a component: a second copy for the trace is how a task
 * ends up "done" in one panel and "completed" in the next. PlanTab reads it
 * from here now.
 */
export function statusLabel(status: string, lang: Lang = "en"): string {
  return dict[`plan.${status}`] !== undefined ? t(lang, `plan.${status}`) : status;
}

/** One item of somebody else's todo list, with every optional field absent
 *  rather than blank when the file did not carry it. */
export interface TodoItem {
  /** The file's own ordinal, which is what blockedBy and blocks point at. */
  id: string;
  /** The task, one line (102 characters at the longest measured). */
  subject: string;
  /** What the task actually is, up to 1,661 characters and never multi-line.
   *  Absent when the item repeats its subject there (171 items do). */
  description?: string;
  /** The present-tense caption the client shows while an item is in flight.
   *  Carried only on the running item: it describes an activity, and on a
   *  finished one it would be a second title in the wrong tense. */
  activeForm?: string;
  /** The agent that owns the item, on 350 of 30,780. */
  owner?: string;
  /** The items this one holds up, when there are any. */
  blocks?: readonly string[];
  /** The items holding this one up, when there are any. */
  blockedBy?: readonly string[];
  /** The wire status, verbatim: completed, in_progress, pending, or whatever
   *  a later client writes. Never translated here, only labelled. */
  status: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string field, or null. */
function text(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** A non-empty list of strings, or undefined: an empty array is a field the
 *  item does not have, not a field with nothing in it. */
function ids(r: Record<string, unknown>, key: string): readonly string[] | undefined {
  const v = r[key];
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === "string" && x !== "");
  return list.length > 0 ? list : undefined;
}

/**
 * Read a `task_reminder`'s items as a list this app can draw.
 *
 * @param value the frame's `items` field, whatever it holds
 * @return the items in the file's own order, or null when the list cannot be
 *         drawn whole (nothing there, not a list, or one item with no subject
 *         or no status). Null means the caller shows the raw shape instead.
 */
export function readTodoItems(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: TodoItem[] = [];
  for (const raw of value) {
    const r = asRecord(raw);
    if (r === null) return null;
    const subject = text(r, "subject");
    const status = text(r, "status");
    if (subject === null || status === null) return null;
    const description = text(r, "description");
    const activeForm = text(r, "activeForm");
    items.push({
      id: text(r, "id") ?? String(items.length + 1),
      subject,
      status,
      // Said once. The subject and the description are the same sentence on
      // 171 items, and printing it under itself is noise, not evidence.
      ...(description !== null && description !== subject ? { description } : {}),
      ...(status === "in_progress" && activeForm !== null && activeForm !== subject ? { activeForm } : {}),
      ...(text(r, "owner") !== null ? { owner: text(r, "owner") as string } : {}),
      ...(ids(r, "blocks") !== undefined ? { blocks: ids(r, "blocks") } : {}),
      ...(ids(r, "blockedBy") !== undefined ? { blockedBy: ids(r, "blockedBy") } : {}),
    });
  }
  return items;
}

/** The three statuses the corpus has, in the lifecycle's order, which is the
 *  order the plan dict already lists them in. A status nobody has seen yet
 *  keeps its place after these, in the order the list first shows it, rather
 *  than falling out of the count. Exported so the dict is checked against it:
 *  a status without a word ships as its bare wire name. */
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

/**
 * Count a todo list by status.
 *
 * @param items the list, in the file's order
 * @return one entry per status the list actually has, known statuses first in
 *         lifecycle order, then unknown ones as first seen. A status the list
 *         does not have is never named: a zero would be a fact about nothing.
 */
export function todoCounts(items: readonly TodoItem[]): { status: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const out: { status: string; n: number }[] = [];
  for (const status of TODO_STATUSES) {
    const n = counts.get(status);
    if (n !== undefined) {
      out.push({ status, n });
      counts.delete(status);
    }
  }
  for (const [status, n] of counts) out.push({ status, n });
  return out;
}

/**
 * The word a COUNT of items in one status reads as.
 *
 * Not statusLabel, and the difference is the whole point. A badge labels one
 * item and says "läuft …"; a count follows a number, and "2 läuft …" is not a
 * German sentence. The live pass found it in German, where it is loud; English
 * would have hidden it, because "2 running" happens to work either way.
 *
 * @param status the wire status
 * @param lang   the chrome language
 * @return the counting word, or the wire status when there is no word for it
 */
function countLabel(status: string, lang: Lang): string {
  return dict[`trace.todo.${status}`] !== undefined ? t(lang, `trace.todo.${status}`) : status;
}

/**
 * The one line a collapsed trace row shows for a todo list.
 *
 * @param items the list
 * @param lang  the chrome language
 * @return the counts, in the app's own words for the three statuses; empty for
 *         an empty list, so the caller can fall back to the raw frame
 */
export function todoSummary(items: readonly TodoItem[], lang: Lang): string {
  return todoCounts(items)
    .map((c) => `${c.n} ${countLabel(c.status, lang)}`)
    .join(" · ");
}
