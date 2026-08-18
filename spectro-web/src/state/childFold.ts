// Which children a v2 reader has opened (card 271), as pure data.
//
// v2 lifts a child's turns out of the main line and leaves a chip standing
// where it worked. Until card 271 that was the end of them: the transcript had
// a marker and the Work panel had a bill — a WorkItem carries numbers and one
// status line and has no field for text — so the child's own words were on
// screen in neither place. The chip now has a body. What lives in this module
// is only the question "is this one open", and the one rule that keeps opening
// it from moving the reader.
//
// THE KEY CARRIES THE VIEW, not just the child. Ids repeat: every run has a
// worker-1. App does not remount the chat when the reader opens an archive —
// the ChatV2 mount carries no `key`, it swaps props — so a set keyed on the id
// alone would show last week's archive already unfolded because this week's
// child was clicked.

import type { ThreadItem } from "./threads";

/** The open folds, as opaque keys. Treat as immutable: toggling returns a new one. */
export type ChildFolds = ReadonlySet<string>;

/** Nothing open — the shipped state, and what every view starts from. */
export const NO_FOLDS_OPEN: ChildFolds = new Set<string>();

/**
 * The key one child's fold is remembered under.
 *
 * <p>A NUL cannot occur in a viewKey (a session id, a fleet room) or in an
 * agent id, so the two halves can never run together into a third meaning.</p>
 *
 * @param viewKey which reading this is — "live", a replay id, a fleet room
 * @param agentId the child
 * @return a key unique to the pair
 */
export function foldKey(viewKey: string, agentId: string): string {
  return `${viewKey}\u0000${agentId}`;
}

/**
 * Whether this child's turns are showing.
 *
 * @param folds   the open set
 * @param viewKey which reading this is
 * @param agentId the child
 * @return true when the reader has opened it in THIS view
 */
export function isFoldOpen(folds: ChildFolds, viewKey: string, agentId: string): boolean {
  return folds.has(foldKey(viewKey, agentId));
}

/**
 * Open a closed child or close an open one.
 *
 * @param folds   the open set, left untouched
 * @param viewKey which reading this is
 * @param agentId the child
 * @return a NEW set — React compares by identity, and mutating in place would
 *         render nothing
 */
export function toggleFold(folds: ChildFolds, viewKey: string, agentId: string): ChildFolds {
  const next = new Set(folds);
  const key = foldKey(viewKey, agentId);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * How far to move the scroll container after a fold opened or closed — card
 * 271's criterion 5, stated here rather than left to the browser.
 *
 * <p>Opening a fold changes the scroll height. Two readers must both be left
 * alone, and they want opposite things:</p>
 *
 * <ul>
 *   <li>a reader PINNED to the bottom is watching the live edge. The bottom-pin
 *       effect in Chat already owns that case and puts them back at the bottom
 *       on the same render, so this rule stands aside and returns zero rather
 *       than fighting it for the same pixel;</li>
 *   <li>a reader who has scrolled up is reading something. Growth above them
 *       would slide it out from under their eyes, so the chip they clicked
 *       keeps the place it had on screen and everything else moves around it.</li>
 * </ul>
 *
 * <p>Card 257 (the chat's scroll) has NOT landed. This rule is written so 257
 * can absorb it rather than collide with it: it does not set the pin, it reads
 * it.</p>
 *
 * @param input pinned — whether the reader sits at the live edge;
 *              topBefore/topAfter — the clicked chip's distance from the top of
 *              the viewport, measured before the toggle and after the layout
 * @return the pixels to ADD to scrollTop; zero means do not touch it
 */
export function foldScrollDelta(input: { pinned: boolean; topBefore: number; topAfter: number }): number {
  if (input.pinned) return 0;
  return input.topAfter - input.topBefore;
}

/**
 * Which children of one chip are showing, and with which turns — the decision a
 * click leads to, made as pure data so it can be pinned without a browser.
 *
 * <p>The order is the CHIP's, not the reader's: a fan-out chip lists its
 * children in the order they first spoke, and opening the second one must not
 * move it above the first. An open child the grouping recorded no turns for is
 * left out entirely rather than drawn as an empty bordered box, which would
 * read as a rendering fault.</p>
 *
 * @param threads the chip's own record — child id to that child's turns
 * @param workIds the chip's children, in the order it names them
 * @param folds   what this reader has opened
 * @param viewKey which reading this is
 * @return one entry per open child that has something to show, chip order
 */
export function foldedTurns(
  threads: Record<string, ThreadItem[]>,
  workIds: readonly string[],
  folds: ChildFolds,
  viewKey: string,
): { agentId: string; items: ThreadItem[] }[] {
  const out: { agentId: string; items: ThreadItem[] }[] = [];
  for (const agentId of workIds) {
    if (!isFoldOpen(folds, viewKey, agentId)) continue;
    const items = threads[agentId];
    if (items === undefined || items.length === 0) continue;
    out.push({ agentId, items });
  }
  return out;
}
