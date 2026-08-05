// The dialog's filter and its statistics line, both pure. The owner's ask, in
// his own words: "nur fable mit workflow oder opus mit subagenten" — a model
// AND a property, one conjunction across two axes. This module decides what
// matches, what is still unknown, and what the current selection adds up to;
// ImportDialog is wiring.
//
// Three-valued on purpose. A row whose facts have not arrived is neither a
// match nor a miss — it is pending, and it is reported as a number so the
// dialog can say "n rows not read yet" instead of quietly shrinking the list
// to whatever happened to be cached.

import type { TranscriptRow } from "./rowState";
import type { TranscriptFacts } from "./transcriptFacts";

/**
 * The property axis. Wire vocabulary, lowercase, exactly what the chips say:
 *
 * - `workflow`: the transcript body carries Workflow tool calls.
 * - `subagents`: agent transcripts exist beside the session — direct ones OR
 *   workflow-run ones. Stage 1 counted only the direct files and read
 *   "no fan-out" on exactly the sessions with the most fan-out; the chip
 *   treats both populations as agent activity, and the row label keeps them
 *   apart because they remain different facts.
 */
export type FilterProp = "workflow" | "subagents";

/** What the operator has selected. Within an axis: any-of. Across axes: AND. */
export interface FactsFilter {
  /** Selected model families, lowercase, from {@link modelFamily}. */
  models: string[];
  /** Selected properties, all of which must hold. */
  props: FilterProp[];
  /** Typed text, matched case-insensitively against name, project, models, prompt. */
  text: string;
}

/** The filter with nothing selected, which passes every row. */
export function emptyFilter(): FactsFilter {
  return { models: [], props: [], text: "" };
}

/** Whether anything is selected at all — the signal to start a facts sweep. */
export function filterIsActive(filter: FactsFilter): boolean {
  return filter.models.length > 0 || filter.props.length > 0 || filter.text.trim() !== "";
}

/**
 * The family behind a wire model id — the word the owner says out loud.
 * "claude-fable-5" is spoken as "fable", and the chip carries the spoken word
 * while the row's tooltip keeps the verbatim id.
 *
 * "<synthetic>" is deliberately kept, as "synthetic". Claude Code writes it as
 * the model on records it generated itself — API error turns, injected
 * messages — so it is a true marker of what is in the file, and hiding it
 * would make the one session whose API errored unfindable by exactly that
 * fact. Only the angle brackets go, because a chip is a word, not markup.
 *
 * @param id the model id as it travels on the wire
 * @returns the lowercase family token, never empty for a non-empty id
 */
export function modelFamily(id: string): string {
  const bare = id.toLowerCase().replace(/[<>]/g, "").trim();
  const tokens = bare.split(/[^a-z0-9]+/).filter((t) => t !== "");
  const spoken = tokens.filter((t) => !/^\d/.test(t) && t !== "claude");
  return spoken[0] ?? bare;
}

/** One row's verdict under a filter. */
type Verdict = "match" | "miss" | "pending";

/** What a filter pass hands back: the rows that match, and how many cannot say yet. */
export interface FilterVerdict {
  rows: TranscriptRow[];
  /** Rows neither matched nor ruled out because their facts are not in. */
  pending: number;
}

/** How the dialog reads a row's facts — undefined until they land. */
export type FactsLookup = (row: TranscriptRow) => TranscriptFacts | undefined;

function agentActivity(facts: TranscriptFacts): number {
  return facts.subagents + (facts.workflowAgents ?? 0);
}

function holdsProp(facts: TranscriptFacts, prop: FilterProp): boolean {
  return prop === "workflow" ? facts.workflowCalls > 0 : agentActivity(facts) > 0;
}

function verdictFor(row: TranscriptRow, facts: TranscriptFacts | undefined, filter: FactsFilter): Verdict {
  let pending = false;

  if (filter.models.length > 0) {
    if (facts === undefined) {
      pending = true;
    } else if (!facts.models.some((id) => filter.models.includes(modelFamily(id)))) {
      return "miss";
    }
  }

  for (const prop of filter.props) {
    if (facts === undefined) {
      pending = true;
    } else if (!holdsProp(facts, prop)) {
      return "miss";
    }
  }

  const text = filter.text.trim().toLowerCase();
  if (text !== "") {
    const listed = `${row.file}\n${row.project}`.toLowerCase().includes(text);
    if (!listed) {
      if (facts === undefined) {
        // The listing said no, but the prompt and the models have not spoken.
        pending = true;
      } else {
        const folded = `${facts.models.join("\n")}\n${facts.firstPrompt ?? ""}`.toLowerCase().includes(text);
        if (!folded) {
          return "miss";
        }
      }
    }
  }

  return pending ? "pending" : "match";
}

/**
 * Runs the filter over the listing.
 *
 * @param rows the listing, in its own order
 * @param factsFor the facts store's lookup
 * @param filter what the operator selected
 * @returns matching rows in listing order, plus the count of rows that cannot
 *          answer yet — the dialog says that number out loud while the sweep runs
 */
export function applyFilter(
  rows: TranscriptRow[],
  factsFor: FactsLookup,
  filter: FactsFilter,
): FilterVerdict {
  if (!filterIsActive(filter)) {
    return { rows, pending: 0 };
  }
  const matched: TranscriptRow[] = [];
  let pending = 0;
  for (const row of rows) {
    const verdict = verdictFor(row, factsFor(row), filter);
    if (verdict === "match") {
      matched.push(row);
    } else if (verdict === "pending") {
      pending++;
    }
  }
  return { rows: matched, pending };
}

/**
 * What the current selection adds up to. Numbers only, nothing interpreted:
 * how many transcripts, the time they span, which model families in how many
 * sessions, and the workflow and agent totals.
 */
export interface SelectionStats {
  /** Rows in the selection. */
  count: number;
  /** Newest modifiedAt in the selection, 0 when it is empty. */
  newest: number;
  /** Oldest modifiedAt in the selection, 0 when it is empty. */
  oldest: number;
  /** Model family → sessions it spoke in, most sessions first. */
  models: [string, number][];
  workflowCalls: number;
  subagents: number;
  workflowAgents: number;
  /** Selected rows whose facts are not in — the totals above do not include them. */
  unread: number;
}

/**
 * Folds the selection into its statistics line.
 *
 * The time span comes from the listing and is therefore always complete; the
 * model and activity totals come from facts and therefore cover only the rows
 * that have answered, with {@link SelectionStats#unread} saying how many have
 * not. The dialog prints that number next to the totals, because a total that
 * silently omits forty rows is not a total.
 *
 * @param rows the selected rows
 * @param factsFor the facts store's lookup
 * @returns the numbers, never interpretation
 */
export function selectionStats(rows: TranscriptRow[], factsFor: FactsLookup): SelectionStats {
  let newest = 0;
  let oldest = 0;
  const families = new Map<string, number>();
  let workflowCalls = 0;
  let subagents = 0;
  let workflowAgents = 0;
  let unread = 0;

  for (const row of rows) {
    newest = newest === 0 ? row.modifiedAt : Math.max(newest, row.modifiedAt);
    oldest = oldest === 0 ? row.modifiedAt : Math.min(oldest, row.modifiedAt);
    const facts = factsFor(row);
    if (facts === undefined) {
      unread++;
      continue;
    }
    const spoke = new Set(facts.models.map(modelFamily));
    for (const family of spoke) {
      families.set(family, (families.get(family) ?? 0) + 1);
    }
    workflowCalls += facts.workflowCalls;
    subagents += facts.subagents;
    workflowAgents += facts.workflowAgents ?? 0;
  }

  const models = [...families.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { count: rows.length, newest, oldest, models, workflowCalls, subagents, workflowAgents, unread };
}
