// Card 605: the credential rules of the files report. REDACTION_RULES is a twin
// of the rule table in spectro-core's Redaction.java: same names, same order,
// same pattern strings, a leading (?i) written as the i flag (design B3).
// secrets.drift.test.ts reads the Java source and holds the two equal. The
// report adds one rule of its own for password assignments, and a placeholder
// list (design B4) so that documentation keys and template values do not count
// as found credentials.
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

/** One credential found in a text. `start` and `end` bound `match`; `secret` is the part that is the credential. */
export interface CredentialHit {
  rule: string;
  match: string;
  secret: string;
  start: number;
  end: number;
}

const ruleNamed = (name: string): CredentialRule => {
  const rule = REDACTION_RULES.find((r) => r.name === name);
  if (rule === undefined) throw new Error(`no rule ${name}`);
  return rule;
};
const EMAIL = ruleNamed("email");
const IBAN = ruleNamed("iban");

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
export function isPlaceholder(rule: string, secret: string): boolean {
  if (secret.endsWith("EXAMPLE")) return true;
  if (/^(.)\1*$/su.test(secret)) return true;
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
 * Every credential in a text, in text order. The rules are asked in the order of
 * CREDENTIAL_RULES, and a match that overlaps an earlier hit or placeholder is
 * skipped, so an earlier rule wins. A placeholder is counted, not returned.
 */
export function findCredentials(text: string): { hits: CredentialHit[]; placeholders: number } {
  const hits: CredentialHit[] = [];
  const taken: [number, number][] = [];
  let placeholders = 0;
  for (const rule of CREDENTIAL_RULES) {
    for (const m of ruleMatches(rule, text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && s < end)) continue;
      const isPassword = rule === PASSWORD_RULE;
      const secret = isPassword ? (m[1] ?? m[0]) : secretPart(rule.name, m[0]);
      if (isPassword && isCode(secret)) continue;
      taken.push([start, end]);
      if (isPlaceholder(rule.name, secret)) placeholders++;
      else hits.push({ rule: rule.name, match: m[0], secret, start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return { hits, placeholders };
}

/** How many matches of the email and iban rules a text holds. */
export function countPersonalData(text: string): { email: number; iban: number } {
  return { email: ruleMatches(EMAIL, text).length, iban: ruleMatches(IBAN, text).length };
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
