import type { LangDef } from "./spec";

// The reserved words. Every one of these is illegal as an identifier in C# — a
// variable called `object` or `out` has to be written `@object`, `@out` — so
// colouring them cannot paint a name, and the whole set is in without argument.
// That is why the primitive type names sit here while the TypeScript spec has to
// weigh them: in C# they are reserved, in TypeScript they are merely conventional.
const RESERVED: readonly string[] = [
  "abstract",
  "as",
  "base",
  "bool",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "checked",
  "class",
  "const",
  "continue",
  "decimal",
  "default",
  "delegate",
  "do",
  "double",
  "else",
  "enum",
  "event",
  "explicit",
  "extern",
  "false",
  "finally",
  "fixed",
  "float",
  "for",
  "foreach",
  "goto",
  "if",
  "implicit",
  "in",
  "int",
  "interface",
  "internal",
  "is",
  "lock",
  "long",
  "namespace",
  "new",
  "null",
  "object",
  "operator",
  "out",
  "override",
  "params",
  "private",
  "protected",
  "public",
  "readonly",
  "ref",
  "return",
  "sbyte",
  "sealed",
  "short",
  "sizeof",
  "stackalloc",
  "static",
  "string",
  "struct",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "uint",
  "ulong",
  "unchecked",
  "unsafe",
  "ushort",
  "using",
  "virtual",
  "void",
  "volatile",
  "while",
];

// The contextual words, which are keywords only in one position and ordinary
// identifiers everywhere else. These are the ones that need judging, and the test
// is whether the word is a plausible lower-case local or parameter — C# names its
// members in PascalCase, so a lower-case word is nearly always a local.
//
// Eight are left out for failing that test, each with a counter-example that
// occurs more often than the keyword does:
//
//   value               `var value = row.Value` outnumbers the setter body
//   args                `static int Main(string[] args)`
//   file                `foreach (var file in files)`; `file class` is a niche
//   get set add remove  `var set = new HashSet<int>()`; excluded as a family, so
//                       that `{ get; set; }` reads uniformly grey rather than
//                       half-lit
//   from                `GetRange(from, to)` — a range bound, not a query head
//   on                  `bool on = true` — a toggle
//   group               `var group = groups.First()`
//
// Dropping `from`, `on` and `group` costs some colour inside a LINQ query
// expression, which is a minority style next to the PascalCase method chain, and
// buys back three of the most ordinary names in the language. `where` stays: it
// is also the generic constraint, which is everywhere, and no one names a local
// `where`.
const CONTEXTUAL: readonly string[] = [
  "and",
  "ascending",
  "async",
  "await",
  "by",
  "descending",
  "dynamic",
  "equals",
  "global",
  "init",
  "into",
  "join",
  "let",
  "nameof",
  "not",
  "notnull",
  "or",
  "orderby",
  "partial",
  "record",
  "required",
  "scoped",
  "select",
  "unmanaged",
  "var",
  "when",
  "where",
  "with",
  "yield",
];

const KEYWORDS: ReadonlySet<string> = new Set([...RESERVED, ...CONTEXTUAL]);

export const csharp: LangDef = {
  aliases: ["csharp", "cs", "c#", "dotnet"],
  extensions: ["cs", "csx"],
  // Four string forms, three of which the fixed mechanism already reads:
  //
  //   "…"        the escape-aware scanner
  //   '…'        the same, which is also the char literal
  //   $"…{x}…"   the `$` scans as a bare identifier and stays plain punctuation;
  //              the quoted body colours, interpolation holes included
  //   """…"""    a raw string spans lines, so it goes in `triple`, where the fence
  //              runs to its match. A one- or two-quote run cannot match a
  //              three-quote fence, so `""` and `"a"` are unaffected.
  //
  // The verbatim form `@"…"` is the honest gap: `@` stays plain and the body
  // colours, but the scanner treats `\` as an escape and verbatim strings do not
  // have escapes. So `@"path\"` over-runs by the two characters that close it, and
  // the doubled-quote escape in `@"a""b"` reads as two strings. Both stay inside
  // the line and neither can lose a byte, which is the invariant that matters; a
  // verbatim flag would be new mechanism for a preview that is already legible.
  spec: {
    line: ["//"],
    block: ["/*", "*/"],
    triple: ['"""'],
    quotes: ['"', "'"],
    keywords: KEYWORDS,
  },
};
