// Which face a file body OPENS in, and whether the rendered one can be trusted
// with this particular body.
//
// THE ARGUMENT FOR TEXT, WHICH IS STILL TRUE AND IS NOT THE DEFAULT ANY MORE.
// A tool result is EVIDENCE. Colouring lays a class over every byte and moves
// none of them, which is why every other well in the card is coloured;
// rendering markdown CONSUMES bytes — the hashes of a heading, the pipes of a
// table, the two trailing spaces that became a line break are gone from the
// screen. A reader who came to check whether an Edit's anchor is really in this
// file cannot check it against prose. That cost is real and it did not change.
// What changed is who pays it: the owner ruled (2026-07-28) that for a file that
// IS markdown, the reading face is the one worth opening, and the bytes stay one
// click away in the same head. The constraint above is why that click has to
// keep existing, and why nothing but a markdown file may open rendered.
//
// The design spec's own rule still governs which bodies qualify
// (docs/superpowers/specs/2026-07-27-structured-tool-views-design.md, "Markdown
// policy"): markdown is applied only where the payload IS markdown, by evidence
// rather than by guess. Two things follow, and both are below: the extension
// decides, and a body this parser demonstrably would not reproduce goes back to
// the bytes with a line saying why.

import { parseMarkdown, type Block, type Inline } from "../markdown/parse";

/** Extensions whose body may be offered as rendered prose. `mdx` is absent
 *  deliberately: it is JSX inside markdown, and this parser reads a component
 *  tag as text and its braces as prose — a render that is wrong about the file. */
const MD_EXT = new Set(["md", "markdown"]);

/**
 * Whether a path names a markdown file.
 *
 * The extension decides, and the body is never sniffed: a `#` on the first line
 * of a log is a character someone typed, and promoting it to a heading would be
 * the chrome inventing structure the file does not have.
 *
 * This is a second path rule in a tree that already has `hlLangForPath`, and it
 * exists only because that one deliberately does not know markdown (the reasons
 * are in `workspace/langs/markdown.test.ts`: the tokenizer's five classes all
 * read a markdown file wrong). The two are pinned against each other in the test
 * so they can never both claim a path.
 *
 * @param path the path the tool named, as it named it
 * @return true when the body is markdown by the file's own name
 */
export function markdownBody(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? false : MD_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** What the rendered face would do to this body that the bytes would not. */
export type BodyNote = "tv.mdIndent" | "tv.mdWord";

export interface BodyFace {
  /** The face the body opens in. A hand-made pick still wins over it. */
  rendered: boolean;
  /** Stated above the body when a probe fired, in both faces: it is a fact about
   *  the body, so it warns a reader who renders it anyway. */
  note: BodyNote | null;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Every inline run a body carries, paragraphs and headings and cells alike. */
function runs(blocks: Block[], out: Inline[][]): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "para":
      case "heading":
        out.push(block.children);
        break;
      case "list":
        for (const item of block.items) {
          out.push(item.children);
          if (item.sub !== null) runs([item.sub], out);
        }
        break;
      case "quote":
        runs(block.children, out);
        break;
      case "table":
        for (const cell of block.header) out.push(cell);
        for (const row of block.rows) for (const cell of row) out.push(cell);
        break;
      case "code":
      case "hr":
        break;
    }
  }
}

/**
 * Whether a paragraph line begins with layout the render will not keep.
 *
 * Markdown's own four-space code block has no branch in this parser, so those
 * lines land in a paragraph carrying their leading spaces, and `.md p` sets no
 * `white-space`, so the browser collapses them. Any leading whitespace counts,
 * not just four: a two-space continuation in a pasted function is the same loss.
 * A fenced block is a `code` block and never reaches here, which is why a
 * document that fences its code renders untouched.
 */
function indents(blocks: Block[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "para" &&
      block.children.some(
        (child, i) =>
          child.kind === "text" &&
          (i === 0 || block.children[i - 1].kind === "br") &&
          /^[ \t]/.test(child.text),
      ),
  );
}

/**
 * Whether an emphasis span was paired into the middle of a word.
 *
 * Two measured causes, both of them ordinary in this repo's own docs:
 *
 *   `SPECTRO_HUB_PORT` parses as text + em + text, so both underscores are gone
 *   from the screen and the reader is looking at a name that does not exist.
 *   CommonMark forbids intraword emphasis for exactly this reason; this parser
 *   predates the question and answers it the other way.
 *
 *   A `**bold**` that spans a hard wrap desynchronises every pair after it,
 *   because a paragraph's inlines are parsed one LINE at a time (joinWithBreaks)
 *   and an opener with no partner on its own line stays literal. Measured on
 *   docs/RELEASE-PLAYBOOK.md, whose first paragraph renders as `**Maven` and
 *   `desktop run kit**` in plain text with the bold laid over the two spans in
 *   between — the ones the file does not mark.
 *
 * Neither is a defect a file body may absorb quietly, and neither is this
 * module's to fix: the parser is the chat's too.
 *
 * Read off the neighbours rather than the source, so inline code and fenced
 * blocks need no special case: neither produces an emphasis node at all.
 */
function eatsWord(run: Inline[]): boolean {
  return run.some((node, i) => {
    if (node.kind !== "strong" && node.kind !== "em" && node.kind !== "del") {
      return node.kind === "link" && eatsWord(node.children);
    }
    const before = run[i - 1];
    const after = run[i + 1];
    return (
      before !== undefined &&
      before.kind === "text" &&
      after !== undefined &&
      after.kind === "text" &&
      isWordChar(before.text[before.text.length - 1]) &&
      isWordChar(after.text[0])
    );
  });
}

/**
 * The face a file body opens in, and what to say about it.
 *
 * `text` must be the string that will actually be rendered, clip and all: a clip
 * lands anywhere, and the body a reader sees is the one the probes have to be
 * about.
 *
 * @param path the path the tool named
 * @param text the body as it will be shown
 */
export function bodyFace(path: string, text: string): BodyFace {
  if (!markdownBody(path) || text.trim() === "") return { rendered: false, note: null };
  const blocks = parseMarkdown(text);
  // Indentation first when both fire: it is whole lines rather than two
  // characters, so it is the one a reader would notice missing.
  if (indents(blocks)) return { rendered: false, note: "tv.mdIndent" };
  const inlines: Inline[][] = [];
  runs(blocks, inlines);
  if (inlines.some(eatsWord)) return { rendered: false, note: "tv.mdWord" };
  return { rendered: true, note: null };
}
