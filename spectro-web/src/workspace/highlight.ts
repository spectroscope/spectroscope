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

export type HlLang = "java" | "python" | "shell" | "json";

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
}

const JAVA_KW = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
  "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
  "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
  "volatile", "while", "var", "record", "sealed", "permits", "yield", "true", "false", "null",
]);

const PY_KW = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with",
  "yield", "match", "case", "self",
]);

const SH_KW = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in",
  "function", "select", "return", "break", "continue", "local", "export", "declare", "readonly",
  "source", "set", "unset",
]);

const JSON_KW = new Set(["true", "false", "null"]);

const SPECS: Record<HlLang, LangSpec> = {
  java: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"], keywords: JAVA_KW },
  python: { line: ["#"], triple: ['"""', "'''"], quotes: ['"', "'"], keywords: PY_KW },
  shell: { line: ["#"], quotes: ['"', "'"], keywords: SH_KW },
  json: { line: [], quotes: ['"'], keywords: JSON_KW },
};

const EXT_LANG: Record<string, HlLang> = {
  java: "java",
  py: "python",
  pyw: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  json: "json",
};

export function hlLangForPath(path: string): HlLang | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[name.slice(dot + 1).toLowerCase()] ?? null;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
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
      push(j, spec.keywords.has(word) ? "keyword" : "plain");
      continue;
    }

    // Anything else: punctuation, one char at a time (merged into plain runs).
    push(i + 1, "plain");
  }

  return out;
}
