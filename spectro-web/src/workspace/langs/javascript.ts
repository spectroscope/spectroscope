import type { LangDef } from "./spec";

// Plain JavaScript only. `ts`, `tsx`, `mts` and `cts` belong to typescript.ts and
// must not be listed here as well: both name lookups are built by walking the
// registry into a Map, so a second claim does not clash — it hands the name to
// whichever language is keyed later, which is alphabetical order and nobody's
// intent. Read with this set, a .ts file leaves `interface`, `type`, `keyof` and
// every primitive type name grey, which is the whole reason the two specs exist
// separately.
//
// `get` and `set` are deliberately absent. Both are ordinary identifiers in
// real code (`const set = new Set()`), and a variable painted as syntax is the
// mistake this module refuses to make.
const KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
]);

export const javascript: LangDef = {
  // `jsx` stays here while `tsx` goes to typescript: a .jsx file has no type
  // annotations to miss, so the JS vocabulary reads it completely.
  aliases: ["js", "javascript", "mjs", "cjs", "jsx", "node"],
  extensions: ["js", "mjs", "cjs", "jsx"],
  // The backtick sits in `triple` because a template literal spans lines and
  // the single-quote scanner stops at the first newline; the fence mechanism
  // runs to the matching delimiter, which is what a template is. Interpolated
  // `${…}` therefore colours as part of its string.
  // `regex` is not decoration: this language writes `//` inside a literal whenever
  // it escapes a slash (`/^https?:\/\//`), and the same two characters open its line
  // comment. Without the flag the comment wins from the escaped slash to the end of
  // the line.
  spec: {
    line: ["//"],
    block: ["/*", "*/"],
    triple: ["`"],
    quotes: ['"', "'"],
    regex: true,
    keywords: KEYWORDS,
  },
};
