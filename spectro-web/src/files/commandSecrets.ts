// Card 605, final fix wave item 1: the credentials of one shell command, as
// the report registers and masks them. The rules of a tool input find shapes,
// read without the plain-identifier skip (1d). A password assignment then
// masks to the end of the shell word it sits in, and a URL's userinfo from
// `://` to the last `@` of its authority (1a). The values in credential
// positions of network commands come from shellRisk (1b) under the rule name
// `position`; one that overlaps a rule's hit widens that hit instead of
// standing beside it.

import { findCredentials, COMMAND_RULES, PASSWORD_RULE, type CredentialHit } from "./secrets";
import { shellRisk, type ShellRisk } from "./shellRisk";
import { segments, type Word } from "./shellTokens";

/** The rule name of a value found by its place in a command, not by its shape. */
export const POSITION_RULE = "position";

export interface CommandReading {
  risk: ShellRisk;
  hits: CredentialHit[]; // in text order
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
): { hits: CredentialHit[]; placeholders: number } {
  const found = findCredentials(command, [], COMMAND_RULES, { identifiers: false });
  const words = wordsOf(command);
  const hits = found.hits.map((h) => widen(command, h, words));
  for (const v of risk.values) {
    const over = hits.filter((h) => v.start < h.end && h.start < v.end);
    if (over.some((h) => h.start <= v.start && v.end <= h.end)) continue;
    const spellings = [v.secret, v.value].filter((x, k, all) => all.indexOf(x) === k);
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
  return { hits, placeholders: found.placeholders + risk.placeholders };
}

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
 * A password assignment runs to the end of its word, a closing quote left
 * out: `'password=a,b;c'` holds the value `a,b;c`, which the rule alone stops
 * at the comma. A URL's userinfo is masked from after `://` to the last `@`
 * before the authority ends, so a user and a password with an `@` in it hide
 * whole and the host stays.
 */
function widen(command: string, hit: CredentialHit, words: readonly Word[]): CredentialHit {
  const word = wordAt(words, hit.start);
  const end = word === undefined ? hit.end : contentEnd(command, word);
  if (hit.rule === PASSWORD_RULE.name) {
    if (end <= hit.end) return hit;
    const valueStart = hit.end - hit.secret.length;
    return {
      ...hit,
      end,
      match: command.slice(hit.start, end),
      secret: command.slice(valueStart, end),
      aliases: [hit.secret],
    };
  }
  if (hit.rule === "url-userinfo") {
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
  return hit;
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
