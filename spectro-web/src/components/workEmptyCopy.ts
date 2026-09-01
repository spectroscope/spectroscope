// Card 338 — the empty work panel's copy, derived from the fold's own kinds.
//
// One function, and it exists so that the panel and the guard beside it agree
// by CONSTRUCTION rather than by two people typing the same three strings. The
// panel renders `WORK_KINDS.map(kindLineKey)`; the drift test walks the same
// array through the same function and asks the dictionary to answer. A fourth
// kind therefore has exactly one way to arrive: with a line of copy.

import type { WorkKind } from "../state/work";

/**
 * The i18n key of the sentence that says what one kind IS and where it comes
 * from.
 *
 * <p>Deliberately not the same key as {@code work.kind.<kind>}: that one is the
 * short chip label a row wears ("fan-out", "background"), and a chip label is
 * not an explanation. The empty state needs the provenance, because provenance
 * is the whole finding — two of the three kinds are real and neither of them
 * comes from the window the reader is looking at.</p>
 *
 * @param kind one of {@code WORK_KINDS}
 * @return the dictionary key for its line
 */
export function kindLineKey(kind: WorkKind): string {
  return `work.kindLine.${kind}`;
}
