import type { LangDef } from "./spec";

// The declaration, statement and expression keywords, plus the context-sensitive
// modifiers a reader meets as syntax.
//
// LEFT OUT: `package`, which is an access level almost nobody writes and the
// variable every Package.swift declares (`let package = Package(…)`); `open`, for
// the same reason `fun open(path)` keeps its colour in Kotlin; `get` and `set`,
// which are ordinary function names; the operator-declaration modifiers `prefix`,
// `postfix` and `infix`, whose syntax is rare while `let prefix = "run-"` is not;
// and `left`, `right`, `none`, `optional`, `precedence`, `associativity`, `Type`
// and `Protocol`, which are names first and syntax a distant second.
//
// `endif` and `elseif` are in so that `#if DEBUG … #endif` reads symmetrically —
// `if` and `else` are keywords anyway, and neither of the two is ever a name. The
// other pound expressions are not: their bare words are `file`, `line`,
// `function`, `selector`, `available`, `warning`, `error`, and each of those is an
// ordinary identifier. Those directives stay plain.
const KEYWORDS: ReadonlySet<string> = new Set([
  // Declarations.
  "associatedtype",
  "class",
  "deinit",
  "enum",
  "extension",
  "fileprivate",
  "func",
  "import",
  "init",
  "inout",
  "internal",
  "let",
  "operator",
  "precedencegroup",
  "private",
  "protocol",
  "public",
  "static",
  "struct",
  "subscript",
  "typealias",
  "var",
  // Statements.
  "break",
  "case",
  "catch",
  "continue",
  "default",
  "defer",
  "do",
  "else",
  "fallthrough",
  "for",
  "guard",
  "if",
  "in",
  "repeat",
  "return",
  "switch",
  "throw",
  "where",
  "while",
  // Expressions and types.
  "Any",
  "as",
  "async",
  "await",
  "false",
  "is",
  "nil",
  "rethrows",
  "self",
  "Self",
  "some",
  "any",
  "super",
  "throws",
  "true",
  "try",
  // Context-sensitive modifiers that read as syntax wherever they appear.
  "actor",
  "convenience",
  "didSet",
  "final",
  "indirect",
  "lazy",
  "mutating",
  "nonisolated",
  "nonmutating",
  "override",
  "required",
  "unowned",
  "weak",
  "willSet",
  "endif",
  "elseif",
]);

export const swift: LangDef = {
  aliases: ["swift"],
  extensions: ["swift"],
  // Only `"`: a single quote delimits nothing in Swift, and listing it would turn
  // the apostrophe in a string into an opening delimiter.
  //
  // `"""` sits in `triple` because a multiline literal spans lines and the
  // single-quote scanner stops at the first newline. Interpolation rides along
  // inside the literal: `\(` reads as an escape, so the scanner runs on to the
  // closing quote and the whole string stays one token.
  //
  // Swift nests block comments; this one ends at the first `*/`, so the tail of an
  // outer comment reads as code. Nothing is lost, only mis-shaded.
  spec: {
    line: ["//"],
    block: ["/*", "*/"],
    triple: ['"""'],
    quotes: ['"'],
    keywords: KEYWORDS,
  },
};
