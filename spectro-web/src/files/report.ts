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
import type { FileCall, FileLedger, Source } from "./fold";
import { higher, LEVEL_ORDER, outsideWorkspace, pathLevel, type Level } from "./levels";
import { countPersonalData, findCredentials, sizeBand, type CredentialHit } from "./secrets";
import type { TouchKind } from "./shell";
import { shellRisk } from "./shellRisk";

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
  command: string | null; // printableCommand output, masked; shell calls only
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
  title: string | null;
  version: string | null;
  exportedAt: number;
  workspace: string | null;
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
 * (a heredoc body is file content, B6) and at 300 characters, with the count of
 * the characters not printed.
 */
export function printableCommand(line: string, mask: (text: string) => string): string {
  const masked = mask(line);
  const heredoc = masked.indexOf("<<");
  let kept = heredoc < 0 ? masked : masked.slice(0, heredoc).trimEnd();
  const chars = Array.from(kept);
  if (chars.length > MAX_COMMAND) kept = chars.slice(0, MAX_COMMAND).join("");
  const cut = Array.from(masked).length - Array.from(kept).length;
  if (cut === 0) return kept;
  const note = `(${cut} more ${cut === 1 ? "character" : "characters"})`;
  return kept === "" ? note : `${kept} ${note}`;
}

export function buildReport(input: ReportInput): FilesReport {
  const { events, ledger } = input;
  const workspace = ledger.workspace;
  const all = destinationsOf(events);
  const reach = reachIndex(events);
  const creds = new Credentials();
  const mask = (text: string) => creds.mask(text);
  const label = (path: string) => mask(shortenPath(path, workspace));
  const callAt = new Map<number, FileCall>(ledger.calls.map((c) => [c.callIndex, c]));

  const scan = scanEvents(events, ledger, creds, all, reach);
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
          reached: touch.kind === "read" ? reachedFrom(call) : [],
        }),
      );
    }
    if (!call.shell) continue;
    const command = commandOf(call, events);
    if (command !== null) {
      const risk = shellRisk(command, call.base);
      if (risk.envDump !== null) {
        drafts.push(
          draft("env-dump", "critical", call, call.callIndex, "probable", {
            reached: reachedFrom(call),
            count: call.output === null ? 1 : lineCount(call.output),
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
    if (call.status !== "failed" && (call.script !== null || call.inline)) {
      drafts.push(
        draft("unknown-script", "unknown", call, call.callIndex, "probable", { path: call.script }),
      );
    }
  }

  // One finding per path outside the workspace; a secret path has its own.
  for (const [path, marks] of rows) {
    if (!outsideWorkspace(path, workspace) || pathLevel(path, workspace) === "critical") continue;
    const first = marks.find((m) => counts(m.sources)) ?? marks[0];
    drafts.push(
      draft("outside", "sensitive", first.call, first.call.callIndex, sourceOf(first.sources), {
        path,
        reached: reachedFrom(first.call),
      }),
    );
  }

  const findings = drafts.map((d) => finish(d, callAt, label, mask));
  findings.sort(
    (a, b) => rank(a.level) - rank(b.level) || timeOrder(a.t, b.t) || a.eventIndex - b.eventIndex,
  );

  const files: ReportFile[] = [];
  const tally = emptyCounts();
  let verdict: Level = "project";
  for (const [path, marks] of rows) {
    const level = pathLevel(path, workspace);
    const what = WHAT_ORDER.filter((w) => marks.some((m) => whatOf(m.kind) === w));
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
    title: input.title,
    version: input.version,
    exportedAt: input.now,
    workspace,
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
}

const WORD = /[A-Za-z0-9_]/;
const isWordAt = (text: string, at: number) => at >= 0 && at < text.length && WORD.test(text[at]);
/**
 * A value shorter than this is masked only where it stands as a word, so the
 * text around a mask cannot spell it ("u[credential 1]rade"). Six is the
 * password rule's own shortest value.
 */
const MASK_INSIDE_WORDS = 6;

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
  private longest: Sighting[] | null = null;

  get(secret: string): Sighting | undefined {
    return this.bySecret.get(secret);
  }

  /** The sighting of a hit's secret, registered at `event` when new. */
  see(hit: CredentialHit, event: number, call: number | null): Sighting {
    let s = this.bySecret.get(hit.secret);
    if (s === undefined) {
      const ref = {
        label: `credential ${this.bySecret.size + 1}`,
        rule: hit.rule,
        band: sizeBand(hit.secret),
      };
      s = { secret: hit.secret, ref, event, call };
      this.bySecret.set(hit.secret, s);
      this.longest = null;
    }
    return s;
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
    if (text === "") return text;
    const spans: { start: number; end: number; ref: CredentialRef }[] = [];
    const free = (start: number, end: number) => !spans.some((s) => start < s.end && s.start < end);
    for (const hit of findCredentials(text).hits) {
      spans.push({ start: hit.start, end: hit.end, ref: this.see(hit, -1, null).ref });
    }
    this.longest ??= [...this.bySecret.values()].sort((a, b) => b.secret.length - a.secret.length);
    for (const s of this.longest) {
      for (const at of occurrences(text, s.secret, s.secret.length < MASK_INSIDE_WORDS)) {
        const end = at + s.secret.length;
        if (free(at, end)) spans.push({ start: at, end, ref: s.ref });
      }
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a.start - b.start);
    let out = "";
    let at = 0;
    for (const s of spans) {
      out += `${text.slice(at, s.start)}[${s.ref.label}: ${s.ref.rule}]`;
      at = s.end;
    }
    return out + text.slice(at);
  }
}

/**
 * The input as text with its keys, but strings written as they are: the JSON
 * form would write a line break as `\n`, which joins the next word to the `n`
 * and hides a key behind `\b`, and a quote as `\"`, which ends a password value
 * before it starts.
 */
function inputText(input: unknown): string {
  if (typeof input === "string") return `"${input}"`;
  if (Array.isArray(input)) return `[${input.map(inputText).join(",")}]`;
  if (typeof input === "object" && input !== null) {
    const parts = Object.entries(input as Record<string, unknown>).map(([k, v]) => `"${k}":${inputText(v)}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(input) ?? "";
}

// ---- The scan of the event list --------------------------------------------------

/** A finding before its file label and command are filled in. */
interface Draft extends Omit<Finding, "file" | "command"> {
  path: string | null; // the path the finding is about; the call's own file otherwise
}

interface Scan {
  drafts: Draft[];
  resultAt: Map<number, number>; // call index to its result's event index
  placeholders: number;
  personal: { email: number; iban: number };
}

/**
 * One pass in event order over tool_call inputs, tool_result outputs, the
 * ledger's prompts and every steering_message (B8): the credential findings,
 * the placeholder count, the personal-data counts and the result of each call.
 */
function scanEvents(
  events: readonly RunEvent[],
  ledger: FileLedger,
  creds: Credentials,
  all: readonly Destination[],
  reach: ReachIndex,
): Scan {
  const drafts: Draft[] = [];
  const resultAt = new Map<number, number>();
  const prompts = new Map(ledger.prompts.map((p) => [p.eventIndex, p]));
  const unpaired = new Map<string, { index: number; name: string }[]>();
  const everywhere = all.map((d) => d.key);
  let placeholders = 0;
  const personal = { email: 0, iban: 0 };
  let firstPersonal: number | null = null;

  /** The distinct secrets of a text, labelled, in text order. */
  const refsOf = (text: string, event: number, call: number | null): CredentialRef[] => {
    const found = findCredentials(text);
    placeholders += found.placeholders;
    const refs: CredentialRef[] = [];
    for (const hit of found.hits) {
      const ref = creds.see(hit, event, call).ref;
      if (!refs.includes(ref)) refs.push(ref);
    }
    return refs;
  };

  const person = (text: string, event: number, agentId: string | null) => {
    const credentials = refsOf(text, event, null);
    if (credentials.length === 0) return;
    drafts.push({
      ...blank("credential-prompt", "critical", event, "recorded"),
      agentId,
      t: seconds(events, event),
      credentials,
      reached: everywhere,
    });
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as unknown as Record<string, unknown>;
    const prompt = prompts.get(i);
    if (prompt !== undefined) person(prompt.text, i, null);
    switch (e.type) {
      case "tool_call": {
        const name = String(e.name);
        const key = pairKey(e.agentId, e.callId);
        const stack = unpaired.get(key);
        if (stack === undefined) unpaired.set(key, [{ index: i, name }]);
        else stack.push({ index: i, name });

        const text = inputText(e.input);
        const found = findCredentials(text);
        placeholders += found.placeholders;
        const inHits = new Set(found.hits.map((h) => h.secret));
        const base = { agentId: String(e.agentId), t: seconds(events, i), tool: name, callIndex: i };
        for (const s of creds.before(i)) {
          if (!inHits.has(s.secret) && !appearsAsWord(text, s.secret)) continue;
          drafts.push({
            ...blank("credential-used", "critical", i, "recorded"),
            ...base,
            credentials: [s.ref],
            firstSeenCall: s.call,
          });
        }
        const fresh: CredentialRef[] = [];
        for (const hit of found.hits) {
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
        if (typeof e.text === "string") person(e.text, i, typeof e.agentId === "string" ? e.agentId : null);
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
  return { drafts, resultAt, placeholders, personal };
}

// ---- Small builders and readers ---------------------------------------------------

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

/** The draft with its file label and command: a shell call prints its command, a file tool its path. */
function finish(
  d: Draft,
  callAt: ReadonlyMap<number, FileCall>,
  label: (path: string) => string,
  mask: (text: string) => string,
): Finding {
  const { path, ...rest } = d;
  const call = d.callIndex === null ? undefined : callAt.get(d.callIndex);
  const own = call !== undefined && !call.shell && call.touches.length > 0 ? call.touches[0].path : null;
  const file = path ?? own;
  return {
    ...rest,
    file: file === null ? null : label(file),
    command: call?.shell ? printableCommand(call.line, mask) : null,
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
