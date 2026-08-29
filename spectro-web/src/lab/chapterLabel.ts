// Card 299: a chapter mark, as the line a person reads.
//
// The split is on purpose. `chapterMarks` (state/stepper.ts) reads the stream
// and stays free of any language; this module owns the sentence, in both
// locales, and owns the one place a mark needs a SECOND lookup: a run_end tick
// says why the run ended, and that vocabulary already has a dictionary of its
// own. Reading it through `stopReasonKey` is what keeps the tick and the
// transcript footer from drifting into two different words for one stop.

import { t } from "../i18n/i18n";
import type { Lang } from "../i18n/i18n";
import type { ChapterMark } from "../state/stepper";
import { stopReasonKey } from "../state/stopReason";

/**
 * The line one chapter tick shows.
 *
 * @param mark what chapterMarks read off the run
 * @param lang the reader's language
 * @return the sentence, placeholders filled
 */
export function chapterLabel(mark: ChapterMark, lang: Lang): string {
  if (mark.kind === "end") {
    const reason = String(mark.vars.reason ?? "");
    // stop.other prints the raw word inside a sentence, so an unknown reason
    // still reads as one — see stopReason.ts.
    return t(lang, mark.labelKey, { reason: t(lang, stopReasonKey(reason), { reason }) });
  }
  return t(lang, mark.labelKey, mark.vars);
}

/**
 * The same line, for a row in the moments panel rather than a tick's tooltip.
 *
 * ONE MARK NEEDS THE DIFFERENCE. `lab.mark.spawn` was written for an 11px
 * tooltip and prints the child's RAW agent id — on a real run a `toolu_…` or a
 * ULID, which is exactly what card 298 built the directory to keep off a
 * screen. A tooltip you have to hover is one thing; a list you read is another,
 * so the id is swapped for the child's handle. Every other kind passes straight
 * through to `chapterLabel`, and moments.test.ts holds that identity, so the
 * tick and the row can never drift into two words for one moment.
 *
 * @param mark the mark the row is about
 * @param agentTag the handle agentDirectory gave that agent, or null when it
 *   holds none — and then the line says "a child agent" rather than printing an
 *   id it could not resolve
 * @param lang the reader's language
 */
export function momentLabel(mark: ChapterMark, agentTag: string | null, lang: Lang): string {
  if (mark.kind !== "spawn") return chapterLabel(mark, lang);
  return agentTag === null
    ? t(lang, "lab.mark.spawn.unnamed")
    : t(lang, mark.labelKey, { ...mark.vars, id: agentTag });
}
