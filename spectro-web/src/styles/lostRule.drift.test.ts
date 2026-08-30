// A COMMENT THAT CLOSES TWICE EATS THE RULE UNDER IT, silently.
//
// CSS has no idea a `*/` was meant to be a comment. Outside a comment it is
// junk at the top level, and the parser's recovery for junk is to swallow
// everything up to and including the NEXT declaration block — so the first
// rule after the stray terminator is gone. Nothing says so: it is not a tsc
// error, not an eslint error, not a prettier complaint, and the browser paints
// the page without a word. `vite build` does print an esbuild warning, which is
// exactly the kind of line a green gate scrolls past.
//
// It happened here. `panels.css` grew a long comment about the spectral ramp,
// the new text ended with a `*/`, and the paragraph that used to close the old
// comment was left standing after it with a `*/` of its own. The rule that
// followed was `.hl-keyword`, so every keyword in a file preview and in a
// fenced code block rendered with no colour at all — while `.hl-string`,
// `.hl-number` and `.hl-comment`, one line further down, were fine.
//
// MEASURED, because "recovery swallows one rule" is a claim about a parser and
// not something to reason out. Through the browser's own CSSOM, which is the
// same parser that paints:
//
//   const el = document.createElement("style");
//   el.textContent = "/* a */\n   tail. */\n.hl-keyword{color:red}\n.hl-string{color:green}";
//   document.head.appendChild(el);
//   [...el.sheet.cssRules].map((r) => r.cssText);
//   // -> [".hl-string { color: green; }"]     .hl-keyword is not there
//
// So this asks two questions of every stylesheet in the tree: is every `*/` the
// end of a comment that was open, and is every `/*` closed? It says nothing
// about anything else a stylesheet can get wrong.
//
// THE TWO ARE NOT EQUALLY DANGEROUS and the first cut of this file claimed
// otherwise ("a lost rule has one cause here and this is it"). Measured with
// `npx esbuild --minify` on a two-line file of each shape:
//
//   stray `*/`     WARNING, exit 0 — the build goes on, the rule after it is
//                  glued to the junk (`tail. */ .hl-keyword{color:red}`) and so
//                  matches nothing. This is the one that ships.
//   unclosed `/*`  ERROR, exit 1, "Expected \"*/\" to terminate multi-line
//                  comment" — the build stops, and everything after the opener
//                  is lost rather than one rule.
//
// The second is checked here anyway, because a check that says "every lost rule
// has this one cause" while walking past the other cause is the kind of sentence
// this whole file was written about.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** @return every file under `dir`, recursively */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const sheets = walk(SRC)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ rel: f.slice(SRC.length), text: readFileSync(f, "utf8") }));

// Every comment fault in a stylesheet, each as `line:column what` — the
// position of the offending `*` or `/` itself, one-based, so it is the column
// an editor puts the caret in. The first cut counted the column BEFORE looking
// at the character and reported one past it, and its own pin baked the drift in
// (`2:11` for a `*` standing in column 10), which is a number nobody could ever
// catch by reading the test.
//
// Line comments and not a doc block, for the reason this file exists: a doc
// block that quotes a terminator ENDS THERE, and the first draft of this one
// did — esbuild refused the file with `Expected ";" but found "line"`, which is
// at least louder than what CSS does with the same mistake.
//
// Quoted text is walked through rather than around, because a terminator
// inside `content: "..."` is legal CSS and not stray. Nothing in this tree
// writes one today, so that arm keeps the answer honest rather than carrying
// anything.
function commentFaults(css: string): string[] {
  const out: string[] = [];
  let line = 1;
  let col = 1;
  /** Where the open comment started, or null outside one. */
  let openedAt: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    const next = css[i + 1];
    if (ch === "\n") {
      line++;
      col = 1;
      continue;
    }
    const at = `${line}:${col}`;
    col++;
    if (openedAt !== null) {
      if (ch === "*" && next === "/") {
        openedAt = null;
        i++;
        col++;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === "\\") {
        i++;
        col++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "/" && next === "*") {
      openedAt = at;
      i++;
      col++;
    } else if (ch === "*" && next === "/") out.push(`${at} stray */`);
  }
  if (openedAt !== null) out.push(`${openedAt} unclosed /*`);
  return out;
}

describe("no stylesheet closes a comment it did not open", () => {
  it("reads every stylesheet in the tree — a short read would make this cheap", () => {
    expect(sheets.length).toBeGreaterThan(5);
  });

  it.each(sheets.map((s) => [s.rel, s.text] as const))("%s", (rel, text) => {
    expect(
      commentFaults(text),
      `${rel} closes a comment it did not open, or leaves one open — either way the CSS ` +
        `parser loses what follows`,
    ).toEqual([]);
  });

  // The instrument, before it is believed. Without this the walk could answer
  // "none" for every file — including one that is broken — and the whole suite
  // above would be green about nothing.
  it("finds one when there is one, and only then", () => {
    // Count it by hand once, because a column that drifts is unfalsifiable:
    // `   tail. */` is three spaces, `tail.` (five), a space — so the `*` is the
    // tenth character of the line and the answer is 10, not 11.
    expect(commentFaults("/* a */\n   tail. */\n.hl-keyword { color: red; }")).toEqual(["2:10 stray */"]);
    expect(commentFaults("/* a\n   tail. */\n.hl-keyword { color: red; }")).toEqual([]);
    // A terminator inside a string is text, not a terminator.
    expect(commentFaults('.a::after { content: "*/"; }')).toEqual([]);
    // And the other half of the sentence at the head of this file.
    expect(commentFaults("/* never closed\n.hl-keyword { color: red; }")).toEqual(["1:1 unclosed /*"]);
  });
});
