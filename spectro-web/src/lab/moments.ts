// Card 309A: the run's chapter marks as rows somebody can read.
//
// WHAT WAS WRONG. Card 299 found the moments — turn, spawn, compaction, gate,
// refusal, question, intervention, no_progress, error, skill, end — and put
// them on the scrub bar as 11px ticks. That is orientation, and it stays. But
// the only way to READ one was to hover it for a single line, one tick at a
// time, and the bar has to THIN the row before it can draw it: a 60-turn run
// puts 61 ticks 1.65% apart, closer than a pointer can aim, so marks get
// dropped. The moments a reader came looking for are exactly the rare ones the
// thinning was written to protect, and they were the hardest to reach.
//
// WHERE IT GOES AND WHY THERE. The dock, as a fourth tab beside context,
// handovers and files: it has width, it scrolls, and card 301 already made it
// mount exactly one panel at a time. The transport row has none of that — card
// 303 measured it collapsing to 4px at a 771px viewport — so a wrapping strip
// of pills under the scrub would hand back the crowding this panel exists to
// escape.
//
// THIS FOLD IS LANGUAGE-FREE, like chapterMarks itself. It answers three
// questions and no others: which step a moment sits in, what cursor a click
// seeks to, and whose moment it is. The sentence is chapterLabel's job and the
// pixels are MomentList's.

import type { RunEvent } from "../events";
import type { ChapterKind, ChapterMark } from "../state/stepper";
import { chapterMarks, stepBoundaries, stepOfEvent } from "../state/stepper";

/** One moment of the run, as a row. */
export interface Moment {
  /** The mark itself — the evidence, unrewritten. */
  mark: ChapterMark;
  /** The coarse step that shows it: the number the transport's own counter
   *  reads once the seek below has landed. */
  step: number;
  /** How many events a click applies. Exactly `boundaries[step]`, which is
   *  exactly what the scrub tick seeks to (pinned in moments.test.ts) — two
   *  surfaces pointing at one moment must not name two places. */
  cursor: number;
  /** Whose moment it is, or null where the wire names nobody. NOT a handle: a
   *  panel resolves this through agentDirectory, because a raw agent id is the
   *  thing card 298 exists to keep off a screen. */
  agentId: string | null;
}

/**
 * The word a reader sees for one kind — never the wire enum. `no_progress`
 * printed as itself is a field name, not a sentence.
 *
 * A Record over the whole union on purpose, the same way MARK_RANK is: a
 * twelfth kind will not COMPILE until somebody has given it a KEY. That is all
 * the compiler can ask for, and this comment used to claim more — it said the
 * WORD, and a twelfth kind whose key pointed at a dictionary entry nobody had
 * written compiled clean and ran the whole suite green (measured). The word is
 * asked for one step later instead: moments.test.ts and LabDock.test.tsx read
 * their kind lists out of THIS Record rather than copying it, so the same
 * twelfth kind is red until the entry exists in both locales and a row on
 * screen shows it.
 */
export const MOMENT_KIND_KEY: Record<ChapterKind, string> = {
  turn: "lab.moment.kind.turn",
  spawn: "lab.moment.kind.spawn",
  compaction: "lab.moment.kind.compaction",
  gate: "lab.moment.kind.gate",
  denied: "lab.moment.kind.denied",
  no_progress: "lab.moment.kind.noProgress",
  intervention: "lab.moment.kind.intervention",
  question: "lab.moment.kind.question",
  skill: "lab.moment.kind.skill",
  error: "lab.moment.kind.error",
  end: "lab.moment.kind.end",
};

/** The agent an event names itself, or null. `error` carries `agentId` as an
 *  OPTIONAL field and `run_end` carries none at all, so this reads rather than
 *  assumes. */
function namedAgent(e: RunEvent): string | null {
  const id = (e as { agentId?: unknown }).agentId;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Fold the run into its moments.
 *
 * NOTHING IS THINNED HERE. The bar thins because ticks that touch cannot be
 * aimed at; a scrolling list has no such floor, and the moments the bar had to
 * drop are the reason this panel was asked for.
 *
 * @param events the stream to read — applied plus queued, the whole run, so a
 *   row can seek FORWARD to a moment that has not been stepped to yet, exactly
 *   as a tick on the far half of the bar already does
 * @return one row per mark, in the run's own order
 */
export function momentsOf(events: readonly RunEvent[]): Moment[] {
  const boundaries = stepBoundaries(events);

  // A permission_decision carries a callId and NO agentId — the one kind whose
  // attribution has to be looked up. The link to the request that asked is a
  // record, not a guess; where the stream holds no such request the row stays
  // unattributed, because naming the wrong agent on the row that says something
  // was stopped is worse than naming none.
  const asker = new Map<string, string>();
  for (const e of events) if (e.type === "permission_request") asker.set(e.callId, e.agentId);

  return chapterMarks(events).map((mark) => {
    const e = events[mark.at];
    const agentId = e.type === "permission_decision" ? (asker.get(e.callId) ?? null) : namedAgent(e);
    const step = stepOfEvent(boundaries, mark.at);
    return { mark, step, cursor: boundaries[step], agentId };
  });
}
