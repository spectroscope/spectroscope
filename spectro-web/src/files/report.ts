// Card 605: the files report model (design sections 1 to 4). One pure function
// joins the files tab's ledger, the credential rules (secrets.ts), the path
// levels (levels.ts), the shell risks (shellRisk.ts) and the destinations
// (destinations.ts) into the FilesReport the renderers read. It always covers
// the whole session (R6).
//
// A credential value never leaves buildReport: the report keeps a label that
// counts up in order of first sight, the rule and the size band (R3). Every
// command, path, host and file label in the report passes the same mask.

import { describeTool } from "../components/toolViews";
import { TITLE_AGENT_ID, type RunEvent } from "../events";
import { shortenPath } from "../lab/fileTree";
import { elapsedAt } from "../state/stepper";
import {
  destinations as destinationsOf,
  reachedBy,
  reachIndex,
  type Destination,
  type ReachIndex,
} from "./destinations";
import { CommandReadings, type CommandReading } from "./commandSecrets";
import type { FileCall, FileLedger, Source } from "./fold";
import { higher, LEVEL_ORDER, outsideWorkspace, pathLevel, type Level } from "./levels";
import {
  countPersonalData,
  findCredentials,
  INPUT_RULES,
  innerKeyLines,
  keyBlockHits,
  keyBlockKeys,
  keyBlockLines,
  sizeBand,
  type CredentialHit,
} from "./secrets";
import { scriptRunner, type TouchKind } from "./shell";

export type FindingKind =
  | "secret-file"
  | "credential-result"
  | "credential-input"
  | "credential-prompt"
  | "credential-used"
  | "env-dump"
  | "network"
  | "outside"
  | "personal-data"
  | "unknown-script";

/** A credential as the report names it: never its value, its length or a hash of it. */
export interface CredentialRef {
  label: string; // "credential 1", "credential 2", in order of first sight
  rule: string; // the rule of the first sight
  band: string; // sizeBand of the secret part
}

export interface Finding {
  level: Level;
  kind: FindingKind;
  callIndex: number | null; // the tool_call's event index; null for a prompt
  eventIndex: number; // where the finding was seen: the call, its result, the prompt
  agentId: string | null; // null for a prompt the person typed
  t: number | null; // seconds from the first event
  source: Source;
  tool: string | null;
  file: string | null; // shortened and masked
  what: What[]; // secret-file and outside: what happened to the file, in WHAT_ORDER; else []
  command: string | null; // printableCommand output, masked and cut; shell calls only
  commandCut: number; // characters of the command not printed; 0 when none were cut
  credentials: CredentialRef[];
  host: string | null; // network: as the command wrote it, masked
  sends: string[]; // network: shortened and masked
  sendsNamed: boolean; // network: false when it also sends files the line does not name
  firstSeenCall: number | null; // credential-used: the call where the value was first seen
  reached: string[]; // destination keys the content went to
  count: number; // personal-data: matches; env-dump: output lines; else 1
}

export type What = "read" | "changed" | "created" | "deleted" | "sent";

export interface ReportFile {
  path: string; // resolved, masked
  label: string; // shortenPath(path, workspace), masked
  level: Level;
  what: What[]; // in WHAT_ORDER
  sources: Source[];
  firstT: number | null;
  firstCall: number;
  calls: number; // distinct calls that touched or sent it
}

type Counted = "read" | "changed" | "created" | "deleted";

export interface FilesReport {
  sessionId: string;
  title: string | null; // masked
  version: string | null;
  exportedAt: number;
  workspace: string | null; // masked
  firstTs: number | null; // the first readable event time
  lastTs: number | null; // the last readable event time
  events: number;
  agents: string[]; // in order of first appearance, without the title agent
  timed: boolean;
  /** The highest level over findings and files. A `model` entry does not count (R6). */
  verdict: Level;
  destinations: Destination[];
  findings: Finding[]; // by level, then time
  files: ReportFile[]; // by level, then first call
  /** Files per level under their most specific kind; a file only a model named is not counted. */
  counts: Record<Level, Record<Counted, number>>;
  placeholders: number;
  personal: { email: number; iban: number };
}

export interface ReportInput {
  events: readonly RunEvent[];
  ledger: FileLedger;
  sessionId: string;
  title: string | null;
  version: string | null;
  now: number;
}

const WHAT_ORDER: readonly What[] = ["read", "changed", "created", "deleted", "sent"];
const SOURCE_ORDER: readonly Source[] = ["recorded", "probable", "model"];
const WHAT_OF: Record<TouchKind, What | null> = {
  read: "read",
  create: "created",
  change: "changed",
  overwrite: "changed",
  write: "changed",
  append: "changed",
  delete: "deleted",
  unknown: null,
};
const MAX_COMMAND = 300;

/**
 * A command as the report prints it: masked first, then cut at the first `<<`
 * (a heredoc body is file content, B6) and at 300 characters. The renderers
 * say how much was cut (Finding.commandCut), in the report's language.
 */
export function printableCommand(line: string, mask: (text: string) => string): string {
  return printable(line, mask).text;
}

/** printableCommand with the count of the characters it did not print. */
function printable(line: string, mask: (text: string) => string): { text: string; cut: number } {
  const masked = mask(line);
  const heredoc = masked.indexOf("<<");
  let text = heredoc < 0 ? masked : masked.slice(0, heredoc).trimEnd();
  const chars = Array.from(text);
  if (chars.length > MAX_COMMAND) text = chars.slice(0, MAX_COMMAND).join("");
  return { text, cut: Array.from(masked).length - Array.from(text).length };
}

/** The files tab's one-line form of a command: each line break becomes a visible return mark. */
const oneLine = (command: string) => command.trim().replace(/\r\n|\r|\n/g, " ⏎ ");

export function buildReport(input: ReportInput): FilesReport {
  const { events, ledger } = input;
  const workspace = ledger.workspace;
  const all = destinationsOf(events);
  const reach = reachIndex(events);
  const creds = new Credentials();
  const mask = (text: string) => creds.mask(text);
  const label = (path: string) => mask(shortenPath(path, workspace));
  const callAt = new Map<number, FileCall>(ledger.calls.map((c) => [c.callIndex, c]));
  const commands = new Map<number, string>();
  const readings = new CommandReadings();
  // A command prints through its own reading: the rules, its words and its positions.
  const maskCommand = (call: FileCall) => (text: string) =>
    creds.maskWith(text, readings.of(text, call.base).hits);

  const scan = scanEvents(events, ledger, creds, all, reach, callAt, readings);
  const drafts = scan.drafts;
  const reachedFrom = (call: FileCall) =>
    reachedBy(reach, call.agentId, scan.resultAt.get(call.callIndex) ?? call.callIndex, all);

  // Files and the findings about them, in call order.
  const rows = new Map<string, Mark[]>();
  const addMark = (path: string, mark: Mark) => {
    const marks = rows.get(path);
    if (marks === undefined) rows.set(path, [mark]);
    else marks.push(mark);
  };
  for (const call of ledger.calls) {
    for (const touch of call.touches) {
      addMark(touch.path, { call, kind: touch.kind, sources: touch.sources });
      if (pathLevel(touch.path, workspace) !== "critical") continue;
      drafts.push(
        draft("secret-file", "critical", call, call.callIndex, sourceOf(touch.sources), {
          path: touch.path,
          what: whatList([touch.kind]),
          reached: touch.kind === "read" ? reachedFrom(call) : [],
        }),
      );
    }
    if (!call.shell) continue;
    const command = commandOf(call, events);
    if (command !== null) {
      commands.set(call.callIndex, command);
      const risk = readings.of(command, call.base).risk;
      if (risk.envDump !== null) {
        const printed = scan.secretOutputs.get(call.callIndex);
        drafts.push(
          draft("env-dump", "critical", call, call.callIndex, "probable", {
            reached: reachedFrom(call),
            count: call.output === null ? 0 : lineCount(call.output),
            credentials: printed === undefined ? [] : [printed],
          }),
        );
      }
      for (const use of risk.network) {
        let level: Level = "sensitive";
        for (const sent of use.sends) {
          addMark(sent, { call, kind: "sent", sources: ["probable"] });
          level = higher(level, pathLevel(sent, workspace));
        }
        drafts.push(
          draft("network", level, call, call.callIndex, "probable", {
            host: use.host === null ? null : mask(use.host),
            sends: use.sends.map(label),
            sendsNamed: use.sendsNamed,
          }),
        );
      }
    }
    // The files tab's own rule: a failed call ran no script worth naming.
    // It prints what ran the script, never the arguments (final wave item 1c).
    if (call.status !== "failed" && (call.script !== null || call.inline)) {
      const runner = command === null ? null : scriptRunner(command, call.base);
      drafts.push(
        draft("unknown-script", "unknown", call, call.callIndex, "probable", {
          path: call.script,
          printed: runner,
        }),
      );
    }
  }

  // One finding per path outside the workspace; a secret path has its own. It is
  // placed at the path's first mark a recorded or probable source stands behind,
  // and only a read reached a model, from the first read on.
  for (const [path, marks] of rows) {
    if (!outsideWorkspace(path, workspace) || pathLevel(path, workspace) === "critical") continue;
    const real = marks.filter((m) => counts(m.sources));
    const seen = real.length > 0 ? real : marks;
    const read = seen.find((m) => m.kind === "read");
    drafts.push(
      draft("outside", "sensitive", seen[0].call, seen[0].call.callIndex, sourceOf(seen[0].sources), {
        path,
        what: whatList(seen.map((m) => m.kind)),
        reached: read === undefined ? [] : reachedFrom(read.call),
      }),
    );
  }

  const findings = drafts.map((d) => finish(d, callAt, commands, label, maskCommand));
  findings.sort(
    (a, b) => rank(a.level) - rank(b.level) || timeOrder(a.t, b.t) || a.eventIndex - b.eventIndex,
  );

  const files: ReportFile[] = [];
  const tally = emptyCounts();
  let verdict: Level = "project";
  for (const [path, marks] of rows) {
    const level = pathLevel(path, workspace);
    const what = whatList(marks.map((m) => m.kind));
    const sources = SOURCE_ORDER.filter((s) => marks.some((m) => m.sources.includes(s)));
    files.push({
      path: mask(path),
      label: label(path),
      level,
      what,
      sources,
      firstT: marks[0].call.t,
      firstCall: marks[0].call.callIndex,
      calls: new Set(marks.map((m) => m.call.callIndex)).size,
    });
    if (!counts(sources)) continue;
    verdict = higher(verdict, level);
    tally[level][countedAs(what)]++;
  }
  files.sort((a, b) => rank(a.level) - rank(b.level) || a.firstCall - b.firstCall);
  for (const f of findings) if (f.source !== "model") verdict = higher(verdict, f.level);

  return {
    sessionId: input.sessionId,
    title: input.title === null ? null : creds.maskTitle(input.title),
    version: input.version,
    exportedAt: input.now,
    workspace: workspace === null ? null : mask(workspace),
    ...span(events),
    events: events.length,
    agents: agentsOf(events),
    timed: ledger.timed || findings.some((f) => f.t !== null),
    verdict,
    destinations: all,
    findings,
    files,
    counts: tally,
    placeholders: scan.placeholders,
    personal: scan.personal,
  };
}

// ---- Credentials ----------------------------------------------------------------

/** The first sight of one distinct secret. Lives only inside buildReport. */
interface Sighting {
  secret: string;
  ref: CredentialRef;
  event: number; // event index of the first sight; -1 when only a mask saw it
  call: number | null; // the call of the first sight; null for a prompt
  deep?: boolean; // a body line of a key inside the block it is registered under
}

const WORD = /[A-Za-z0-9_]/;
const isWordAt = (text: string, at: number) => at >= 0 && at < text.length && WORD.test(text[at]);
/**
 * A value shorter than this is masked only where it stands as a word, so the
 * text around a mask cannot spell it ("u[credential 1]rade"). Six is the
 * password rule's own shortest value.
 */
const MASK_INSIDE_WORDS = 6;
/** The shortest start of a value that a cut title is masked for. */
const MIN_CUT = 8;
/** How many levels of key blocks inside a key block withInner reads: a nest of any depth costs four scans. */
const MAX_NESTING = 4;
/** A label the mask wrote; the title rule passes over it. */
const MASK_LABEL = /\[credential \d+: [a-z-]+\]/y;
/** What ends a title word: a blank, quote, bracket, parenthesis, comma, `:`, `=`, `/` or `@`. */
const WORD_END = /[\s"'`()[\]{}<>,:=/@]/;

/** The start of every occurrence of `value` in `text`; with `asWord`, only those with no word character beside them. */
function occurrences(text: string, value: string, asWord: boolean): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    if (!asWord || standsAlone(text, at, value.length)) out.push(at);
  }
  return out;
}

const standsAlone = (text: string, at: number, length: number) =>
  !isWordAt(text, at - 1) && !isWordAt(text, at + length);

/** B2: a known value is used again where it stands as a word in a later input. */
function appearsAsWord(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    if (standsAlone(text, at, value.length)) return true;
  }
  return false;
}

/** The label registry: one label per distinct secret part, in order of first sight (B2). */
class Credentials {
  private readonly bySecret = new Map<string, Sighting>();
  private labels = 0;
  private longest: Sighting[] | null = null;

  get(secret: string): Sighting | undefined {
    return this.bySecret.get(secret);
  }

  /**
   * The sighting of a hit's secret, registered at `event` when new. A key block
   * also registers, on its first sight, each base64 body line under its own
   * label, because a body line can come back without its header, and the body
   * lines of every key inside it that no label holds yet: a key below the
   * nesting cap has no label of its own. A key inside, when it gets its own
   * label, takes its own body lines over. The credentials inside a block come
   * as hits of their own (withInner).
   */
  see(hit: CredentialHit, event: number, call: number | null): Sighting {
    const known = this.bySecret.get(hit.secret);
    if (known !== undefined) return known;
    const ref = { label: `credential ${++this.labels}`, rule: hit.rule, band: sizeBand(hit.secret) };
    const s: Sighting = { secret: hit.secret, ref, event, call };
    this.bySecret.set(hit.secret, s);
    this.longest = null;
    for (const alias of hit.aliases ?? []) {
      if (alias !== "" && !this.bySecret.has(alias))
        this.bySecret.set(alias, { secret: alias, ref, event, call });
    }
    for (const line of keyBlockLines(hit)) {
      const prev = this.bySecret.get(line);
      if (prev === undefined || prev.deep === true)
        this.bySecret.set(line, { secret: line, ref, event, call });
    }
    for (const line of innerKeyLines(hit)) {
      if (!this.bySecret.has(line)) this.bySecret.set(line, { secret: line, ref, event, call, deep: true });
    }
    return s;
  }

  /**
   * The title masked, and a value cut short in it: the title is cut upstream,
   * and a person can paste part of a value. From every word start (after a
   * WORD_END character), the longest start of a known value with eight or more
   * characters takes that value's label. A mark inside the value does not split
   * it, and what follows the cut (an ellipsis, a quote) stays.
   */
  maskTitle(text: string): string {
    const masked = this.mask(text);
    let out = "";
    let copied = 0;
    for (let at = 0; at < masked.length;) {
      MASK_LABEL.lastIndex = at;
      if (MASK_LABEL.test(masked)) {
        at = MASK_LABEL.lastIndex;
        continue;
      }
      const cut = at === 0 || WORD_END.test(masked[at - 1]) ? this.longestStart(masked, at) : null;
      if (cut === null) {
        at++;
        continue;
      }
      out += `${masked.slice(copied, at)}[${cut.ref.label}: ${cut.ref.rule}]`;
      at += cut.length;
      copied = at;
    }
    return this.maskTail(out + masked.slice(copied));
  }

  /** The known value that shares the longest start with `text` at `at`, when that start has MIN_CUT characters or more. */
  private longestStart(text: string, at: number): { length: number; ref: CredentialRef } | null {
    const first = text.charCodeAt(at);
    let best: { length: number; ref: CredentialRef } | null = null;
    for (const s of this.bySecret.values()) {
      if (s.secret.charCodeAt(0) !== first) continue;
      const max = Math.min(s.secret.length, text.length - at);
      let n = 1;
      while (n < max && s.secret.charCodeAt(n) === text.charCodeAt(at + n)) n++;
      if (n >= MIN_CUT && (best === null || n > best.length)) best = { length: n, ref: s.ref };
    }
    return best;
  }

  /**
   * The title with its tail masked when the tail is the start of a known value:
   * the cut lands at the end of the title, after `https://`, `with:` or `-p'` as
   * well as after a space. The longest such tail of eight or more characters wins.
   */
  private maskTail(text: string): string {
    const [, body = text, ellipsis = ""] = /^([\s\S]*?)(\u2026|\.\.\.)?$/.exec(text) ?? [];
    let best: { length: number; ref: CredentialRef } | null = null;
    for (const s of this.bySecret.values()) {
      const first = s.secret.charCodeAt(0);
      for (let at = Math.max(0, body.length - s.secret.length); at <= body.length - MIN_CUT; at++) {
        if (best !== null && body.length - at <= best.length) break;
        if (body.charCodeAt(at) === first && s.secret.startsWith(body.slice(at))) {
          best = { length: body.length - at, ref: s.ref };
          break;
        }
      }
    }
    if (best === null) return text;
    return `${body.slice(0, body.length - best.length)}[${best.ref.label}: ${best.ref.rule}]${ellipsis}`;
  }

  /** The secrets seen before `event`, in label order. */
  before(event: number): Sighting[] {
    return [...this.bySecret.values()].filter((s) => s.event >= 0 && s.event < event);
  }

  /**
   * The text with every credential replaced by `[label: rule]`: each rule hit as
   * a whole match, and each known secret where it stands (inside longer words too
   * when it has six or more characters).
   */
  mask(text: string): string {
    return text === "" ? text : this.maskWith(text, findCredentials(text).hits);
  }

  /** mask() with the hits a reader found in `text` (a command's reading) in place of the rules alone. */
  maskWith(text: string, hits: readonly CredentialHit[]): string {
    if (text === "") return text;
    const spans: { start: number; end: number; ref: CredentialRef }[] = [];
    for (const hit of hits.flatMap(withInner)) {
      spans.push({ start: hit.start, end: hit.end, ref: this.see(hit, -1, null).ref });
    }
    this.longest ??= [...this.bySecret.values()].sort((a, b) => b.secret.length - a.secret.length);
    for (const s of this.longest) {
      for (const at of occurrences(text, s.secret, s.secret.length < MASK_INSIDE_WORDS)) {
        spans.push({ start: at, end: at + s.secret.length, ref: s.ref });
      }
    }
    if (spans.length === 0) return text;
    // Overlapping spans join into their union, which prints the label of each
    // credential it holds: skipping one would print the part that sticks out.
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let at = 0;
    for (let i = 0; i < spans.length;) {
      const start = spans[i].start;
      let end = spans[i].end;
      const refs: CredentialRef[] = [];
      for (; i < spans.length && spans[i].start < end; i++) {
        end = Math.max(end, spans[i].end);
        if (!refs.includes(spans[i].ref)) refs.push(spans[i].ref);
      }
      out += text.slice(at, start) + refs.map((r) => `[${r.label}: ${r.rule}]`).join("");
      at = end;
    }
    return out + text.slice(at);
  }
}

/**
 * The input as text with its keys, but strings written as they are: the JSON
 * form would write a line break as `\n`, which joins the next word to the `n`
 * and hides a key behind `\b`, and a quote as `\"`, which ends a password value
 * before it starts. A space follows every `:` and `,` of the structure, so a
 * rule that stops at whitespace cannot run from one field into the next, while
 * `"password": "value"` still reads as an assignment. `ends` holds where each
 * string value ends: a key block found in one value never runs into the next,
 * so the scan reads a block in a command as the mask of that command does.
 */
function inputText(input: unknown): { text: string; ends: number[] } {
  let text = "";
  const ends: number[] = [];
  const write = (v: unknown): void => {
    if (typeof v === "string") {
      text += `"${v}`;
      ends.push(text.length);
      text += `"`;
    } else if (Array.isArray(v)) {
      text += "[";
      v.forEach((item, i) => {
        if (i > 0) text += ", ";
        write(item);
      });
      text += "]";
    } else if (typeof v === "object" && v !== null) {
      text += "{";
      Object.entries(v as Record<string, unknown>).forEach(([k, item], i) => {
        text += `${i > 0 ? ", " : ""}"${k}": `;
        write(item);
      });
      text += "}";
    } else {
      text += JSON.stringify(v) ?? "";
    }
  };
  write(input);
  return { text, ends };
}

// ---- The scan of the event list --------------------------------------------------

/** A finding before its file label and command are filled in. */
interface Draft extends Omit<Finding, "file" | "command" | "commandCut"> {
  path: string | null; // the path the finding is about; the call's own file otherwise
  printed?: string | null; // printed in place of the call's command (a script's runner)
}

interface Scan {
  drafts: Draft[];
  resultAt: Map<number, number>; // call index to its result's event index
  placeholders: number;
  personal: { email: number; iban: number };
  /** The stored secret a getter printed (gh auth token, op read, ...), by call index. */
  secretOutputs: Map<number, CredentialRef>;
}

/** The command of a tool call as describeTool reads it, or null for a call that is not a shell command. */
function commandIn(name: string, input: unknown): string | null {
  const view = describeTool(name, input, undefined, false);
  return view.kind === "command" ? view.command : null;
}

/** The input without its command: the command is read on its own (commandSecrets.ts). */
function withoutCommand(input: unknown): unknown {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>), command: "" }
    : input;
}

/** The rule name of the one value a secret getter printed (final wave item 1e). */
const STORED_SECRET = "stored-secret";

/** A getter's output that is one value: one line of eight or more characters without blanks. */
function oneValue(output: string): string | null {
  const value = output.trim();
  return value.length >= 8 && !/\s/.test(value) ? value : null;
}

/**
 * One pass in event order over tool_call inputs (read with INPUT_RULES, which
 * add key-body), tool_result outputs, the ledger's prompts and every
 * steering_message (B8): the credential findings,
 * the placeholder count, the personal-data counts and the result of each call.
 */
function scanEvents(
  events: readonly RunEvent[],
  ledger: FileLedger,
  creds: Credentials,
  all: readonly Destination[],
  reach: ReachIndex,
  callAt: ReadonlyMap<number, FileCall>,
  readings: CommandReadings,
): Scan {
  const drafts: Draft[] = [];
  const resultAt = new Map<number, number>();
  const secretOutputs = new Map<number, CredentialRef>();
  const prompts = new Map(ledger.prompts.map((p) => [p.eventIndex, p]));
  const unpaired = new Map<string, { index: number; name: string; shell: CommandReading | null }[]>();
  const everywhere = all.map((d) => d.key);
  let placeholders = 0;
  const personal = { email: 0, iban: 0 };
  let firstPersonal: number | null = null;

  /** The distinct secrets of a text, labelled, in text order. */
  const refsOf = (text: string, event: number, call: number | null): CredentialRef[] => {
    const found = findCredentials(text);
    placeholders += found.placeholders;
    const refs: CredentialRef[] = [];
    for (const hit of found.hits.flatMap(withInner)) {
      const ref = creds.see(hit, event, call).ref;
      if (!refs.includes(ref)) refs.push(ref);
    }
    return refs;
  };

  const person = (text: string, event: number, agentId: string | null, delivered: boolean) => {
    const credentials = refsOf(text, event, null);
    if (credentials.length === 0) return;
    drafts.push({
      ...blank("credential-prompt", "critical", event, "recorded"),
      agentId,
      t: seconds(events, event),
      credentials,
      reached: delivered ? everywhere : [],
    });
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as unknown as Record<string, unknown>;
    const prompt = prompts.get(i);
    if (prompt !== undefined) person(prompt.text, i, null, true);
    switch (e.type) {
      case "tool_call": {
        const name = String(e.name);
        const command = commandIn(name, e.input);
        const shell = command === null ? null : readings.of(command, callAt.get(i)?.base ?? null);
        const key = pairKey(e.agentId, e.callId);
        const stack = unpaired.get(key);
        if (stack === undefined) unpaired.set(key, [{ index: i, name, shell }]);
        else stack.push({ index: i, name, shell });

        // A command is read on its own (commandSecrets.ts); the other fields as written.
        const { text, ends } = inputText(e.input);
        const rest = shell === null ? { text, ends } : inputText(withoutCommand(e.input));
        const found = findCredentials(rest.text, rest.ends, INPUT_RULES);
        placeholders += found.placeholders + (shell?.placeholders ?? 0);
        const hits = [...found.hits, ...(shell?.hits ?? [])].flatMap(withInner);
        const inHits = new Set(hits.map((h) => h.secret));
        const base = { agentId: String(e.agentId), t: seconds(events, i), tool: name, callIndex: i };
        // One finding per credential and call: a key's body lines share its label.
        const used: CredentialRef[] = [];
        for (const s of creds.before(i)) {
          if (used.includes(s.ref)) continue;
          if (!inHits.has(s.secret) && !appearsAsWord(text, s.secret)) continue;
          used.push(s.ref);
          drafts.push({
            ...blank("credential-used", "critical", i, "recorded"),
            ...base,
            credentials: [s.ref],
            firstSeenCall: s.call,
          });
        }
        const fresh: CredentialRef[] = [];
        for (const hit of hits) {
          const known = creds.get(hit.secret);
          if (known !== undefined && known.event !== i) continue;
          const ref = creds.see(hit, i, i).ref;
          if (!fresh.includes(ref)) fresh.push(ref);
        }
        if (fresh.length > 0) {
          drafts.push({
            ...blank("credential-input", "critical", i, "recorded"),
            ...base,
            credentials: fresh,
          });
        }
        break;
      }
      case "tool_result": {
        const call = unpaired.get(pairKey(e.agentId, e.callId))?.pop() ?? null;
        if (call !== null) resultAt.set(call.index, i);
        if (typeof e.output !== "string") break;
        const agentId = String(e.agentId);
        const printed = call?.shell?.risk.secretOutput === true ? oneValue(e.output) : null;
        if (call !== null && printed !== null && e.isError !== true) {
          const hit = { rule: STORED_SECRET, match: printed, secret: printed, start: 0, end: 0 };
          secretOutputs.set(call.index, creds.see(hit, i, call.index).ref);
        }
        const credentials = refsOf(e.output, i, call?.index ?? null);
        if (credentials.length > 0) {
          // The result's content reached the agent's model after the result.
          drafts.push({
            ...blank("credential-result", "critical", i, "recorded"),
            callIndex: call?.index ?? null,
            agentId,
            t: seconds(events, i),
            tool: call?.name ?? null,
            credentials,
            reached: reachedBy(reach, agentId, i, all),
          });
        }
        const people = countPersonalData(e.output);
        personal.email += people.email;
        personal.iban += people.iban;
        if (firstPersonal === null && people.email + people.iban > 0) firstPersonal = i;
        break;
      }
      case "steering_message":
        // `taken: false`: the turn cap refused it, so it was recorded and never delivered.
        if (typeof e.text === "string") {
          person(e.text, i, typeof e.agentId === "string" ? e.agentId : null, e.taken !== false);
        }
        break;
    }
  }

  // One finding for the session, placed at the first result that holds a match.
  if (firstPersonal !== null) {
    drafts.push({
      ...blank("personal-data", "sensitive", firstPersonal, "recorded"),
      t: seconds(events, firstPersonal),
      count: personal.email + personal.iban,
    });
  }
  return { drafts, resultAt, placeholders, personal, secretOutputs };
}

// ---- Small builders and readers ---------------------------------------------------

/**
 * A hit and, for a key block, the credentials inside it: every one that is not
 * a key from one flat scan of the block, at any depth, and the key blocks
 * inside it down to MAX_NESTING levels. The block's mask covers them in place;
 * each is still registered under a label of its own and masked wherever it
 * comes back. In text order, the order of first sight.
 */
function withInner(hit: CredentialHit): CredentialHit[] {
  if (hit.rule !== "private-key") return [hit];
  const out = [hit, ...keyBlockHits(hit)];
  let level = [hit];
  for (let depth = 0; depth < MAX_NESTING && level.length > 0; depth++) {
    level = level.flatMap(keyBlockKeys);
    out.push(...level);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** What one path saw in one call: a touch of the fold, or a file a network command sent. */
interface Mark {
  call: FileCall;
  kind: TouchKind | "sent";
  sources: Source[];
}

function blank(kind: FindingKind, level: Level, eventIndex: number, source: Source): Draft {
  return {
    level,
    kind,
    callIndex: null,
    eventIndex,
    agentId: null,
    t: null,
    source,
    tool: null,
    path: null,
    what: [],
    credentials: [],
    host: null,
    sends: [],
    sendsNamed: true,
    firstSeenCall: null,
    reached: [],
    count: 1,
  };
}

/** A finding about one ledger call. */
function draft(
  kind: FindingKind,
  level: Level,
  call: FileCall,
  eventIndex: number,
  source: Source,
  extra: Partial<Draft>,
): Draft {
  return {
    ...blank(kind, level, eventIndex, source),
    callIndex: call.callIndex,
    agentId: call.agentId,
    t: call.t,
    tool: call.tool,
    ...extra,
  };
}

/**
 * The draft with its file label and command: a shell call prints its command, a
 * file tool its path. The command is masked as the tool_call wrote it and put on
 * one line after, so a value that spans lines (a key block) is masked as the
 * scan saw it and keeps its label.
 */
function finish(
  d: Draft,
  callAt: ReadonlyMap<number, FileCall>,
  commands: ReadonlyMap<number, string>,
  label: (path: string) => string,
  maskCommand: (call: FileCall) => (text: string) => string,
): Finding {
  const { path, printed: runner, ...rest } = d;
  const call = d.callIndex === null ? undefined : callAt.get(d.callIndex);
  const own = call !== undefined && !call.shell && call.touches.length > 0 ? call.touches[0].path : null;
  const file = path ?? own;
  const raw =
    runner !== undefined ? runner : call?.shell ? (commands.get(call.callIndex) ?? call.line) : null;
  const mask = call === undefined ? null : maskCommand(call);
  const printed = raw === null || mask === null ? null : printable(raw, (text) => oneLine(mask(text)));
  return {
    ...rest,
    file: file === null ? null : label(file),
    command: printed?.text ?? null,
    commandCut: printed?.cut ?? 0,
  };
}

/** The command of a ledger shell call as the tool_call wrote it, line breaks included. */
function commandOf(call: FileCall, events: readonly RunEvent[]): string | null {
  const e = events[call.callIndex] as unknown as Record<string, unknown> | undefined;
  const view = describeTool(call.tool, e?.input, undefined, false);
  return view.kind === "command" ? view.command : null;
}

/** True when a recorded or probable source stands behind it: a model's reading alone does not count (R6). */
const counts = (sources: readonly Source[]) => sources.some((s) => s !== "model");

const sourceOf = (sources: readonly Source[]): Source => sources[0] ?? "probable";

const whatOf = (kind: TouchKind | "sent"): What | null => (kind === "sent" ? "sent" : WHAT_OF[kind]);

/** What a list of touch kinds says happened, in WHAT_ORDER; an unknown touch says nothing. */
const whatList = (kinds: readonly (TouchKind | "sent")[]): What[] =>
  WHAT_ORDER.filter((w) => kinds.some((k) => whatOf(k) === w));

/** The most specific kind a file is counted under: created, deleted, changed, else read. */
function countedAs(what: readonly What[]): Counted {
  for (const kind of ["created", "deleted", "changed"] as const) if (what.includes(kind)) return kind;
  return "read";
}

function emptyCounts(): Record<Level, Record<Counted, number>> {
  const zero = () => ({ read: 0, changed: 0, created: 0, deleted: 0 });
  return { critical: zero(), sensitive: zero(), unknown: zero(), project: zero() };
}

const rank = (level: Level) => LEVEL_ORDER.indexOf(level);

/** Earlier first, a finding without a time after every timed one. */
function timeOrder(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function lineCount(output: string): number {
  if (output === "") return 0;
  const lines = output.split(/\r\n|\r|\n/);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function seconds(events: readonly RunEvent[], at: number): number | null {
  const ms = elapsedAt(events, at);
  return ms === null ? null : ms / 1000;
}

function stamp(e: RunEvent): number | null {
  const ts = (e as { ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : null;
}

function span(events: readonly RunEvent[]): { firstTs: number | null; lastTs: number | null } {
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const e of events) {
    const ts = stamp(e);
    if (ts === null) continue;
    firstTs ??= ts;
    lastTs = ts;
  }
  return { firstTs, lastTs };
}

function agentsOf(events: readonly RunEvent[]): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    const id = (e as { agentId?: unknown }).agentId;
    if (typeof id === "string" && id !== "" && id !== TITLE_AGENT_ID) seen.add(id);
  }
  return [...seen];
}

const pairKey = (agentId: unknown, callId: unknown) => `${String(agentId)}\u0000${String(callId)}`;
