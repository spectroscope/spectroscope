// A transcript line, opened out so a person can read it.
//
// WHY THIS IS A SECOND RENDERING AND NOT THE ONLY ONE. A pane that calls
// itself the source and shows something other than the bytes is the defect
// this card exists to remove. So the source pane's default stays byte
// faithful, and this is the OTHER, named reading: it says openly that it
// interpreted the line, and it is never the default and never persisted.
//
// THE ONE RULE THAT KEEPS IT HONEST: never string replace an escape. The only
// unescape here is another JSON.parse. 1265 Bash commands in the owner's
// corpus carry a literal backslash and n as CONTENT (`tr '\n' ' '`,
// `.replace('&#10;','\n')`), and a blind replace would rewrite somebody's
// command. After the first parse a two character backslash n is content by
// definition, and this module never looks at it again.
//
// THE SECOND GUARD: a re-parse is accepted only when it yields an object or an
// array. Without that, "12" becomes 12 and "true" becomes a boolean, which is
// corruption dressed up as prettification.

/** How many documents deep the walk will parse. The line itself is depth 0, so
 *  a document can be opened at depth 1, 2 and 3; a JSON looking string found at
 *  depth 3 keeps its escapes and stands where it is. Measured: the deepest real
 *  record in 57402 corpus lines is two documents deep, so this is headroom, not
 *  a limit anybody meets. */
export const MAX_EMBED_DEPTH = 3;

/** How much of an opened string stays behind where it stood. Long enough to
 *  recognise the value, short enough that a 3472 character hook stdout is not
 *  printed twice. */
export const HEAD_CHARS = 48;

/** When a single run of characters with no line break in it stops being
 *  something a person reads and starts being a wall.
 *
 *  Measured over 6431 real lines: the longest single run anybody WROTE is a
 *  1237 character shell command, and the next ones down are a 1072 character
 *  thinking block and a 965 character error. Every string above this is a blob.
 *  A string carrying real line breaks is never judged by size, however long it
 *  gets: that is thinking, stdout and markdown, which is what the reader came
 *  for. */
export const HEAVY_CHARS = 2048;

/**
 * Whether a field holds bytes rather than language.
 *
 * Both formats have exactly two: the cryptographic `signature` on a thinking
 * block, and the base64 body of an image or a file (`source.data`,
 * `file.base64`). They are collapsed at ANY length, because 356 characters of
 * base64 read no better than 428956, and a size rule alone would leave half of
 * them standing: measured over 706 signatures in one transcript, the median is
 * 1564 and the shortest 356.
 *
 * @param path where the value sits, dotted, array indices in brackets
 */
export function opaqueField(path: string): boolean {
  const key = path.slice(path.lastIndexOf(".") + 1);
  if (key === "signature" || key === "base64") return true;
  return key === "data" && /(^|\.)source$/.test(path.slice(0, path.lastIndexOf(".")));
}

/** One piece of the opened line.
 *
 *  `json` is a document, pretty printed two spaces deep, with every string this
 *  module opened shortened to its head where it stood.
 *  `text` is one string value, its real line breaks intact.
 *  `hidden` is a value the pane collapses: carried whole, printed on request,
 *  and never dropped. */
export interface ReadableBlock {
  kind: "json" | "text" | "hidden";
  /** Where the piece sits in the record, dotted, array indices in brackets.
   *  Empty for the line itself. An embedded document keeps the path of the
   *  string it was parsed out of, so the path never carries a marker of ours. */
  path: string;
  /** How many parses beyond the line: 0 is the line, 1 a document that was a
   *  string in it, and so on. A text block carries the depth of the document it
   *  was found in, because reading a string is not a parse. */
  depth: number;
  text: string;
}

export interface Readable {
  /** False when the line is not JSON at all. The blocks then carry it verbatim
   *  and the pane says it did not parse, rather than showing nothing. */
  parsed: boolean;
  blocks: ReadableBlock[];
}

/** What the walk found inside one document and has to open below it. */
interface Opened {
  path: string;
  /** The parsed document, or null when the string stands as its own block. */
  doc: unknown;
  text: string;
  depth: number;
  /** True when the block is collapsed rather than printed: bytes, not language. */
  hidden?: boolean;
}

const isDocument = (v: unknown): boolean => v !== null && typeof v === "object";

/** Whether a string is worth parsing again: the design's rule, in order. The
 *  trim is a read, never a write; the string itself travels untouched. */
function embedded(s: string): unknown {
  const head = s.trimStart();
  if (head === "" || (head[0] !== "{" && head[0] !== "[")) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return isDocument(v) ? v : undefined; // the numeric string guard
  } catch {
    return undefined; // it looked like a document and was not one
  }
}

/** The head that stays behind where an opened string stood. Never cut between
 *  the two halves of one character: a lone surrogate would print as a broken
 *  glyph in a pane whose whole claim is fidelity. */
function shorten(s: string): string {
  if (s.length <= HEAD_CHARS) return s;
  let cut = HEAD_CHARS;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${s.slice(0, cut)}…`;
}

/**
 * One document, cloned for printing, with everything it has to open collected.
 *
 * @param value the document, or any value inside it
 * @param path  where this value sits, dotted
 * @param depth how many parses deep the DOCUMENT is
 * @param out   collects the strings that get their own block, in document order
 * @return the value as it should be printed in this document's skeleton
 */
function skeleton(value: unknown, path: string, depth: number, out: Opened[]): unknown {
  if (typeof value === "string") {
    if (depth < MAX_EMBED_DEPTH) {
      const doc = embedded(value);
      if (doc !== undefined) {
        out.push({ path, doc, text: value, depth: depth + 1 });
        return shorten(value);
      }
    }
    // Not a document, but unreadable where it stands: a string with real line
    // breaks prints as one escaped run and is exactly what the owner could not
    // read on screen.
    if (value.includes("\n")) {
      out.push({ path, doc: null, text: value, depth });
      return shorten(value);
    }
    // Bytes rather than language: named as such, or one run long past anything
    // a person wrote. Collapsed where it stood, carried whole underneath.
    if (opaqueField(path) || value.length > HEAVY_CHARS) {
      out.push({ path, doc: null, text: value, depth, hidden: true });
      return shorten(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => skeleton(v, `${path}[${i}]`, depth, out));
  if (isDocument(value)) {
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      clone[k] = skeleton(v, path === "" ? k : `${path}.${k}`, depth, out);
    }
    return clone;
  }
  return value;
}

function emit(value: unknown, path: string, depth: number, blocks: ReadableBlock[]): void {
  const out: Opened[] = [];
  blocks.push({
    kind: "json",
    path,
    depth,
    text: JSON.stringify(skeleton(value, path, depth, out), null, 2),
  });
  for (const o of out) {
    if (o.doc === null) {
      blocks.push({ kind: o.hidden ? "hidden" : "text", path: o.path, depth: o.depth, text: o.text });
    } else emit(o.doc, o.path, o.depth, blocks);
  }
}

/**
 * The line, opened out.
 *
 * @param line one raw line of a transcript, exactly as it was read
 * @return the blocks in reading order, skeleton first, each opened piece under
 *         the document it came from; `parsed: false` for a line that is not JSON
 */
export function readable(line: string): Readable {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { parsed: false, blocks: [{ kind: "text", path: "", depth: 0, text: line }] };
  }
  if (!isDocument(value)) {
    // A line that is a bare string or number is already as readable as it gets.
    return { parsed: false, blocks: [{ kind: "text", path: "", depth: 0, text: line }] };
  }
  const blocks: ReadableBlock[] = [];
  emit(value, "", 0, blocks);
  return { parsed: true, blocks };
}

/**
 * The readable rendering as one piece of text, for the clipboard.
 *
 * Each opened block is announced by its own path and nothing else: a word of
 * ours in the clipboard would be a word the reader did not copy, and it would
 * only be right in one of the two languages.
 */
export function readableText(line: string): string {
  const { parsed, blocks } = readable(line);
  if (!parsed) return line;
  return blocks.map((b) => (b.path === "" ? b.text : `${b.path}\n${b.text}`)).join("\n\n");
}
