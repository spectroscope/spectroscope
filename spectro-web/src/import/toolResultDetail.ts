// What the tool actually returned, before the client flattened it (card 167).
//
// A Claude Code user record that carries a tool_result block can carry a
// `toolUseResult` beside it: the tool's own return value, structured, while the
// BLOCK holds the flattened text the model was shown. The two are not the same
// thing, and every difference between them costs a reader something:
//
//   Read      the block welds a line-number gutter onto the body ("1\t# Heading"),
//             so the highlighter colours the gutter as program text on 1,903
//             code reads and the markdown face renders over a destroyed
//             heading. `file.content` is the same body without it. Measured
//             over the 5,119 transcripts in ~/.claude/projects: 3,154 reads,
//             a gutter on all 3,154 blocks.
//   Read      the page is `{startLine, numLines, totalLines}` — 1,565 partial
//             reads. The card today counts the lines of the flattened text and
//             states the page's length as the file's.
//   Bash      `stdout` and `stderr` are separate; the block runs them together
//             with no marker, on 999 commands that wrote to stderr.
//   Edit      `structuredPatch` says WHERE the change landed (8,112 edits,
//             9,264 hunks); the block says only "has been updated successfully".
//   TaskUpdate `statusChange {from, to}` is the from-state toolViews.ts had to
//             refuse to draw, on 1,314 updates.
//
// THIS IS A READING, NOT A FRAME, and it is the same idiom as sourceNotes.ts
// and recordMeta.ts: nothing in events.ts gains a field, and the frame that
// carries this to the card is import-only (wire/nonWire.ts) so it can never be
// written into a session file.
//
// ABSENT-FIRST, because the field is newer than most of the corpus: it is on
// 44,208 records of 496,675, and every reader below returns nothing rather than
// a default. `toolUseResult` also has two shapes that carry nothing new — a
// string (3,105, always an error the block already states) and an array (4,994,
// MCP output the block duplicates byte for byte) — and both are refused here
// rather than half-read.
//
// VALUES TRAVEL VERBATIM. Nothing is reformatted, re-indented or recounted.

/** Where one change landed. The hunk's LINES are deliberately not carried: they
 *  are the before and after the edit view already draws from the call's own
 *  old_string/new_string, and a second copy would be the same text twice. What
 *  the block never says is where, and that is these four numbers. */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** What one tool's own return value says beyond its flattened block. Every
 *  field is optional and absent means the record did not carry it. */
export interface ToolResultDetail {
  /** Read: the file body, without the line-number gutter. */
  fileContent?: string;
  /** Read: the page that came back. */
  startLine?: number;
  numLines?: number;
  totalLines?: number;
  /** Read: the read stopped at the token cap. Only ever true; a false is not
   *  carried, because "not truncated" is what a card with no note says. */
  truncated?: true;
  /** Bash: the two streams, kept apart. An empty stdout IS carried — 584 calls
   *  printed nothing and the block substitutes a sentence for it — while an
   *  empty stderr is not, because nothing was written there. */
  stdout?: string;
  stderr?: string;
  /** TaskUpdate: the state the task moved out of, and the one the result
   *  confirmed. Both or neither: an arrow needs both ends. */
  statusFrom?: string;
  statusTo?: string;
  /** Edit / Write over an existing file: where the change landed. */
  patch?: PatchHunk[];
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * One hunk, or null for anything that is not four numbers.
 *
 * Strict on purpose: a half-read patch would name the wrong lines as the place
 * the edit landed, which is worse than saying nothing about where it landed.
 */
function hunk(value: unknown): PatchHunk | null {
  const h = obj(value);
  if (h === null) return null;
  const oldStart = num(h["oldStart"]);
  const oldLines = num(h["oldLines"]);
  const newStart = num(h["newStart"]);
  const newLines = num(h["newLines"]);
  if (oldStart === undefined || oldLines === undefined) return null;
  if (newStart === undefined || newLines === undefined) return null;
  return { oldStart, oldLines, newStart, newLines };
}

/**
 * A record's `toolUseResult`, as far as a tool card can use it.
 *
 * @param value the record's own `toolUseResult`, whatever it is
 * @return the detail, or null when the record carries none, carries one of the
 *         two shapes that duplicate the block, or carries nothing a card reads
 */
export function readToolResultDetail(value: unknown): ToolResultDetail | null {
  const tur = obj(value);
  if (tur === null) return null;
  const d: ToolResultDetail = {};

  const file = obj(tur["file"]);
  if (file !== null) {
    const content = str(file["content"]);
    // The image reads carry `base64` here and no `content`; their bytes are
    // already in the block and asText names them. Nothing to add.
    if (content !== undefined && content !== "") d.fileContent = content;
    const startLine = num(file["startLine"]);
    const numLines = num(file["numLines"]);
    const totalLines = num(file["totalLines"]);
    if (startLine !== undefined) d.startLine = startLine;
    if (numLines !== undefined) d.numLines = numLines;
    if (totalLines !== undefined) d.totalLines = totalLines;
    if (file["truncatedByTokenCap"] === true) d.truncated = true;
  }

  const stdout = str(tur["stdout"]);
  const stderr = str(tur["stderr"]);
  if (stdout !== undefined) d.stdout = stdout;
  if (stderr !== undefined && stderr !== "") d.stderr = stderr;

  const change = obj(tur["statusChange"]);
  if (change !== null) {
    const from = str(change["from"]);
    const to = str(change["to"]);
    if (from !== undefined && from !== "" && to !== undefined && to !== "") {
      d.statusFrom = from;
      d.statusTo = to;
    }
  }

  const patch = tur["structuredPatch"];
  if (Array.isArray(patch) && patch.length > 0) {
    const hunks = patch.map(hunk);
    // One unreadable hunk would misstate the shape of the change, so the whole
    // patch is dropped rather than reported short.
    if (!hunks.some((h) => h === null)) d.patch = hunks as PatchHunk[];
  }

  return Object.keys(d).length === 0 ? null : d;
}
