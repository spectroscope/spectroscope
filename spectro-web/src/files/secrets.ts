// Card 605: the credential rules of the files report. REDACTION_RULES is a twin
// of the rule table in spectro-core's Redaction.java: same names, same order,
// same pattern strings, a leading (?i) written as the i flag (design B3).
// secrets.drift.test.ts reads the Java source and holds the two equal. The
// report adds two rules of its own, for password assignments and for key
// bodies in shell commands, and a placeholder list (design B4) so that
// documentation keys and template values do not count as found credentials.
//
// Nothing here keeps or prints a value: callers get positions, rule names and
// size bands, and decide what to show.

/** A named credential or personal-data shape. The pattern carries no `g` flag; callers clone it. */
export interface CredentialRule {
  name: string;
  pattern: RegExp;
}

/** The twelve rules of Redaction.java, in the order they fire there. */
export const REDACTION_RULES: readonly CredentialRule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: "openai-key", pattern: /\bsk-(?:(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/ },
  { name: "aws-akid", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16,17}\b/ },
  { name: "github-pat", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{80,})/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "slack-token", pattern: /\b(?:xox[abcdeprs]|xapp)-[A-Za-z0-9-]{10,}/ },
  { name: "bearer", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/ },
  { name: "url-userinfo", pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/ },
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "iban", pattern: /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/ },
];

/** An assignment to a name that says password, secret, token or key; group 1 is the value. */
export const PASSWORD_RULE: CredentialRule = {
  name: "password-assignment",
  pattern:
    /\b[A-Za-z0-9_-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key)(?:[_-]?key)?["']?\s*[:=]\s*["']?([^\s"'`;,)\]}]{6,})/i,
};

const PERSONAL = new Set(["email", "iban"]);

/** The credential rules of the twin (without email and iban), then the password rule. */
export const CREDENTIAL_RULES: readonly CredentialRule[] = [
  ...REDACTION_RULES.filter((r) => !PERSONAL.has(r.name)),
  PASSWORD_RULE,
];

/**
 * A rule of the report, not of the Java twin: a run of 40 or more base64
 * characters (with `=` padding) that holds an upper-case letter, a lower-case
 * letter and a digit is key material, such as a key body a command writes or
 * searches line by line (`echo "<line>" >> k.pem`, `grep -c <line> k.pem`),
 * unless isKeyMaterial says it is a path, a name, a public key, an integrity
 * hash or a data URL. It reads shell commands only (COMMAND_RULES); the mask
 * finds such a run again as a known value.
 */
export const KEY_BODY_RULE: CredentialRule = {
  name: "key-body",
  pattern:
    /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}/,
};

/** Every rule the report names, as a shell command is read: CREDENTIAL_RULES, then key-body. */
export const COMMAND_RULES: readonly CredentialRule[] = [...CREDENTIAL_RULES, KEY_BODY_RULE];

/** What stands before a base64 run that is public: an SSH public key, an integrity hash, a data URL. */
const PUBLIC_BEFORE =
  /(?:ssh-ed25519 |ssh-rsa |ecdsa-sha2-[A-Za-z0-9-]+ |sha(?:256|384|512)-|data:[^\s;,]*;base64,)$/;

/** The class runs of a run (upper case, lower case, digits), counted inside each segment between `/` and `+`. */
function classRuns(run: string): number {
  let runs = 0;
  let prev = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    const k = c >= 65 && c <= 90 ? 1 : c >= 97 && c <= 122 ? 2 : c >= 48 && c <= 57 ? 3 : 0;
    if (k !== 0 && k !== prev) runs++;
    prev = k;
  }
  return runs;
}

/**
 * Whether a key-body match is key material (final wave item 2). Not a run
 * after an SSH public key type, an integrity prefix or a data URL header. Not
 * a path: four or more `/`, no `+` and at most 0.45 class runs per character.
 * Not a name: a run without `+` or `/` whose letters are 75 % or more lower
 * case (`aBusySlotAnswers503WithRetryAfterAndTheBody`). The last test stands
 * in for the brief's "at least 3 digits", which flags names with three digits
 * and misses more key lines (simulation in the final wave report).
 */
export function isKeyMaterial(match: string, before: string): boolean {
  if (PUBLIC_BEFORE.test(before)) return false;
  const run = match.replace(/=+$/, "");
  let slashes = 0;
  let plus = false;
  let lower = 0;
  let upper = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (c === "/") slashes++;
    else if (c === "+") plus = true;
    else if (c >= "a" && c <= "z") lower++;
    else if (c >= "A" && c <= "Z") upper++;
  }
  if (slashes >= 4 && !plus && classRuns(run) / run.length <= 0.45) return false;
  return plus || slashes > 0 || lower / (lower + upper) < 0.75;
}

/** One credential found in a text. `start` and `end` bound `match`; `secret` is the part that is the credential. */
export interface CredentialHit {
  rule: string;
  match: string;
  secret: string;
  start: number;
  end: number;
  /** Other spellings of the same credential that share its label (a command's position value, the rule's own shorter value). */
  aliases?: string[];
}

const ruleNamed = (name: string): CredentialRule => {
  const rule = REDACTION_RULES.find((r) => r.name === name);
  if (rule === undefined) throw new Error(`no rule ${name}`);
  return rule;
};
const EMAIL = ruleNamed("email");
const IBAN = ruleNamed("iban");
const PRIVATE_KEY = ruleNamed("private-key");
/** The rules a block's own scan asks: private-key headers inside it take no room there. */
const NON_KEY_RULES = CREDENTIAL_RULES.filter((r) => r !== PRIVATE_KEY);

// ---- Matching in linear time ----------------------------------------------------
//
// Email, url-userinfo and the password rule open with a run of word-like
// characters before the part every match holds (the @, the ://, the keyword). A
// plain global search walks that run again from every start inside it, which is
// quadratic: 230 ms for email on a 20,000-character hex run (Node 25, probe of
// 2026-11-10). These matchers find that part first and run the pattern once,
// sticky, at the start a global search would take. secrets.test.ts checks that
// both find the same matches.

/** The ASCII characters a character class matches, as a lookup table. */
function charTable(cls: RegExp): Uint8Array {
  const table = new Uint8Array(128);
  for (let c = 0; c < 128; c++) table[c] = cls.test(String.fromCharCode(c)) ? 1 : 0;
  return table;
}
const LOCAL = charTable(/[A-Za-z0-9._%+-]/);
const SCHEME = charTable(/[a-zA-Z0-9+.-]/);
const NAME = charTable(/[A-Za-z0-9_-]/);
const WORD = charTable(/\w/);
const LETTER = charTable(/[a-zA-Z]/);
const inTable = (table: Uint8Array, text: string, i: number): boolean => {
  const c = text.charCodeAt(i);
  return c < 128 && table[c] === 1;
};
/** The first index of the run of `table` characters that ends at `at`, not before `from`. */
function runStart(table: Uint8Array, text: string, at: number, from: number): number {
  let i = at;
  while (i > from && inTable(table, text, i - 1)) i--;
  return i;
}

interface Anchored {
  /** Finds the part every match contains (global). */
  anchor: RegExp;
  /** The start a global search would take for the anchor at `at`, or -1 for none. */
  start: (text: string, at: number, from: number) => number;
}

const ANCHORED: Record<string, Anchored> = {
  email: { anchor: /@/g, start: (text, at, from) => runStart(LOCAL, text, at, from) },
  "url-userinfo": {
    anchor: /:\/\//g,
    start: (text, at, from) => {
      for (let i = runStart(SCHEME, text, at, from); i < at; i++) {
        if (inTable(LETTER, text, i) && (i === 0 || !inTable(WORD, text, i - 1))) return i;
      }
      return -1;
    },
  },
  "password-assignment": {
    anchor:
      /(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key)(?:[_-]?key)?(?![A-Za-z0-9_-])/gi,
    start: (text, at, from) => {
      let i = runStart(NAME, text, at, from);
      while (i < at && text[i] === "-") i++;
      return i;
    },
  },
};

const globalClones = new Map<CredentialRule, RegExp>();
const stickyClones = new Map<CredentialRule, RegExp>();
function clone(cache: Map<CredentialRule, RegExp>, rule: CredentialRule, flag: string): RegExp {
  let re = cache.get(rule);
  if (re === undefined) {
    re = new RegExp(rule.pattern.source, rule.pattern.flags + flag);
    cache.set(rule, re);
  }
  return re;
}

/** Every match a global search with `rule.pattern` finds in `text`, in text order. */
export function ruleMatches(rule: CredentialRule, text: string): RegExpExecArray[] {
  const anchored = ANCHORED[rule.name];
  if (anchored === undefined) return [...text.matchAll(clone(globalClones, rule, "g"))];
  const sticky = clone(stickyClones, rule, "y");
  const out: RegExpExecArray[] = [];
  let from = 0;
  for (const a of text.matchAll(anchored.anchor)) {
    if (a.index < from) continue;
    const start = anchored.start(text, a.index, from);
    if (start < 0) continue;
    sticky.lastIndex = start;
    const m = sticky.exec(text);
    if (m !== null) {
      out.push(m);
      from = m.index + m[0].length;
    }
  }
  return out;
}

// ---- Secrets and placeholders ---------------------------------------------------

/**
 * The part of a match that is the credential (design B2): the token after the word
 * for `bearer`, the password for `url-userinfo`, the value for a password
 * assignment, the whole match for every other rule.
 */
export function secretPart(rule: string, match: string): string {
  if (rule === "bearer") return match.replace(/^bearer\s+/i, "");
  if (rule === "url-userinfo") {
    // The user name holds no colon, so the first colon after the scheme ends it;
    // the password runs from there to the closing @ and may hold colons itself.
    const scheme = match.indexOf("://");
    const colon = scheme < 0 ? -1 : match.indexOf(":", scheme + 3);
    return colon < 0 || !match.endsWith("@") ? match : match.slice(colon + 1, -1);
  }
  if (rule === PASSWORD_RULE.name) return PASSWORD_RULE.pattern.exec(match)?.[1] ?? match;
  return match;
}

const PLACEHOLDER_PARTS = ["example", "placeholder", "dummy", "changeme", "your_", "xxxx"];
const PLACEHOLDER_WORDS = new Set(["password", "secret", "test", "admin", "root"]);

/**
 * Whether a secret is a placeholder (design B4): it ends in EXAMPLE, is one repeated
 * character, is `${NAME}` or `$NAME`, sits in angle brackets, contains example,
 * placeholder, dummy, changeme, your_ or xxxx, or is password, secret, test, admin or
 * root (any case); an aws-akid whose body after the prefix holds no digit is an
 * upper-case word.
 */
const REPEATED = /^(.)\1*$/su;

export function isPlaceholder(rule: string, secret: string): boolean {
  if (secret.endsWith("EXAMPLE")) return true;
  if (REPEATED.test(secret)) return true;
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(secret) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(secret)) return true;
  if (/^<[^<>]*>$/.test(secret)) return true;
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_PARTS.some((part) => lower.includes(part))) return true;
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  return rule === "aws-akid" && !/[0-9]/.test(secret.slice(4));
}

const CODE_WORDS = new Set(["null", "none", "undefined", "true", "false"]);

/** A password-assignment value that is code, not a value: skipped without counting. */
function isCode(value: string): boolean {
  return (
    /[([{]/.test(value) ||
    value.startsWith("%") ||
    value.startsWith("&") ||
    CODE_WORDS.has(value.toLowerCase())
  );
}

/**
 * A password-assignment value made only of letters, `_` and `.` names code (`string`,
 * `isPassword`, `process.env.API_KEY`), not a credential. Asked after isPlaceholder,
 * so `changeme` and `password` still count as placeholders.
 */
const isIdentifier = (value: string): boolean => /^[A-Za-z_.]+$/.test(value);

const KEY_HEADER = "-----BEGIN ";
const DASHES = "-----";
/** How much text before a key-body match isKeyMaterial reads. */
const BEFORE = 64;

// ---- Private-key blocks ----------------------------------------------------------
//
// The twin's pattern matches only the BEGIN header, which would leave the key
// body in plain text. findCredentials extends a header to its block: to the END
// marker of the header's own kind when one follows within the same string, else
// to the end of that string. The extent errs toward hiding: a result is never
// printed, and a command only loses more of its tail. Which lines of a block are
// its PEM body (bodyEnd) matters only for the body lines a report registers.
// A line break is a real one or the escape `\n` (or `\r\n`) a command or a JSON
// string writes for one.

const BASE64 = charTable(/[A-Za-z0-9+/=]/);
const PEM_FIELD = /^[A-Za-z][A-Za-z0-9-]*: /;
const BODY_LINE = /^[A-Za-z0-9+/=]{20,}$/;
/**
 * The line number a listing puts before a line: blanks, a path right before the
 * digits (`path:` of `grep -rn`, `path-` of a `grep -A` context line, and
 * `HEAD:path:` of `git grep`), digits, then blanks and a tab, arrow, colon, bar,
 * box bar (bat), `-` or `.` (`nl -s.`), or blanks alone (`less -N`).
 */
const LINE_NUMBER_SOURCE = String.raw`[ \t]*(?:(?:[^\s:]+:)*[^\s:]+[:-](?=\d))?\d+(?:[ \t]*[\t\u2192:|\u2502.-]|[ \t]+)`;
const LINE_NUMBER = new RegExp(LINE_NUMBER_SOURCE, "y");
const LEADING_LINE_NUMBER = new RegExp(`^${LINE_NUMBER_SOURCE}`);
/** What may follow the base64 start of a body line that ends a block: the end of a quoted or bracketed value. */
const CLOSERS = new Set(["'", '"', "`", ")", "]", "}", ",", ";"]);

/** The length of the line break at `i`, or 0 when none starts there. */
function breakAt(text: string, i: number): number {
  const c = text[i];
  if (c === "\n") return 1;
  if (c === "\r") return text[i + 1] === "\n" ? 2 : 1;
  if (c !== "\\") return 0;
  if (text[i + 1] === "n") return 2;
  return text[i + 1] === "r" && text[i + 2] === "\\" && text[i + 3] === "n" ? 4 : 0;
}

/** The first line break at or after `i`, or `stop`. */
function lineEndFrom(text: string, i: number, stop: number): number {
  let at = i;
  while (at < stop && breakAt(text, at) === 0) at++;
  return at;
}

const skipBlanks = (text: string, i: number, stop: number): number => {
  let at = i;
  while (at < stop && (text[at] === " " || text[at] === "\t")) at++;
  return at;
};

/** After a line number at `at`, or `at` itself when none stands there. */
function afterLineNumber(text: string, at: number, stop: number): number {
  LINE_NUMBER.lastIndex = at;
  const m = LINE_NUMBER.exec(text);
  return m === null || LINE_NUMBER.lastIndex > stop ? at : skipBlanks(text, LINE_NUMBER.lastIndex, stop);
}

/**
 * Where a block's PEM body ends: after the header's whole line, then over empty
 * lines, header fields before the body and base64 lines (a line number before
 * a line aside; a base64 start followed by a quote or a closing bracket ends the
 * body there), never past `stop`.
 */
function bodyEnd(text: string, headerEnd: number, stop: number): number {
  let at = lineEndFrom(text, headerEnd, stop);
  let end = at;
  let fields = true;
  for (;;) {
    const brk = at < stop ? breakAt(text, at) : 0;
    if (brk === 0) return end; // the line went on with something else, or the value ended
    at = afterLineNumber(text, skipBlanks(text, at + brk, stop), stop);
    if (at >= stop) return end;
    if (breakAt(text, at) > 0) continue; // an empty line
    const lineEnd = lineEndFrom(text, at, stop);
    if (fields && PEM_FIELD.test(text.slice(at, lineEnd))) {
      end = lineEnd;
      at = lineEnd;
      continue;
    }
    let run = at;
    while (run < stop && inTable(BASE64, text, run)) run++;
    if (run === at) return end;
    const after = skipBlanks(text, run, stop);
    // A line that goes on after its base64 start: the start ends the body only
    // before a quote or a closing bracket. Before anything else (`AWS_SECRET=`,
    // `Bearer x`) the line is text, and taking its first word would cut a match.
    if (after < stop && breakAt(text, after) === 0) return CLOSERS.has(text[after]) ? run : end;
    fields = false;
    end = run;
    at = after;
  }
}

/** Finds END markers for one text: each marker searched once onward, so many headers stay linear. */
class Markers {
  private readonly next = new Map<string, { from: number; at: number }>();
  constructor(private readonly text: string) {}

  /** The index of `marker` at or after `from`, or -1; `from` must not decrease between calls. */
  find(marker: string, from: number): number {
    const seen = this.next.get(marker);
    if (seen !== undefined && seen.from <= from && (seen.at < 0 || seen.at >= from)) return seen.at;
    const at = this.text.indexOf(marker, from);
    this.next.set(marker, { from, at });
    return at;
  }
}

/** The end of the block a header opens: after its END marker before `stop`, else `stop`. */
function keyBlockEnd(header: string, headerEnd: number, stop: number, markers: Markers): number {
  const marker = `${DASHES}END ${header.slice(KEY_HEADER.length, -DASHES.length)}${DASHES}`;
  const at = markers.find(marker, headerEnd);
  return at >= 0 && at + marker.length <= stop ? at + marker.length : stop;
}

/** Where a block's header ends, inside the block. */
function headerEndIn(block: string): number {
  const close = block.indexOf(DASHES, KEY_HEADER.length);
  return close < 0 ? block.length : close + DASHES.length;
}

/** The text of a block after its header. */
const afterHeader = (block: string): string => block.slice(headerEndIn(block));

/** A block's hits found by `rules` after its header, at the positions of the whole text. */
function insideBlock(hit: CredentialHit, rules: readonly CredentialRule[]): CredentialHit[] {
  if (hit.rule !== "private-key") return [];
  const rest = afterHeader(hit.match);
  const offset = hit.start + hit.match.length - rest.length;
  return findCredentials(rest, [], rules).hits.map((h) => ({
    ...h,
    start: h.start + offset,
    end: h.end + offset,
  }));
}

/**
 * The credentials inside a private-key block other than keys, at any depth: one
 * flat scan after its header in which the key headers inside take no room. The
 * block's own mask covers them in place; each is still a value of its own that
 * can come back elsewhere.
 */
export const keyBlockHits = (hit: CredentialHit): CredentialHit[] => insideBlock(hit, NON_KEY_RULES);

/** The key blocks right inside a private-key block: one level of a nest. */
export const keyBlockKeys = (hit: CredentialHit): CredentialHit[] => insideBlock(hit, [PRIVATE_KEY]);

/** The base64 lines of 20 or more characters in the PEM body after the header that ends at `headerEnd`. */
function bodyLines(block: string, headerEnd: number): string[] {
  return block
    .slice(headerEnd, bodyEnd(block, headerEnd, block.length))
    .split(/\r\n|\r|\n|\\r\\n|\\n/)
    .map((line) => line.replace(LEADING_LINE_NUMBER, "").trim())
    .filter((line) => BODY_LINE.test(line));
}

/**
 * The base64 lines of 20 or more characters in a block's PEM body (bodyEnd), a
 * line number before them taken off: a body line can come back alone. Text the
 * block covers after its body (a hash, a log line) is not a body line.
 */
export function keyBlockLines(hit: CredentialHit): string[] {
  return hit.rule === "private-key" ? bodyLines(hit.match, headerEndIn(hit.match)) : [];
}

/** The body lines of every key header inside a block after its own, at any depth. */
export function innerKeyLines(hit: CredentialHit): string[] {
  if (hit.rule !== "private-key") return [];
  const out: string[] = [];
  for (const m of ruleMatches(PRIVATE_KEY, hit.match)) {
    if (m.index > 0) out.push(...bodyLines(hit.match, m.index + m[0].length));
  }
  return out;
}

/**
 * Every credential in a text, in text order. The rules are asked in the order of
 * CREDENTIAL_RULES, and a match that overlaps an earlier hit or placeholder is
 * skipped, so an earlier rule wins. A placeholder is counted, not returned. A
 * password-assignment value that is code or a plain identifier is skipped without
 * counting. A private-key match is its whole block, to its END marker or to the
 * end of its string (keyBlockEnd), as match and as secret; the placeholder test
 * still reads the header alone. `stops`, ascending, are offsets a block never
 * runs past: the end of each string value of a text built from several.
 * `rules` defaults to CREDENTIAL_RULES; a shell command is read with COMMAND_RULES.
 * A password-assignment value that opens a key header is the header, not a
 * password, and is skipped.
 * `identifiers: false` drops the plain-identifier skip: a shell command reads
 * `-d password=hunterpass` as a password (final wave item 1d).
 */
export function findCredentials(
  text: string,
  stops: readonly number[] = [],
  rules: readonly CredentialRule[] = CREDENTIAL_RULES,
  { identifiers = true }: { identifiers?: boolean } = {},
): { hits: CredentialHit[]; placeholders: number } {
  const hits: CredentialHit[] = [];
  const taken: [number, number][] = [];
  const overlaps = (start: number, end: number) => taken.some(([s, e]) => start < e && s < end);
  const markers = new Markers(text);
  let stop = 0;
  let placeholders = 0;
  for (const rule of rules) {
    const isKey = rule.name === "private-key";
    for (const m of ruleMatches(rule, text)) {
      const start = m.index;
      const headerEnd = start + m[0].length;
      // Asked before the block is measured: a header inside an earlier block costs nothing.
      if (overlaps(start, headerEnd)) continue;
      let end = headerEnd;
      if (isKey) {
        while (stop < stops.length && stops[stop] < headerEnd) stop++;
        end = keyBlockEnd(m[0], headerEnd, stops[stop] ?? text.length, markers);
        if (overlaps(start, end)) continue;
      }
      const match = isKey ? text.slice(start, end) : m[0];
      if (rule === KEY_BODY_RULE && !isKeyMaterial(match, text.slice(Math.max(0, start - BEFORE), start)))
        continue;
      const isPassword = rule === PASSWORD_RULE;
      const secret = isPassword ? (m[1] ?? m[0]) : secretPart(rule.name, match);
      if (isPassword && (isCode(secret) || secret.startsWith(DASHES + "BEGIN"))) continue;
      // Key material skips the placeholder parts: `xxxx` in any case stands in random base64 too.
      const placeholder =
        rule === KEY_BODY_RULE ? REPEATED.test(secret) : isPlaceholder(rule.name, isKey ? m[0] : secret);
      if (isPassword && !placeholder && identifiers && isIdentifier(secret)) continue;
      taken.push([start, end]);
      if (placeholder) placeholders++;
      else hits.push({ rule: rule.name, match, secret, start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return { hits, placeholders };
}

/**
 * How many matches of the email and iban rules a text holds. An email-shaped
 * match whose local part is `git` is a Git remote (`git@github.com:o/r`), not
 * a person (final wave item 6d).
 */
export function countPersonalData(text: string): { email: number; iban: number } {
  const email = ruleMatches(EMAIL, text).filter((m) => !m[0].startsWith("git@")).length;
  return { email, iban: ruleMatches(IBAN, text).length };
}

const utf8 = new TextEncoder();

/** The size band of a value in UTF-8 bytes, the twin of Redaction.bucket: never the exact length. */
export function sizeBand(value: string): string {
  const bytes = utf8.encode(value).length;
  if (bytes <= 8) return "1-8";
  if (bytes <= 16) return "9-16";
  if (bytes <= 32) return "17-32";
  if (bytes <= 64) return "33-64";
  if (bytes <= 128) return "65-128";
  return "129+";
}

/** The text with every credential hit replaced by `[<label>: <rule>]`; placeholders stay. */
export function maskCredentials(text: string, label: (hit: CredentialHit) => string): string {
  let out = "";
  let at = 0;
  for (const hit of findCredentials(text).hits) {
    out += `${text.slice(at, hit.start)}[${label(hit)}: ${hit.rule}]`;
    at = hit.end;
  }
  return out + text.slice(at);
}
