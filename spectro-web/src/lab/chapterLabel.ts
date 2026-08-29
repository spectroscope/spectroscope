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
