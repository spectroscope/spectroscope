// The one line a FOLDED tool call gets, in the chat header and in the export's
// summary row. Both rows are `white-space: nowrap` with an ellipsis, so this is
// a budget problem, not a rendering one: a reader scans a collapsed list to find
// one call among forty, and what identifies a call is its path, its command, its
// pattern — never the first forty characters of its body.
//
// So the body is named, not quoted: `content: 128 lines`. JSON.stringify's
// escaped head spends the whole row proving a newline exists and pushes the
// identifying field off the end of it. The full payload is one click away in the
// card, and printed in full underneath in the export.
//
// Pure and DOM-free, like toolViews next door — the two rows that need it cannot
// import each other (one is a React component, the other must stay React-free),
// and a component is not unit-testable in this suite.

import { splitInput } from "./toolViews";
import { compactJson } from "../format";

/** Per-field cap. Wide enough for a repo-relative path, which is the value a
 *  reader most often needs whole. */
const VALUE_CHARS = 60;

/** Whole-row cap. The CSS clips to the row's width, so this only bounds what
 *  sits in the DOM unread — a payload may carry hundreds of fields. */
const TEASER_CHARS = 140;

/** The cap counts the marker: a limit that the marker is allowed to exceed is
 *  not a limit, and these two are nested. */
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Lines of a lifted field, counted the way splitInput counts them for its own
 *  reference marker — a header that disagreed with the block below it would read
 *  as two different files. */
const lineCount = (text: string): number => text.replace(/\n$/, "").split("\n").length;

/** One line, whatever came in: a break in a nowrap row is either swallowed or
 *  pushes the rest of the header out of reach. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A field's value as row text. A string prints as itself — unquoted, because
 *  the quotes are two characters of a sixty-character budget and the reader is
 *  looking for the path inside them. */
function valueText(value: unknown): string {
  return clip(oneLine(typeof value === "string" ? value : compactJson(value)), VALUE_CHARS);
}

/** One field of the row. `counted` marks a value that stands IN for the field's
 *  content rather than being it — the distinction the key hangs on. */
interface Cell {
  key: string;
  value: string;
  counted: boolean;
}

/**
 * A tool call summarised for a row that has one line and no room.
 *
 * @param name  the tool's wire name (splitInput reads some keys per tool)
 * @param input the call's input, of any shape
 * @param lines wording for a counted body; the caller owns it, because the card
 *              translates and the export carries labels of its own
 * @return one line, never empty of meaning: "" when there is nothing to say
 */
export function toolTeaser(name: string, input: unknown, lines: (n: number) => string): string {
  const { shape, blocks } = splitInput(name, input);
  // A payload that is not an object has no fields to name and no key to name
  // them with — splitInput hands it back untouched, so it prints as itself.
  if (typeof shape !== "object" || shape === null || Array.isArray(shape)) return valueText(shape);

  const lifted = new Set(blocks.map((block) => block.key));
  const cells: Cell[] = Object.entries(shape as Record<string, unknown>)
    .filter(([key]) => !lifted.has(key))
    .map(([key, value]) => ({ key, value: valueText(value), counted: false }));
  // Bodies last: they are the least scannable field and the first that should be
  // lost to the clip, whatever order the model listed them in. A field lifted
  // only because it ends in a break is still one line, and one line of text says
  // more than the count of it.
  for (const block of blocks) {
    const n = lineCount(block.text);
    cells.push(
      n === 1
        ? { key: block.key, value: valueText(block.text), counted: false }
        : { key: block.key, value: lines(n), counted: true },
    );
  }

  if (cells.length === 0) return "";
  // One field whose value IS the answer, so the key goes: the row already carries
  // the tool's name, and a lone `path:` restates it at the value's expense. A
  // count is not the answer but a description of it, and a description needs its
  // subject — `14 lines` alone does not say what has fourteen of them. With two
  // or more fields every key stays: under an MCP schema nobody here reads, the
  // key is the only thing that says what the value means.
  if (cells.length === 1 && !cells[0].counted) return clip(cells[0].value, TEASER_CHARS);
  return clip(
    cells.map(({ key, value }) => (value === "" ? `${key}:` : `${key}: ${value}`)).join(" · "),
    TEASER_CHARS,
  );
}
