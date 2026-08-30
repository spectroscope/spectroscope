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
// So this asks one question of every stylesheet in the tree: is every `*/`
// the end of a comment that was open? It says nothing about anything else a
// stylesheet can get wrong — a lost rule has one cause here and this is it.

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

// Where a comment terminator stands outside a comment, as `line:column`,
// one-based.
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
function orphanTerminators(css: string): string[] {
  const out: string[] = [];
  let line = 1;
  let col = 1;
  let inComment = false;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    const next = css[i + 1];
    if (ch === "\n") {
      line++;
      col = 1;
      continue;
    }
    col++;
    if (inComment) {
      if (ch === "*" && next === "/") {
        inComment = false;
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
      inComment = true;
      i++;
      col++;
    } else if (ch === "*" && next === "/") out.push(`${line}:${col}`);
  }
  return out;
}

describe("no stylesheet closes a comment it did not open", () => {
  it("reads every stylesheet in the tree — a short read would make this cheap", () => {
    expect(sheets.length).toBeGreaterThan(5);
  });

  it.each(sheets.map((s) => [s.rel, s.text] as const))("%s", (rel, text) => {
    expect(
      orphanTerminators(text),
      `${rel} has a */ outside a comment, and the CSS parser swallows the rule after it`,
    ).toEqual([]);
  });

  // The instrument, before it is believed. Without this the walk could answer
  // "none" for every file — including one that is broken — and the whole suite
  // above would be green about nothing.
  it("finds one when there is one, and only then", () => {
    expect(orphanTerminators("/* a */\n   tail. */\n.hl-keyword { color: red; }")).toEqual(["2:11"]);
    expect(orphanTerminators("/* a\n   tail. */\n.hl-keyword { color: red; }")).toEqual([]);
    // A terminator inside a string is text, not a terminator.
    expect(orphanTerminators('.a::after { content: "*/"; }')).toEqual([]);
  });
});
