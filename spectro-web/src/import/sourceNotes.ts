// What a transcript line says that no frame carries.
//
// Stage 1 made every imported line reachable. Most of what it exposed belongs
// in the source pane and nowhere else: identifiers, plumbing, constants. A
// small set of fields is different — each one is something a person goes
// looking for and cannot find anywhere in the app today. Those get read out of
// the line here and worn as a chip on the frame the line produced.
//
// THE RULE, for every field in this file: a line that does not carry it
// produces NOTHING. Not an empty chip, not a dash, not a blank column. The
// majority of real transcripts predate most of these fields (3100 of 4496 carry
// no effort at all), and a chip that renders empty on the common case is worse
// than no chip. Every reader below therefore returns nothing rather than a
// placeholder, and every one of them is pinned on its absent case first.
//
// Nothing here touches events.ts: these are readings of somebody else's file,
// not events on our wire.

/** One thing a line says about the turn it produced. */
export type SourceNote = {
  /** How hard the model was told to think on this turn ("xhigh", "max", …). */
  kind: "effort";
  /** The level verbatim. Five are in the corpus and the next one is not ours
   *  to predict, so an unknown word travels rather than being dropped. */
  value: string;
};

/** Every note kind, for the dictionary's coverage test. */
export const SOURCE_NOTE_KINDS = ["effort"] as const;

/** Cheap prefilter: a line that names none of these cannot produce a note, and
 *  a real transcript is mostly such lines. Parsing all of them would mean a
 *  second full parse of a file that can run to 80 MB. */
const CANDIDATE = ['"effort"'];

/**
 * What one line of an imported transcript says beyond its frames.
 *
 * @param line one raw line of the file, exactly as it was read
 * @return the notes, in a fixed order; empty for a line that says none of this,
 *         including a line that does not parse
 */
export function readSourceNotes(line: string): SourceNote[] {
  if (!CANDIDATE.some((c) => line.includes(c))) return [];
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return []; // a line we cannot read is a line we know nothing about
  }
  if (rec === null || typeof rec !== "object") return [];
  const notes: SourceNote[] = [];
  const effort = (rec as { effort?: unknown }).effort;
  if (typeof effort === "string" && effort !== "") notes.push({ kind: "effort", value: effort });
  return notes;
}

/**
 * The notes of a whole imported file, by line.
 *
 * Sparse on purpose: only lines that carry something appear, so a row's lookup
 * misses in the common case and costs nothing. Built once per import, and each
 * entry is a stable array — the trace rows are memoized and a fresh array per
 * render would re-render the whole list during a delta flood.
 *
 * @param lines the import's own lines, or null/undefined for a session that was
 *              produced here and has no separate source
 */
export function sourceNoteIndex(
  lines: readonly string[] | null | undefined,
): ReadonlyMap<number, readonly SourceNote[]> {
  const index = new Map<number, readonly SourceNote[]>();
  if (!lines) return index;
  for (let i = 0; i < lines.length; i++) {
    const notes = readSourceNotes(lines[i]);
    if (notes.length > 0) index.set(i, notes);
  }
  return index;
}
