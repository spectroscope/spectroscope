// The file, around the line a picture came from.
//
// The owner, after learning where his pictures actually live: "wäre cool einen
// schalter zu haben das base64 jpeg zu sehen und eben DIE DATEI, wo der string
// drinne steht … WO genau in der datei mit highlight das steht und dann vorher
// und nachher der datei anzuschauen."
//
// NO SERVER CALL. The whole file is already here: an import carries
// `ImportSource.lines` byte for byte and `origin[i]` says which line produced
// event `i`. That is the same array the trace's `source` face reads, held once
// per import however many frames point into it.
//
// THE PROBLEM THIS MODULE EXISTS FOR is that the line in question is not a line
// anybody can read. A record carrying a screenshot is one JSON object on ONE
// line, and the base64 inside it runs to hundreds of thousands of characters —
// measured on the operator's store, the longest is 614,521. Printing it is what
// made the trace row unusable before card 179's adversarial pass. So the target
// line is cut into SEGMENTS: readable JSON, and each blob as a measured absence
// where it sits. The reader sees the shape of the record and where in it the
// pictures are, which is the question — and a record often carries SEVERAL, so
// every one of them is marked rather than only the first.

/** One line of the file, as the pane shows it. */
export interface WindowLine {
  /** The number a reader counts to when opening the file — one-based. */
  number: number;
  /** The line's text, or the parts around the blob when this is the one. */
  text: string;
  /** True for the line the picture came from. */
  target: boolean;
}

/** One piece of the target line: readable JSON, or a blob standing in for a
 *  picture. */
export type Segment = { kind: "text"; text: string } | { kind: "blob"; chars: number };

/** The target line, cut around EVERY blob it carries. */
export interface TargetLine {
  number: number;
  segments: Segment[];
  /** How many pictures this one record brought in. */
  blobs: number;
}

/** What the file face renders. */
export interface SourceWindow {
  /** Lines before the target, in file order. */
  above: WindowLine[];
  /** The target, cut. Null when the line could not be found. */
  target: TargetLine | null;
  /** Lines after it. */
  below: WindowLine[];
  /** The file's total line count, so the pane can say where in the file this is. */
  total: number;
}

/**
 * How much of a neighbouring line is worth showing.
 *
 * A neighbour can be a 40 KB record too — the line before a screenshot is often
 * another one. The window is for orientation, not for reading someone else's
 * whole record, and the trace's source face is where a full line belongs.
 */
const NEIGHBOUR_CHARS = 240;

/** How much JSON to keep on either side of the blob. Enough to see the fields
 *  that name it — `"type":"image","source":{"type":"base64","media_type":…` —
 *  and not so much that the shape is lost. */
const AROUND_BLOB = 320;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

/**
 * Cuts a line around EVERY blob it carries.
 *
 * All of them, not just the first — found by looking at the running app: the
 * owner's opening record holds FOUR screenshots, and a version that marked one
 * printed the next one's raw base64 in the tail after it. That is the same
 * noise this whole module exists to remove, moved a few hundred characters to
 * the right.
 *
 * Matched on the RUN OF BASE64 rather than on a JSON path, because the line is
 * a string here and parsing a 600 KB record to find a field it already contains
 * is work for nothing. A run of 200+ base64 characters is not something a
 * transcript's other fields contain.
 *
 * The JSON BETWEEN two blobs is kept whole when it is short — it is the seam
 * that shows they are siblings in one array — and clipped from both ends when
 * it is long, because its middle says nothing.
 *
 * @param line the file's line
 * @param number its one-based number
 * @return the cut, or null when the line holds no blob
 */
export function cutAroundBlob(line: string, number: number): TargetLine | null {
  const re = /[A-Za-z0-9+/]{200,}={0,2}/g;
  const segments: Segment[] = [];
  let blobs = 0;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const gap = line.slice(at, m.index);
    if (gap !== "") {
      // The first gap is the head of the record and is shown from its END: the
      // fields that name a blob sit immediately in front of it. Every later gap
      // is short enough to keep whole, or is clipped from both sides.
      segments.push({
        kind: "text",
        text:
          segments.length === 0
            ? gap.length <= AROUND_BLOB
              ? gap
              : `…${gap.slice(-AROUND_BLOB)}`
            : gap.length <= AROUND_BLOB * 2
              ? gap
              : `${gap.slice(0, AROUND_BLOB)}…${gap.slice(-AROUND_BLOB)}`,
      });
    }
    segments.push({ kind: "blob", chars: m[0].length });
    blobs++;
    at = m.index + m[0].length;
  }
  if (blobs === 0) return null;
  const tail = line.slice(at);
  if (tail !== "") segments.push({ kind: "text", text: clip(tail, AROUND_BLOB) });
  return { number, segments, blobs };
}

/**
 * The file around one line.
 *
 * @param lines the import's own lines, byte for byte
 * @param at the target's index, zero-based, as `origin` reports it
 * @param context how many lines to show on each side
 * @return the window; `target` is null when `at` is out of range or its line
 *         holds no blob, and the neighbours are still returned so the pane can
 *         show where it looked
 */
export function sourceWindow(lines: readonly string[], at: number, context = 3): SourceWindow {
  const total = lines.length;
  if (at < 0 || at >= total) return { above: [], target: null, below: [], total };

  const take = (from: number, to: number): WindowLine[] => {
    const out: WindowLine[] = [];
    for (let i = Math.max(0, from); i < Math.min(total, to); i++) {
      out.push({ number: i + 1, text: clip(lines[i], NEIGHBOUR_CHARS), target: false });
    }
    return out;
  };

  return {
    above: take(at - context, at),
    target: cutAroundBlob(lines[at], at + 1),
    below: take(at + 1, at + 1 + context),
    total,
  };
}
