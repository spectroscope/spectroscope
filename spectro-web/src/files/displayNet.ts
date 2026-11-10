// Card 605, task 11 fix round 2 item 1: the display net. It runs after the
// rule masks on every free text the report prints (commands, the title) and
// hides each segment of four or more characters that mixes letters and
// digits, or upper case, lower case and a symbol. A segment ends at a blank
// and at one of " ' ` = : , ; & ? ( ) [ ] { } < > |. It leaves a path word, a
// URL's scheme and host, an option, the program of a command, a number or a
// version and an ISO time, and the labels the rule masks wrote. It only masks:
// it counts nothing and makes no finding.

import type { Lang } from "../i18n/i18n";

/** What the net prints for a hidden segment, in the report model; the renderers name it per language. */
export const HIDDEN_MASK = "[hidden]";
const HIDDEN_DE = "[verdeckt]";

/** The text with the net's marker in the reader's language. */
export const inLanguage = (text: string, lang: Lang): string =>
  lang === "de" ? text.split(HIDDEN_MASK).join(HIDDEN_DE) : text;

/** The labels of the rule masks and the net's own marker: printed as they are. */
const LABEL = /\[credential(?: \d+)?: [a-z-]+\]|\[value\]|\[hidden\]/g;
const ISO_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
/** A URL in the shadow text, where every kept span is one private character per character. */
const URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>|(){}[\]]*/g;
const KEPT = "";
const MARKS = new Set([..." \t\r\n\"'`=:,;&?()[]{}<>|"]);

const OPTION = /^(?:-[A-Za-z]+|--[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)$/;
const VERSION = /^v?\d+(?:\.\d+)*(?:-[A-Za-z]+(?:\.\d+)?)?$/;
const FILE_NAME = /(?:^|\/)[^/]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "while", "until", "do", "done", "fi"]);

/** A filesystem path word: it starts at a root or a relative mark, or holds `/` and ends in a file name. */
const isPathWord = (s: string): boolean =>
  /^(?:\/|~|\.\/|\.\.\/)/.test(s) || (s.includes("/") && FILE_NAME.test(s));

/** Whether the net hides a segment. */
function hides(segment: string): boolean {
  if ([...segment].length < 4) return false;
  if (OPTION.test(segment) || VERSION.test(segment) || isPathWord(segment)) return false;
  let letter = false;
  let digit = false;
  let upper = false;
  let lower = false;
  let symbol = false;
  for (const c of segment) {
    if (/\p{Lu}/u.test(c)) upper = letter = true;
    else if (/\p{L}/u.test(c)) lower = letter = true;
    else if (/\p{N}/u.test(c)) digit = true;
    else symbol = true;
  }
  return (letter && digit) || (upper && lower && symbol);
}

/**
 * Where each command of a line starts: the text's start, and after `;`, `&&`,
 * `||`, `|`, `&`, a line break, `(`, a backtick or `$(` outside quotes.
 */
function commandStarts(text: string): number[] {
  const starts = [0];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      starts.push(i + 2);
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (";&|\n(`".includes(c)) starts.push(i + 1);
  }
  return starts;
}

/** The first word of each command of a line that is no assignment and no reserved word: its program. */
function programs(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const start of commandStarts(text)) {
    let at = start;
    for (;;) {
      while (at < text.length && /\s/.test(text[at]) && text[at] !== "\n") at++;
      const from = at;
      while (at < text.length && !/\s/.test(text[at]) && !";&|`()".includes(text[at])) at++;
      if (at === from) break;
      const word = text.slice(from, at);
      if (ASSIGNMENT.test(word) || RESERVED.has(word)) continue;
      out.push([from, at]);
      break;
    }
  }
  return out;
}

/**
 * The text with every segment the net hides replaced by HIDDEN_MASK.
 * `command`: the text is a shell command, so the program of each of its
 * commands is left.
 */
export function displayNet(text: string, { command = false }: { command?: boolean } = {}): string {
  const n = text.length;
  if (n === 0) return text;
  const keep = new Uint8Array(n);
  const split = new Uint8Array(n);
  let shadow = text;
  for (const re of [LABEL, ISO_TIME]) {
    for (const m of shadow.matchAll(re)) {
      keep.fill(1, m.index, m.index + m[0].length);
      shadow = shadow.slice(0, m.index) + KEPT.repeat(m[0].length) + shadow.slice(m.index + m[0].length);
    }
  }
  for (const m of shadow.matchAll(URL)) {
    const from = m.index;
    const end = from + m[0].length;
    const authority = shadow.indexOf("://", from) + 3;
    keep.fill(1, from, authority);
    let authEnd = authority;
    while (authEnd < end && !"/?#".includes(shadow[authEnd])) authEnd++;
    const at = shadow.lastIndexOf("@", authEnd - 1);
    keep.fill(1, at >= authority ? at + 1 : authority, authEnd);
    // Inside a URL a path's `/`, a fragment's `#` and the userinfo's `@` end a segment too.
    for (let i = authority; i < end; i++) if ("/#@".includes(shadow[i])) split[i] = 1;
  }
  if (command) for (const [from, to] of programs(text)) keep.fill(1, from, to);
  let out = "";
  for (let i = 0; i < n;) {
    if (keep[i] || split[i] || MARKS.has(text[i])) {
      out += text[i++];
      continue;
    }
    let j = i;
    while (j < n && !keep[j] && !split[j] && !MARKS.has(text[j])) j++;
    const segment = text.slice(i, j);
    out += hides(segment) ? HIDDEN_MASK : segment;
    i = j;
  }
  return out;
}
