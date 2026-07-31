import type { LangDef } from "./spec";

// Kotlin's hard keywords, plus the soft keywords and modifiers that a reader meets
// as syntax rather than as names.
//
// LEFT OUT, every one because it is more often somebody's identifier than a
// modifier: `data` (`val data = response.body()`), `out` (`val out = File(…)`),
// `open` (`fun open(path)`), `value`, `field`, `dynamic`, and the use-site targets
// `param`, `property`, `receiver`, `setparam`, `delegate`, `file`. A declaration
// keeps its colour on the hard keyword beside them — `data class` colours `class`,
// `open class` colours `class` — so the loss is small and the alternative paints
// ordinary variables as syntax.
//
// `get` and `set` are out for the reason javascript.ts gives: both are ordinary
// function names. `actual` and `expect` are out because assertion code names its
// variables `expected` and `actual`, and multiplatform declarations are rarer than
// tests. `it` is out because it is an ordinary identifier that convention merely
// binds for you inside a lambda.
const KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "class",
  "continue",
  "do",
  "else",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "when",
  "while",
  // Soft keywords: words the parser reads as syntax only in one place, kept
  // because nothing much is named after them.
  "by",
  "catch",
  "constructor",
  "finally",
  "import",
  "init",
  "where",
  // Modifiers.
  "abstract",
  "annotation",
  "companion",
  "const",
  "crossinline",
  "enum",
  "external",
  "final",
  "infix",
  "inline",
  "inner",
  "internal",
  "lateinit",
  "noinline",
  "operator",
  "override",
  "private",
  "protected",
  "public",
  "reified",
  "sealed",
  "suspend",
  "tailrec",
  "vararg",
]);

export const kotlin: LangDef = {
  aliases: ["kotlin", "kt", "kts"],
  extensions: ["kt", "kts"],
  // `"""` sits in `triple` because a raw string spans lines and the single-quote
  // scanner stops at the first newline; the fence runs to the matching delimiter,
  // which is what a raw string is. String templates therefore colour as part of
  // the literal that carries them — the tokenizer has no nesting, and a `$name`
  // shown as string is truer than a literal cut into three pieces.
  //
  // `'` is a Char literal, one character wide, and reads correctly as a string.
  // A nested block comment, which Kotlin allows, ends at the first `*/`.
  spec: {
    line: ["//"],
    block: ["/*", "*/"],
    triple: ['"""'],
    quotes: ['"', "'"],
    keywords: KEYWORDS,
  },
};
