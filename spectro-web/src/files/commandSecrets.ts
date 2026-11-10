// Card 605, final fix wave item 1: the credentials of one shell command, as
// the report registers and masks them. The rules of a tool input find shapes,
// read without the plain-identifier skip (1d). A password assignment then
// masks to the end of the shell word it sits in, and a URL's userinfo from
// `://` to the last `@` of its authority (1a). The values in credential
// positions of network commands come from shellRisk (1b) under the rule name
// `position`; one that overlaps a rule's hit widens that hit instead of
// standing beside it. A query value or a user name given alone whose name
// says nothing of a credential (task 10 item 9) is only masked: it is a
// credential when a rule matches it, else it stays out of the hits.
//
// Task 11 item 1: a password value is read from the command itself. After a
// password name and its sign the value is the rest of the shell word, quotes
// removed, whatever character follows; when the word ends in the sign it is
// the next word. It counts at six or more characters, measured on the whole
// value. In a comment the words are the tokens between blanks, and every hit
// there masks to the end of its token.

import {
  findCredentials,
  passwordValue,
  ruleMatches as matchesOf,
  COMMAND_RULES,
  PASSWORD_NAME,
  PASSWORD_RULE,
  type CredentialHit,
} from "./secrets";
import { shellRisk, type ShellRisk } from "./shellRisk";
import { segments, type Word } from "./shellTokens";

/** The rule name of a value found by its place in a command, not by its shape. */
export const POSITION_RULE = "position";

/** A range of the command the report masks without a label: no credential, never printed. */
export interface MaskedRange {
  start: number;
  end: number;
}

export interface CommandReading {
  risk: ShellRisk;
  hits: CredentialHit[]; // in text order
  masked: MaskedRange[]; // in text order
  placeholders: number;
}

/** One reading per command and folder, shared by the scan, the findings and the mask. */
export class CommandReadings {
  private readonly cache = new Map<string, CommandReading>();

  of(command: string, cwd: string | null): CommandReading {
    const key = `${cwd ?? ""}\u0000${command}`;
    let reading = this.cache.get(key);
    if (reading === undefined) {
      const risk = shellRisk(command, cwd);
      reading = { risk, ...commandCredentials(command, risk) };
      this.cache.set(key, reading);
    }
    return reading;
  }
}

/** The credentials of a command: rule hits widened to their word, then the position values. */
export function commandCredentials(
  command: string,
  risk: ShellRisk,
): { hits: CredentialHit[]; masked: MaskedRange[]; placeholders: number } {
  const found = findCredentials(command, [], COMMAND_RULES, { identifiers: false });
  const words = wordsOf(command);
  const hits = found.hits.map((h) => (h.rule === "url-userinfo" ? widen(command, h, words) : h));
  const comments = commentsOf(command, words);
  const units = [
    ...words.map((w) => ({ start: w.start ?? 0, end: w.end ?? 0, comment: false })),
    ...comments,
  ];
  units.sort((a, b) => a.start - b.start);
  const placeholders = found.placeholders + assignments(command, units, hits);
  for (const h of hits) {
    const token = units.find((u) => u.comment && u.start <= h.start && h.start < u.end);
    if (token !== undefined && h.end < token.end) h.end = token.end;
  }
  const masked: MaskedRange[] = [];
  for (const v of risk.values) {
    const over = hits.filter((h) => v.start < h.end && h.start < v.end);
    if (over.some((h) => h.start <= v.start && v.end <= h.end)) continue;
    const spellings = [v.secret, v.value].filter((x, k, all) => all.indexOf(x) === k);
    if (over.length === 0 && !v.named && !spellings.some(ruleMatches)) {
      masked.push({ start: v.start, end: v.end });
      continue;
    }
    if (over.length > 0) {
      const h = over[0];
      h.start = Math.min(h.start, v.start);
      h.end = Math.max(h.end, v.end);
      const more = spellings.filter((x) => x !== h.secret);
      if (more.length > 0) h.aliases = [...(h.aliases ?? []), ...more];
      continue;
    }
    hits.push({
      rule: POSITION_RULE,
      match: v.value,
      secret: v.secret,
      start: v.start,
      end: v.end,
      ...(v.value === v.secret ? {} : { aliases: [v.value] }),
    });
  }
  hits.sort((a, b) => a.start - b.start);
  masked.sort((a, b) => a.start - b.start);
  return { hits, masked, placeholders: placeholders + risk.placeholders };
}

/** A value a credential rule of a command matches on its own. */
const ruleMatches = (value: string): boolean =>
  findCredentials(value, [], COMMAND_RULES, { identifiers: false }).hits.length > 0;

/** Every word of the command with its place, redirect targets included. */
function wordsOf(command: string): Word[] {
  const out: Word[] = [];
  for (const s of segments(command)) {
    if (typeof s === "string") continue;
    out.push(...s.words);
    for (const r of s.redirects) if (r.target) out.push(r.target);
  }
  return out.filter((w) => w.start !== undefined && w.end !== undefined);
}

const wordAt = (words: readonly Word[], at: number): Word | undefined =>
  words.find((w) => (w.start ?? 0) <= at && at < (w.end ?? 0));

/**
 * A URL's userinfo is masked from after `://` to the last `@` before the
 * authority ends, so a user and a password with an `@` in it hide whole and
 * the host stays.
 */
function widen(command: string, hit: CredentialHit, words: readonly Word[]): CredentialHit {
  const word = wordAt(words, hit.start);
  const end = word === undefined ? hit.end : contentEnd(command, word);
  {
    const from = hit.start + hit.match.indexOf("://") + 3;
    const stop = Math.max(end, hit.end);
    let authEnd = stop;
    for (let i = from; i < stop; i++) {
      if ("/?#".includes(command[i])) {
        authEnd = i;
        break;
      }
    }
    const at = Math.max(command.lastIndexOf("@", authEnd - 1), hit.end - 1);
    const userinfo = command.slice(from, at);
    const colon = userinfo.indexOf(":");
    const secret = colon < 0 ? userinfo : userinfo.slice(colon + 1);
    return {
      ...hit,
      start: from,
      end: at,
      match: userinfo,
      secret,
      ...(secret === hit.secret ? {} : { aliases: [hit.secret] }),
    };
  }
}

/** The end of a word's text in the command: before its last character when that closes a quote. */
function contentEnd(command: string, w: Word): number {
  const start = w.start ?? 0;
  const end = Math.min(w.end ?? 0, command.length);
  let quote: string | null = null;
  let closed = -1;
  for (let i = start; i < end; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") {
        quote = null;
        closed = i;
      }
    } else if (c === "\\") i++;
    else if (quote === '"') {
      if (c === '"') {
        quote = null;
        closed = i;
      }
    } else if (c === "'" || c === '"') quote = c;
  }
  return closed === end - 1 ? end - 1 : end;
}

// ---- Password values (task 11 item 1) -------------------------------------------

/** A stretch a value is read from: a shell word, or a token of a comment. */
interface Unit {
  start: number;
  end: number;
  comment: boolean;
}

const BLANK = /[ \t\r\n]/;
const META = " \t\r\n;&|()<>";

/**
 * The tokens of the comments of a command: a `#` outside every word, at the
 * start or after a blank or an operator, opens a comment to the end of its line.
 */
function commentsOf(command: string, words: readonly Word[]): Unit[] {
  const out: Unit[] = [];
  const inWord = (i: number) => words.some((w) => (w.start ?? 0) <= i && i < (w.end ?? 0));
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== "#" || (i > 0 && !META.includes(command[i - 1])) || inWord(i)) continue;
    const eol = command.indexOf("\n", i);
    const end = eol < 0 ? command.length : eol;
    for (let at = i + 1; at < end;) {
      while (at < end && BLANK.test(command[at])) at++;
      const start = at;
      while (at < end && !BLANK.test(command[at])) at++;
      if (at > start) out.push({ start, end: at, comment: true });
    }
    i = end;
  }
  return out;
}

type Quote = "'" | '"' | null;

/** The quote a word is in at `at`, read from its start. */
function quoteAt(command: string, start: number, at: number): Quote {
  let q: Quote = null;
  for (let i = start; i < at; i++) {
    const c = command[i];
    if (q === "'") {
      if (c === "'") q = null;
    } else if (c === "\\") i++;
    else if (q === '"') {
      if (c === '"') q = null;
    } else if (c === "'" || c === '"') q = c;
  }
  return q;
}

/** A value read from a word: its text with quotes removed, where it starts and ends, and where the reading stopped. */
interface Value {
  text: string;
  first: number;
  end: number;
  stop: number;
}

/**
 * The value from `from` to `limit` as the shell reads it: quotes removed,
 * blanks before it skipped. In a word an unquoted shell operator stops it
 * (one stands in a word only inside a substitution, where it ends the inner
 * word); a comment token is read to its end.
 */
function valueFrom(command: string, from: number, limit: number, quote: Quote, comment: boolean): Value {
  let q = quote;
  let text = "";
  let first = -1;
  let end = from;
  let stop = limit;
  const take = (i: number) => {
    if (first < 0 && BLANK.test(command[i])) return;
    if (first < 0) first = i;
    text += command[i];
    end = i + 1;
  };
  for (let i = from; i < limit; i++) {
    const c = command[i];
    if (q === "'") {
      if (c === "'") q = null;
      else take(i);
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < limit && '$`"\\\n'.includes(command[i + 1])) take(++i);
      else take(i);
    } else if (c === "\\") {
      if (i + 1 < limit && command[i + 1] !== "\n") take(++i);
      else i++;
    } else if (c === "'" || c === '"') q = c;
    else if (!comment && META.includes(c)) {
      stop = i;
      break;
    } else take(i);
  }
  return { text, first: first < 0 ? from : first, end, stop };
}

/** The inner value of a value that opens with a quote of its own (`"pw"}` of a JSON body), when it closes. */
function innerValue(text: string): string | null {
  const q = text[0];
  if (q !== '"' && q !== "'") return null;
  const close = text.indexOf(q, 1);
  return close > 1 ? text.slice(1, close) : null;
}

/**
 * Every password name with its sign in the words and comment tokens of a
 * command: the hit at the name widens to the whole value, or a new hit holds
 * it. Returns the change to the placeholder count: the whole value decides
 * once, so a placeholder the rule counted for a head that the whole value
 * makes a credential is taken back, and a placeholder the rule never saw is
 * counted.
 */
function assignments(command: string, units: readonly Unit[], hits: CredentialHit[]): number {
  const ruleAt = new Map(matchesOf(PASSWORD_RULE, command).map((m) => [m.index, m]));
  let placeholders = 0;
  let claimed = -1;
  units.forEach((unit, k) => {
    const raw = command.slice(unit.start, unit.end);
    for (const m of raw.matchAll(PASSWORD_NAME)) {
      let start = unit.start + m.index;
      while (command[start] === "-") start++;
      if (start < claimed) continue;
      const sign = unit.start + m.index + m[0].length - 1;
      let v = valueFrom(command, sign + 1, unit.end, quoteAt(command, unit.start, sign), unit.comment);
      let end = unit.comment ? unit.end : v.end;
      if (v.text === "") {
        // The word ends in the sign: the value is the next word.
        let at = v.stop;
        while (at < command.length && (command[at] === " " || command[at] === "\t")) at++;
        const next = units[k + 1];
        if (next !== undefined && next.start === at && at >= unit.end) {
          v = valueFrom(command, at, next.end, null, next.comment);
          end = next.comment ? next.end : v.end;
        } else if (at > v.stop && at < unit.end) {
          v = valueFrom(command, at, unit.end, null, unit.comment);
          end = unit.comment ? unit.end : v.end;
        }
      }
      if (v.text.length < 6) continue;
      claimed = end;
      const inner = innerValue(v.text);
      const spellings = [v.text, ...(inner !== null && inner.length >= 6 ? [inner] : [])];
      const over = hits.filter((h) => h.start < end && start < h.end);
      const own = over.find((h) => h.rule === PASSWORD_RULE.name && h.start < sign + 1);
      if (own !== undefined) {
        own.start = Math.min(own.start, start);
        own.end = Math.max(own.end, end);
        own.match = command.slice(own.start, own.end);
        const before = own.secret;
        own.secret = v.text;
        const aliases = [...(own.aliases ?? []), before, ...spellings].filter(
          (x, i, all) => x !== own.secret && all.indexOf(x) === i,
        );
        if (aliases.length > 0) own.aliases = aliases;
        continue;
      }
      if (over.length > 0) {
        // Another rule found a credential inside the value: its label holds the whole value.
        const h = over[0];
        h.start = Math.min(h.start, v.first);
        h.end = Math.max(h.end, end);
        const aliases = [...(h.aliases ?? []), ...spellings].filter(
          (x, i, all) => x !== h.secret && all.indexOf(x) === i,
        );
        if (aliases.length > 0) h.aliases = aliases;
        continue;
      }
      const decided = passwordValue(v.text);
      const rule = ruleAt.get(start);
      const head = rule === undefined ? null : passwordValue(rule[1] ?? rule[0]);
      if (decided === "credential") {
        if (head === "placeholder") placeholders--;
        hits.push({
          rule: PASSWORD_RULE.name,
          match: command.slice(start, end),
          secret: v.text,
          start,
          end,
          ...(spellings.length > 1 ? { aliases: spellings.slice(1) } : {}),
        });
      } else if (decided === "placeholder" && rule === undefined) placeholders++;
    }
  });
  return placeholders;
}
