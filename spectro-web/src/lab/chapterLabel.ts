// Card 299: a chapter mark, as the line a person reads.
//
// The split is on purpose. `chapterMarks` (state/stepper.ts) reads the stream
// and stays free of any language; this module owns the sentence, in both
// locales, and owns the one place a mark needs a SECOND lookup: a run_end tick
// says why the run ended, and that vocabulary already has a dictionary of its
// own. Reading it through `stopReasonKey` is what keeps the tick and the
// transcript footer from drifting into two different words for one stop.

import type { AgentDirectory } from "./agentDirectory";
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
 * screen, so the id is swapped for the child's handle. Every other kind passes
 * straight through to `chapterLabel`, and moments.test.ts holds that identity,
 * so the tick and the row can never drift into two words for one moment.
 *
 * THE TOOLTIP READS THIS TOO, since the fix round. The first build let the
 * scrub tick keep `chapterLabel` on the argument that a tooltip is a smaller
 * surface than a list row. It is a smaller surface with the same id on it: card
 * 298 does not ask how many pixels the leak is wide. `LabTransport` now resolves
 * its spawn marks through `markTag` against the very directory the panel uses.
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

/**
 * The handle of the agent one mark is about, or null where nothing can name it.
 *
 * Only a spawn mark names an agent in its OWN vars — every other kind is about
 * something the run did, and the tick's sentence never says who. Reading the id
 * out of `vars` rather than off the event keeps this usable from the transport,
 * which holds the marks and not the frames they came from; `momentsOf` reaches
 * the same id by the other route and moments.test.ts pins the two together.
 *
 * @param mark the mark to name
 * @param dir the directory built over the same stream the mark was read from
 * @return the short handle ("w3"), or null — never the raw id, whatever happens
 */
export function markTag(mark: ChapterMark, dir: AgentDirectory): string | null {
  if (mark.kind !== "spawn") return null;
  const id = mark.vars.id;
  return typeof id === "string" ? (dir.get(id)?.tag ?? null) : null;
}
