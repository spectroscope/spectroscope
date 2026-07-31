import type { LangDef } from "./spec";

// A .ts file is still JavaScript, so the JS words are restated here in full
// rather than shared: a language file owns its vocabulary and none of them
// exports it, which is what keeps a spec readable as one list.
const JS_WORDS: readonly string[] = [
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
];

// The type-level layer, which is the whole reason this spec exists: read with the
// JavaScript vocabulary, a .ts file leaves every one of these grey.
//
// The primitive type names are IN. In a .ts file they stand overwhelmingly in
// type position (`label: string`, `Array<number>`), and the two identifier shapes
// that would otherwise catch them are already excluded by the glue rule: a
// property key is followed by `:` and a member read is preceded by `.`.
//
// `object` and `symbol` are OUT, alone among the primitives. Unlike `string` and
// `number` they are ordinary lower-case names for ordinary values — `object` is
// the obvious name for a plain object being walked, `symbol` for a ticker or the
// result of `Symbol()` — and neither is reserved in JavaScript, so nothing stops
// them being declared. A variable painted as syntax is worse than a type left
// grey.
//
// `out` is OUT for the same reason, more sharply: it is the 4.7 variance
// annotation, and it is also the name of the accumulator in this repo's own
// tokenizer. `get` and `set` stay out as they are in the javascript spec.
//
// `type` is IN despite being the sort of word this module normally refuses. It is
// the language's signature keyword, and the glue rule happens to cover both of
// its identifier shapes: `{ type: "click" }` is followed by `:` and `event.type`
// is preceded by `.`, so only a declared `const type` mis-colours, which is rare
// enough to trade for `type Foo = …` reading as syntax.
const TS_WORDS: readonly string[] = [
  "abstract",
  "accessor",
  "any",
  "asserts",
  "bigint",
  "boolean",
  "declare",
  "enum",
  "implements",
  "infer",
  "interface",
  "is",
  "keyof",
  "namespace",
  "never",
  "number",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "satisfies",
  "string",
  "type",
  "unknown",
];

const KEYWORDS: ReadonlySet<string> = new Set([...JS_WORDS, ...TS_WORDS]);

export const typescript: LangDef = {
  // `ts`, `tsx` and `typescript` belong to this spec, not to javascript's: a TS
  // block read with the JS vocabulary is exactly the grey this file fixes. The
  // registry allows one claim per name, so javascript must not also list them.
  aliases: ["ts", "tsx", "typescript"],
  extensions: ["ts", "tsx", "mts", "cts"],
  // Same literal forms as JavaScript, backtick included: a template literal spans
  // lines, and only the fence mechanism runs past a newline to its match. A type
  // annotation costs the tokenizer nothing, because `<`, `>` and `|` are already
  // punctuation. `regex` matters here for the same reason it does in JavaScript — an
  // escaped slash writes the line-comment opener inside a literal — and a generic
  // close adds one wrinkle of its own: a slash after `>` is read as division, so
  // `Array<number>` cannot start one.
  spec: {
    line: ["//"],
    block: ["/*", "*/"],
    triple: ["`"],
    quotes: ['"', "'"],
    regex: true,
    keywords: KEYWORDS,
  },
};
