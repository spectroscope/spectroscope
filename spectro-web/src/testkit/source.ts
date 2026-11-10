// Source-as-evidence helpers for the drift suite (finding 19, review
// 2026-08-14). There is no DOM in this suite (house rule), so drift tests read
// the source off disk and pin what a screenshot review misses. Before this
// module, ten test files carried a byte-identical read() and eight carried the
// same comment-blanker — and a hand-copy of a blanker is exactly the place
// where one drifted regex silently weakens a guard: prose above a rule quotes
// the very shapes the guards forbid, so a blanker that misses a comment lets a
// COMMENT satisfy an assertion about CODE.
//
// Test-only by construction: nothing under src/ imports this module except
// *.test.* files, so it never reaches the shipped bundle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A source file in this tree, as text.
 *
 * @param rel path relative to the calling test file
 * @param from the caller's own `import.meta.url` — handed over explicitly,
 *   because URL resolution must anchor at the TEST's location, not this kit's
 */
export function read(rel: string, from: string): string {
  return readFileSync(fileURLToPath(new URL(rel, from)), "utf8");
}

/**
 * Blank out block comments, keeping newlines so line numbers and offsets still
 * line up. Deliberately LAZY (`*?`): a greedy match would blank the code
 * between two comments, and every guard built on the result would go soft
 * without a single test turning red.
 */
export function blankBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** The characters after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
/** The words after which a `/` starts a regular expression. */
const REGEX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/**
 * Block comments blanked and line comments dropped, in source code: prose
 * about a deleted class is not the class. Newlines stay, so line counts still
 * hold. A `/*` or `//` inside a string, a template or a regular expression is
 * code (card 605, task 12 fix round 1 item 11): the import dialog's hint path
 * "~/.claude/projects/…/*.jsonl" opened a comment that hid the rest of the file.
 * A quote in JSX text reads as a string to the end of its line.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  /** The last character of code that is not blank, and the word it ends. */
  let prev = "";
  let word = "";
  /** Brace depth of each `${` the scan is inside, innermost last. */
  const templates: number[] = [];
  let depth = 0;
  /** Copies a quoted run from `i` (its opening quote, or the `}` that resumes a template) to its end. */
  const copyQuoted = (quote: string): void => {
    const from = i++;
    while (i < src.length && src[i] !== quote && !(quote !== "`" && src[i] === "\n")) {
      if (src[i] === "\\") i++;
      else if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
        out += src.slice(from, i + 2);
        i += 2;
        templates.push(depth);
        depth = 0;
        return;
      }
      i++;
    }
    out += src.slice(from, Math.min(i + 1, src.length));
    i++;
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      // A template resumes after its `${...}`: the closing brace hands back here.
      copyQuoted(c);
      prev = c;
      word = "";
      continue;
    }
    if (c === "}" && templates.length > 0 && depth === 0) {
      // The `}` of a `${`: back in the template's text, up to its end or its next `${`.
      depth = templates.pop() ?? 0;
      copyQuoted("`");
      prev = "`";
      word = "";
      continue;
    }
    if (c === "/" && (prev === "" || BEFORE_REGEX.has(prev) || REGEX_WORDS.has(word))) {
      const from = i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      while (i + 1 < src.length && /[a-z]/i.test(src[i + 1])) i++;
      out += src.slice(from, i + 1);
      i++;
      prev = "/";
      word = "";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (!/\s/.test(c)) {
      prev = c;
      word = /[A-Za-z_$]/.test(c) ? word + c : /[0-9]/.test(c) && word !== "" ? word + c : "";
    }
    out += c;
    i++;
  }
  return out;
}

// ---- CSS rules, located by SUBJECT rather than by substring ------------------

/** One `selector { body }` pair, with the element the rule is ABOUT. */
export interface CssRule {
  /** The file it came from, as the caller named it. */
  rel: string;
  /** The full selector, scope and all — `.foo .bar`, never just `.bar`. */
  selector: string;
  /** The last combinator-separated compound: what the rule styles. */
  subject: string;
  /** The declarations between the braces. */
  body: string;
  /** 1-based line of the selector in the sheet. */
  line: number;
}

/**
 * The element a selector is ABOUT — its last combinator-separated compound.
 *
 * <p>`.foo .bar` is a rule about `.bar` UNDER `.foo`; `.bar` is a rule about
 * `.bar` anywhere. Telling those apart is the whole reason this module exists:
 * every substring locator in this tree returned the first for a query about the
 * second, and on 2026-08-30 that mutation left a suite 24/24 green.</p>
 *
 * <p>Splits on all four combinators, not on whitespace alone — `.foo>.bar` has
 * no space in it and is scoped just as hard as `.foo .bar`.</p>
 *
 * @param selector one selector, already split out of any comma list
 * @returns the subject compound, trimmed
 */
export function subjectOf(selector: string): string {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Every rule in a sheet, one entry per selector in a comma list.
 *
 * <p>At-rules are no trap for this shape: in `@media x { .a { … } }` the inner
 * `.a { … }` is what matches the pair pattern, and the prelude never pairs with
 * a body of its own. Comments are blanked rather than deleted so the line
 * numbers stay true.</p>
 *
 * @param rel how to label the sheet in results
 * @param css the stylesheet source
 * @returns one CssRule per selector, in source order
 */
export function rules(rel: string, css: string): CssRule[] {
  const clean = blankBlockComments(css);
  const out: CssRule[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // The line of the SELECTOR, not of the whitespace run before it: the
    // pattern's [^{}]+ starts at the previous rule's closing brace, so
    // m.index alone points at a blank line above.
    const lead = m[1].length - m[1].trimStart().length;
    const line = clean.slice(0, (m.index ?? 0) + lead).split("\n").length;
    for (const one of m[1].split(",")) {
      const selector = one.trim();
      if (!selector || selector.startsWith("@")) continue;
      out.push({ rel, selector, subject: subjectOf(selector), body: m[2], line });
    }
  }
  return out;
}

/**
 * The declarations of the ONE rule whose selector is EXACTLY the one asked for.
 *
 * <p>The drop-in replacement for the five hand-rolled locators this tree
 * carried. It differs from all of them in the case that matters: asked for
 * `.right-panel`, a substring search returns `.foo .right-panel` if that stands
 * first, quietly attributing a scoped rule to the unscoped element. This
 * throws instead of guessing — when the selector exists only under an
 * ancestor, when it is absent, and when it is declared twice.</p>
 *
 * <p>EXACT MATCH, not "unscoped": pass `.bar` to get the unscoped rule, and
 * pass `.foo .bar` to get that scoped one deliberately (which
 * `cardGeometry.test.ts` does, and legitimately). The parameter was first
 * called `subject` and that name was a small lie — it compares the whole
 * selector, and a name that promised otherwise is exactly the shape this
 * module exists to stop.</p>
 *
 * @param css      the stylesheet source
 * @param selector the exact selector to look up, e.g. `.right-panel`
 * @return the declarations between that rule's braces
 * @throws Error when the sheet does not carry exactly one rule with it
 */
export function blockOf(css: string, selector: string): string {
  const all = rules("", css);
  const unscoped = all.filter((r) => r.selector === selector);
  if (unscoped.length === 1) return unscoped[0].body;
  if (unscoped.length > 1) {
    throw new Error(
      `${selector} is declared ${unscoped.length} times (lines ` +
        `${unscoped.map((r) => r.line).join(", ")}) — say which one you mean`,
    );
  }
  const scoped = all.filter((r) => r.subject === subjectOf(selector));
  if (scoped.length) {
    throw new Error(
      `${selector} has no unscoped rule; it appears only under an ancestor: ` +
        scoped.map((r) => r.selector).join(", "),
    );
  }
  throw new Error(`no rule in this sheet has ${selector} as its subject`);
}
