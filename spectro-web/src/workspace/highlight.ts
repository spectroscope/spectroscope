// A tiny, dependency-free, CSP-safe syntax highlighter for the workspace file
// preview. It is a pure tokenizer: source string in, a flat list of
// {text, class} tokens out, which the component renders as <span> elements —
// no innerHTML, no highlight library, no network. The one hard invariant
// (property-tested) is that concatenating every token's text reproduces the
// source byte-for-byte, so the preview always reads exactly like the file.
//
// Deliberately small: it colours keywords, strings, comments and numbers for a
// handful of languages. It is a preview, not an editor — good enough to read,
// never claiming to be a parser.

export type TokenClass = "keyword" | "string" | "comment" | "number" | "plain";

export interface Token {
  text: string;
  cls: TokenClass;
}

export type HlLang = "java" | "python" | "shell" | "json" | "sql";

interface LangSpec {
  /** Line-comment prefixes (rest of the line is a comment). */
  line: string[];
  /** Block comment [open, close], if the language has one. */
  block?: [string, string];
  /** Multi-char string fences that span lines (python triple quotes). */
  triple?: string[];
  /** Single-char string delimiters. */
  quotes: string[];
  keywords: ReadonlySet<string>;
  /** Look keywords up lower-cased — SQL is conventionally shouted. */
  foldCase?: boolean;
}

const JAVA_KW = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "native",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "try",
  "void",
  "volatile",
  "while",
  "var",
  "record",
  "sealed",
  "permits",
  "yield",
  "true",
  "false",
  "null",
]);

const PY_KW = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "match",
  "case",
  "self",
]);

const SQL_KW: ReadonlySet<string> = new Set([
  "select",
  "from",
  "where",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "alter",
  "drop",
  "table",
  "index",
  "view",
  "database",
  "schema",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "full",
  "cross",
  "on",
  "using",
  "group",
  "order",
  "by",
  "having",
  "limit",
  "offset",
  "union",
  "all",
  "distinct",
  "as",
  "and",
  "or",
  "not",
  "null",
  "is",
  "in",
  "like",
  "between",
  "exists",
  "case",
  "when",
  "then",
  "else",
  "end",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "primary",
  "foreign",
  "key",
  "references",
  "constraint",
  "unique",
  "default",
  "begin",
  "commit",
  "rollback",
  "transaction",
  "grant",
  "revoke",
  "with",
  "asc",
  "desc",
  "true",
  "false",
  "if",
  "add",
  "column",
  "rename",
  "truncate",
]);

const SH_KW = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "select",
  "return",
  "break",
  "continue",
  "local",
  "export",
  "declare",
  "readonly",
  "source",
  "set",
  "unset",
  // The commands themselves. A shell transcript is read for WHAT IT DID, so the
  // verb at the head of a line carries more meaning than the control keyword —
  // and a session that greps a compromised host is all verbs and no `if`.
  "cat",
  "cd",
  "chmod",
  "chown",
  "cp",
  "curl",
  "cut",
  "df",
  "diff",
  "du",
  "echo",
  "find",
  "grep",
  "head",
  "kill",
  "ln",
  "ls",
  "mkdir",
  "mv",
  "printf",
  "ps",
  "pwd",
  "rm",
  "rmdir",
  "scp",
  "sed",
  "sort",
  "ssh",
  "stat",
  "sudo",
  "tail",
  "tar",
  "tee",
  "touch",
  "tr",
  "uniq",
  "wc",
  "wget",
  "which",
  "xargs",
  "zip",
  "unzip",
  "awk",
  "git",
  "npm",
  "node",
  "python",
  "python3",
  "pip",
  "java",
  "docker",
  "systemctl",
  "service",
  "mysql",
  "psql",
  "sqlite3",
  "openssl",
  "rsync",
  "nohup",
  "exec",
  "eval",
  "test",
  "sleep",
  "date",
  "env",
  "expect",
  "spawn",
  "send",
]);

const JSON_KW = new Set(["true", "false", "null"]);

const SPECS: Record<HlLang, LangSpec> = {
  java: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"], keywords: JAVA_KW },
  python: { line: ["#"], triple: ['"""', "'''"], quotes: ['"', "'"], keywords: PY_KW },
  shell: { line: ["#"], quotes: ['"', "'"], keywords: SH_KW },
  json: { line: [], quotes: ['"'], keywords: JSON_KW },
  // SQL keywords are conventionally written upper-case, so the lookup folds case.
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'", '"'], keywords: SQL_KW, foldCase: true },
};

const EXT_LANG: Record<string, HlLang> = {
  java: "java",
  py: "python",
  pyw: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  json: "json",
  sql: "sql",
};

/** The language name written on a markdown fence (```sql, ```bash, ```py …).
 *  Unknown fences return null so the block renders plain rather than wrong. */
export function hlLangForFence(fence: string): HlLang | null {
  const name = fence.trim().toLowerCase();
  if (name === "") return null;
  const direct: Record<string, HlLang> = {
    java: "java",
    python: "python",
    py: "python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    shell: "shell",
    console: "shell",
    json: "json",
    sql: "sql",
    mysql: "sql",
    postgres: "sql",
    postgresql: "sql",
    sqlite: "sql",
  };
  return direct[name] ?? null;
}

export function hlLangForPath(path: string): HlLang | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Characters that bind a word into a larger name — a dotted host, a path, a
 *  flag, an identifier. A word touching one of these is a fragment, not a
 *  keyword. */
function isGlue(c: string | undefined): boolean {
  return c === "." || c === "/" || c === "-" || c === "_" || c === "@" || c === ":";
}

const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean =>
  (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_" || c === "$";
const isIdent = (c: string): boolean => isIdentStart(c) || isDigit(c);

const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?)[lLfFdDjJ]?/y;

export function tokenize(src: string, lang: HlLang): Token[] {
  const spec = SPECS[lang];
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  const push = (end: number, cls: TokenClass): void => {
    // Merge adjacent plain runs so the DOM stays light.
    const last = out[out.length - 1];
    if (cls === "plain" && last !== undefined && last.cls === "plain") {
      last.text += src.slice(i, end);
    } else {
      out.push({ text: src.slice(i, end), cls });
    }
    i = end;
  };

  while (i < n) {
    const c = src[i];

    if (isSpace(c)) {
      let j = i + 1;
      while (j < n && isSpace(src[j])) j++;
      push(j, "plain");
      continue;
    }

    // Block comment.
    if (spec.block !== undefined && src.startsWith(spec.block[0], i)) {
      const close = src.indexOf(spec.block[1], i + spec.block[0].length);
      push(close < 0 ? n : close + spec.block[1].length, "comment");
      continue;
    }

    // Line comment.
    let lineHit = false;
    for (const lc of spec.line) {
      if (src.startsWith(lc, i)) {
        let end = src.indexOf("\n", i);
        if (end < 0) end = n;
        push(end, "comment");
        lineHit = true;
        break;
      }
    }
    if (lineHit) continue;

    // Triple-quoted string (python).
    if (spec.triple !== undefined) {
      const fence = spec.triple.find((f) => src.startsWith(f, i));
      if (fence !== undefined) {
        const close = src.indexOf(fence, i + fence.length);
        push(close < 0 ? n : close + fence.length, "string");
        continue;
      }
    }

    // Single-delimiter string, escape-aware, closing at the delimiter or a
    // newline (so an unterminated quote can never swallow the rest of the file).
    if (spec.quotes.includes(c)) {
      let j = i + 1;
      while (j < n) {
        const cj = src[j];
        if (cj === "\\") {
          j += 2;
          continue;
        }
        if (cj === c) {
          j++;
          break;
        }
        if (cj === "\n") break;
        j++;
      }
      push(Math.min(j, n), "string");
      continue;
    }

    // Number.
    if (isDigit(c)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m !== null && m.index === i && m[0].length > 0) {
        push(i + m[0].length, "number");
        continue;
      }
    }

    // Identifier / keyword.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      const lookup = spec.foldCase === true ? word.toLowerCase() : word;
      // A keyword only counts when it stands alone. Without this, `in` lights
      // up inside the hostname uft.in.ua, `test` inside a path, `set` inside
      // an option — the scanner splits on punctuation, so every dotted or
      // slashed name is a bag of would-be keywords.
      const glued = isGlue(src[i - 1]) || isGlue(src[j]);
      push(j, !glued && spec.keywords.has(lookup) ? "keyword" : "plain");
      continue;
    }

    // Anything else: punctuation, one char at a time (merged into plain runs).
    push(i + 1, "plain");
  }

  return out;
}
