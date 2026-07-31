// A tiny, dependency-free, CSP-safe syntax highlighter for the workspace file
// preview. It is a pure tokenizer: source string in, a flat list of
// {text, class} tokens out, which the component renders as <span> elements —
// no innerHTML, no highlight library, no network. The one hard invariant
// (property-tested) is that concatenating every token's text reproduces the
// source byte-for-byte, so the preview always reads exactly like the file.
//
// Deliberately small: it colours keywords, strings, comments and numbers. It is
// a preview, not an editor — good enough to read, never claiming to be a parser.
//
// This file is the engine and nothing else. Every language's vocabulary lives in
// langs/<id>.ts, and langs/registry.ts lists them; the recipe for adding one is
// the doc comment on that list. Growing the language count must not grow this
// file, which is why the mechanism below is fixed at five token classes.

import { LANGS } from "./langs/registry";

export type TokenClass = "keyword" | "string" | "comment" | "number" | "plain";

export interface Token {
  text: string;
  cls: TokenClass;
}

/** Derived from the registry, so a new language file names itself here too. */
export type HlLang = keyof typeof LANGS;

// The two name→language lookups, assembled from the registry in one pass so a
// fence name and a file extension can never disagree about who owns them.
//
// Maps, not plain objects: an object lookup answers `constructor` out of
// Object.prototype, and that answer is not nullish, so it would survive the
// `?? null` below and be returned as though `x.constructor` were a language.
const ALIAS_LANG = new Map<string, HlLang>();
const EXT_LANG = new Map<string, HlLang>();
for (const id of Object.keys(LANGS) as HlLang[]) {
  for (const alias of LANGS[id].aliases) ALIAS_LANG.set(alias, id);
  for (const ext of LANGS[id].extensions) EXT_LANG.set(ext, id);
}

/** The language name written on a markdown fence (```sql, ```bash, ```py …).
 *  Unknown fences return null so the block renders plain rather than wrong. */
export function hlLangForFence(fence: string): HlLang | null {
  const name = fence.trim().toLowerCase();
  if (name === "") return null;
  return ALIAS_LANG.get(name) ?? null;
}

export function hlLangForPath(path: string): HlLang | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG.get(name.slice(dot + 1).toLowerCase()) ?? null;
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

/** Whether `word` at `at` owns its line: column zero, and nothing but whitespace
 *  or the end of the file behind it (spec.blockOwnsLine). */
function ownsLine(src: string, at: number, word: string): boolean {
  if (at !== 0 && src[at - 1] !== "\n") return false;
  const after = at + word.length;
  return after >= src.length || isSpace(src[after]);
}

/**
 * Index just past a one-character literal opening at `at`, or -1 when the
 * delimiter opens nothing (spec.charQuotes).
 *
 * The lookahead is bounded by the shape of the literal rather than by a character
 * count, and that is the whole point: a scan for the next matching delimiter would
 * pair the two apostrophes in `where T: 'a, U: 'b` and paint the gap. A literal
 * holds one code point or one escape and then closes, or it is not a literal.
 */
function charLiteralEnd(src: string, at: number, q: string): number {
  const n = src.length;
  let k = at + 1;
  if (k >= n) return -1;
  if (src[k] === "\\") {
    k++;
    if (k >= n) return -1;
    if (src[k] === "u" && src[k + 1] === "{") {
      // The payload rides inside the escape: `'\u{1F600}'`. Six digits reach the
      // widest scalar there is, so the bound stops there and a zero-padded or
      // underscored escape written longer than that stays plain.
      const close = src.indexOf("}", k + 2);
      if (close < 0 || close > k + 8) return -1;
      k = close + 1;
    } else if (src[k] === "x") {
      k += 3;
    } else {
      k++;
    }
  } else if (src[k] === "\n") {
    return -1;
  } else {
    // One code point, which is two UTF-16 units above the BMP. Counting units here
    // would reject `'😀'` and split the pair.
    k += (src.codePointAt(k) ?? 0) > 0xffff ? 2 : 1;
  }
  return src[k] === q ? k + 1 : -1;
}

// ── Regex literals (spec.regex) ──────────────────────────────────────────────
//
// Telling `/re/` from division cannot be done without a parser, so the rule below
// is a one-sided guess and the side is chosen deliberately. Reading division as a
// literal would paint an arithmetic expression as a string, which is the one thing
// this module refuses; reading a literal as division only leaves the literal grey.
// So a slash opens a literal ONLY where the preceding token cannot end a value,
// and every position the rule is unsure about is division.
//
// Punctuation a value can never end with, so a slash after it must begin one.
// `)` and `]` are deliberately absent: they close a call or an index far more often
// than they precede a literal, and `(a + b) / c` must stay arithmetic.
//
// A closing brace is absent for a sharper reason than taste. JSX belongs to this
// same vocabulary, and it ends a prop with `}` and a tag with `/>`: two elements on
// one line put a permitted opener in front of the first slash and a second slash
// further along, so `<A x={1} /> <B y={2} />` would paint its middle as a literal.
// The regex a closing brace would have bought — one at statement start after a block
// — is rare enough to leave grey instead.
const REGEX_OPENS_AFTER = new Set(["=", "(", ",", ":", "[", "!", "&", "|", "?", "{", ";"]);

// Words that can only be followed by the start of an expression. Any other word is
// read as a value, which is what keeps `total / 2` and `row.count / n` arithmetic.
const REGEX_OPENS_AFTER_WORD: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "instanceof",
  "throw",
]);

const REGEX_FLAGS = "dgimsuvy";

/** Whether the slash at `i` may open a regex literal. Errs toward division. */
function regexOpensAt(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && isSpace(src[k])) k--;
  if (k < 0) return true;
  const p = src[k];
  if (REGEX_OPENS_AFTER.has(p)) return true;
  // `=>` is the one two-character case worth reading: a slash after an arrow can
  // never be division, while a bare `>` closes a comparison or a type argument list
  // and must not open anything.
  if (p === ">") return k > 0 && src[k - 1] === "=";
  if (!isIdent(p)) return false;
  let s = k;
  while (s > 0 && isIdent(src[s - 1])) s--;
  // A member read spells these words too, and then it is a value: `bytes.in` and
  // `map.delete` end an expression, so `bytes.in / bytes.out` is a division.
  if (src[s - 1] === "." || src[s - 1] === "#") return false;
  return REGEX_OPENS_AFTER_WORD.has(src.slice(s, k + 1));
}

/** Index just past the closing slash and its flags, or -1 to decline the guess. */
function regexEndsAt(src: string, i: number): number {
  const n = src.length;
  // A slash inside a character class does not close the literal, and `/[^/]+/` is
  // common enough to be worth the flag. A flag rather than a depth count is right:
  // `[` inside a class is an ordinary character, so classes do not nest.
  let inClass = false;
  let closed = false;
  let j = i + 1;
  while (j < n) {
    const cj = src[j];
    if (cj === "\\") {
      j += 2;
      continue;
    }
    // An unterminated literal is a syntax error, so a slash with no partner on its
    // line is far likelier to be division. Declining leaves the line plain; running
    // on would swallow it.
    if (cj === "\n") break;
    if (inClass) {
      if (cj === "]") inClass = false;
    } else if (cj === "[") {
      inClass = true;
    } else if (cj === "/") {
      j++;
      closed = true;
      break;
    }
    j++;
  }
  if (!closed) return -1;
  while (j < n && REGEX_FLAGS.includes(src[j])) j++;
  return j;
}

export function tokenize(src: string, lang: HlLang): Token[] {
  const spec = LANGS[lang].spec;
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

    // Block comment. Where the delimiters are words that own their line, both ends
    // carry the constraint: an opener that only counts in column zero paired with a
    // closer that counts anywhere would end a real comment on the first indented
    // mention of the closing word, and read the prose after it as code.
    if (
      spec.block !== undefined &&
      src.startsWith(spec.block[0], i) &&
      (spec.blockOwnsLine !== true || ownsLine(src, i, spec.block[0]))
    ) {
      let close = -1;
      let from = i + spec.block[0].length;
      for (;;) {
        const at = src.indexOf(spec.block[1], from);
        if (at < 0) break;
        if (spec.blockOwnsLine !== true || ownsLine(src, at, spec.block[1])) {
          close = at;
          break;
        }
        from = at + 1;
      }
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

    // One-character literal, checked before the string branch: a language that
    // spends this delimiter on something open-ended as well cannot list it in
    // `quotes`, and then the literal's own contents — a quote character — open a
    // string that runs to the newline. Declining leaves the delimiter plain.
    if (spec.charQuotes !== undefined && spec.charQuotes.includes(c)) {
      const end = charLiteralEnd(src, i, c);
      if (end > 0) {
        push(end, "string");
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

    // Regex literal. It sits after both comment branches on purpose: `//` and `/*`
    // are always comments in the languages that set this flag — an empty regex is
    // written `/(?:)/` and a regex cannot open with a quantifier — so letting the
    // comment branches answer first keeps their behaviour exactly as it was, and the
    // scan below only ever starts at a slash they declined. Emitted as `string`
    // because a regex is a literal and the five classes are fixed.
    if (spec.regex === true && c === "/" && regexOpensAt(src, i)) {
      const end = regexEndsAt(src, i);
      if (end > i) {
        push(end, "string");
        continue;
      }
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
