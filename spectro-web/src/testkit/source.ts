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

/**
 * The same, plus line comments to the end of the line — prose about a deleted
 * class is not the class. Newlines stay, so line counts still hold.
 */
export function stripComments(src: string): string {
  return blankBlockComments(src).replace(/\/\/[^\n]*/g, "");
}
