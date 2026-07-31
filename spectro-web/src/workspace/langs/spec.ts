// The vocabulary contract shared by every language file.
//
// It lives here rather than in highlight.ts so that a language file never
// imports the engine: the engine imports the languages, and a language file
// reaching back the other way would close a cycle through the registry that
// derives HlLang from it.

/** What the tokenizer needs to know to read one language. */
export interface LangSpec {
  /** Line-comment prefixes (rest of the line is a comment). */
  line: readonly string[];
  /** Block comment [open, close], if the language has one. */
  block?: readonly [string, string];
  /** Both block delimiters only count as a word owning its own line: column zero,
   *  followed by whitespace or the end of the file. Ruby's =begin / =end, where
   *  the same six characters mid-line are an assignment and the pair has no
   *  closer to bound the mistake. */
  blockOwnsLine?: boolean;
  /** Multi-char string fences that span lines (python triple quotes). */
  triple?: readonly string[];
  /** Single-char string delimiters. */
  quotes: readonly string[];
  /** Delimiters that open a literal exactly one character or one escape wide, and
   *  open nothing at all when no closer sits there. For a delimiter the language
   *  also spends on something open-ended — Rust's apostrophe, which names a
   *  lifetime — this is what tells the two apart without a parser. */
  charQuotes?: readonly string[];
  /**
   * Read `/…/flags` as a literal where a regex is legal. Only for languages whose
   * regex form is written with slashes AND whose line comment is `//`, which is the
   * collision it exists to resolve: an escaped slash inside the literal puts two
   * slashes side by side, and without this the comment opener wins from there to the
   * end of the line. A language with no such form must leave it off — the engine
   * then never guesses at a slash, and division stays punctuation.
   */
  regex?: boolean;
  keywords: ReadonlySet<string>;
  /** Look keywords up lower-cased — SQL is conventionally shouted. */
  foldCase?: boolean;
}

/**
 * One language, complete: how it is selected and how it is read.
 *
 * The two name lists sit next to the spec on purpose. They used to live in maps
 * of their own, far from the vocabulary they select, and nothing kept the three
 * in step — a language could answer to a fence name it no longer read.
 */
export interface LangDef {
  /** Markdown fence names that select it (```sql, ```bash), lower-case. */
  readonly aliases: readonly string[];
  /** File extensions that select it, lower-case, without the leading dot. */
  readonly extensions: readonly string[];
  readonly spec: LangSpec;
}
