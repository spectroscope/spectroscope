// Card 605: environment dumps and network commands in one shell line, for the
// files report (design section 3 and call B7). It reads the simple commands of
// the shell heuristic's tokenizer (shellTokens.ts), so quoted text and heredoc
// bodies are never commands. The body of a `$(...)`, backtick or `<(...)`
// substitution is read as a line of its own. A `cd` inside the line moves the
// base of the line's later commands (fix round 2 item 5).

import { resolvePath } from "./paths";
import { isPlaceholder } from "./secrets";
import { shellTouches } from "./shell";
import { segments, type Heredoc, type Segment, type Word } from "./shellTokens";

export interface NetworkUse {
  tool: string; // "curl", "git push", "npm publish", ...
  host: string | null; // as written, without user and port; null when the line does not name it
  sends: string[]; // local files the command sends, resolved against cwd
  sendsNamed: boolean; // false when it also sends files the line does not name (B7)
}

/**
 * A value in a credential position of a network command (card 605): a URL's
 * userinfo or query value, the value of `-u` and its kin, of an option whose
 * name says password, token, secret or key, of an auth or cookie header, and
 * the `-p` of sshpass. `start` and `end` bound it in the command string; a
 * value the line does not spell exactly is the whole word. `value` is what the
 * shell reads, dynamic pieces left out; `secret` is its credential part: the
 * password of `user:password`, the token after a header's scheme word, else
 * the value.
 */
export interface CommandValue {
  start: number;
  end: number;
  value: string;
  secret: string;
  /** False for a query value or a user name given alone whose parameter or
   *  option name says nothing of a credential (card 605, task 10 item 9): the
   *  report masks it and counts it only when a credential rule matches it. */
  named: boolean;
}

export interface ShellRisk {
  envDump: string | null; // the first command that printed the environment or a stored secret
  network: NetworkUse[];
  /** True when a getter printed one stored secret: gh auth token, op read, pass show, aws configure get, security ... -w. */
  secretOutput: boolean;
  values: CommandValue[];
  /** Values in credential positions that are placeholders or that the line does not spell. */
  placeholders: number;
}

/**
 * `powershell`: the line is PowerShell's (the call's tool is `powershell` or
 * `pwsh`), so `$env:NAME` reads a variable there (task 11 item 3b).
 */
export function shellRisk(
  command: string,
  cwd: string | null,
  { powershell = false }: { powershell?: boolean } = {},
): ShellRisk {
  const out: ShellRisk = { envDump: null, network: [], secretOutput: false, values: [], placeholders: 0 };
  readLine(command, cwd, out, 0, { at: 0 }, { ps: powershell, printed: true });
  return out;
}

// How deep substitutions, wrappers and `sh -c` lines are followed.
const MAX_DEPTH = 4;

/**
 * Where a line read from inside the command sits in the command: at an offset,
 * or, when its text is not a plain slice of the command (an escaped `sh -c`
 * script), only somewhere inside a span. A value found there is the span.
 */
type Place = { at: number } | { span: [number, number] };

/**
 * How a line is read (task 11 item 3): `ps` when it is PowerShell's, `printed`
 * when its output is the call's own printed output, which a line inside a
 * substitution's body is not.
 */
interface Mode {
  ps: boolean;
  printed: boolean;
}

/** What a command and its arguments are read against: the line's text, its place and its mode. */
interface Ctx {
  line: string;
  place: Place;
  mode: Mode;
}

const shift = (p: Place, by: number): Place => ("at" in p ? { at: p.at + by } : p);
const within = (p: Place, start: number, end: number): Place =>
  "at" in p ? { span: [p.at + start, p.at + end] } : p;

function readLine(
  line: string,
  cwd: string | null,
  out: ShellRisk,
  depth: number,
  place: Place,
  mode: Mode,
): void {
  if (depth > MAX_DEPTH) return;
  const ctx: Ctx = { line, place, mode };
  const items = riskSegments(line);
  let base = cwd;
  const outer: (string | null)[] = [];
  items.forEach((item, at) => {
    if (item === "(") outer.push(base);
    else if (item === ")") base = outer.length > 0 ? (outer.pop() ?? null) : base;
    if (item === "(" || item === ")") return;
    readSubs(item, base, out, depth, place, mode); // a substitution runs before the command that holds it
    const [head, ...args] = commandWords(item.words);
    if (head?.text === "cd" && !head.dynamic) {
      const dir = args.find((a) => !a.text.startsWith("-"));
      if (dir !== undefined && !dir.dynamic) base = resolvePath(dir.text, base);
      return;
    }
    run(item.words, item, base, out, depth, ctx, { items, at });
  });
}

/** The items of the line a segment stands in, and its index: PowerShell's `-Body (Get-Content f)` reads ahead. */
interface Next {
  items: readonly (Segment | "(" | ")")[];
  at: number;
}

/** Reads the substitutions of a segment as lines; an arithmetic body only for the substitutions in it. */
function readSubs(
  item: Segment,
  cwd: string | null,
  out: ShellRisk,
  depth: number,
  place: Place,
  mode: Mode,
): void {
  const inner: Mode = { ps: mode.ps, printed: false };
  for (const w of wordsOf(item)) {
    const s = w as SWord;
    subsOf(w).forEach((body, k) =>
      readLine(body, cwd, out, depth + 1, shift(place, s.subAt?.[k] ?? 0), inner),
    );
    arithOf(w).forEach((body, k) => {
      if (depth + 1 > MAX_DEPTH) return;
      const at = shift(place, s.arithAt?.[k] ?? 0);
      for (const seg of riskSegments(body))
        if (typeof seg !== "string") readSubs(seg, cwd, out, depth + 1, at, inner);
    });
  }
}

const wordsOf = (s: Segment): Word[] => [
  ...s.words,
  ...s.redirects.flatMap((r) => (r.target ? [r.target] : [])),
];

// Substitutions. The tokenizer drops the text of `$(...)`, backticks, `<(...)`
// and every `$` form and only marks the word dynamic. riskSegments swaps each one
// for a literal marker first, with the tokenizer's own rules for quotes, comments,
// escapes and heredocs, tokenizes the masked line and hangs the bodies back on
// their words, with the word's shape.

/**
 * A word with what made it dynamic: `subs` are the bodies of its command
 * substitutions, `arith` of its `$((...))`, `vars` is true for a variable or
 * parameter, `shape` is its text with each dynamic piece as one DYN character.
 */
type SWord = Word & {
  subs?: string[];
  subAt?: number[]; // where each body starts in the line
  arith?: string[];
  arithAt?: number[];
  vars?: boolean;
  shape?: string;
};
const subsOf = (w: Word): string[] => (w as SWord).subs ?? [];
const arithOf = (w: Word): string[] => (w as SWord).arith ?? [];
const varsOf = (w: Word): boolean => (w as SWord).vars ?? w.dynamic;
/** The shape of a word; null for a dynamic word whose pieces are not known. */
const shapeOf = (w: Word): string | null => (w.dynamic ? ((w as SWord).shape ?? null) : w.text);

const OPEN = "\uE000"; // a substitution: OPEN, its index, CLOSE
const CLOSE = "\uE001";
const VAR = "\uE002"; // a variable or parameter
const DYN = VAR; // one dynamic piece in a shape
const MARK = /\uE000(\d+)\uE001|\uE002/g;
const HAS_DYNAMIC = /[`$]|[<>]\(/;
const META = " \t\r\n;&|()<>";
const OPERATORS = ["<<<", "<<-", "&>>", ">>", "<<", "<>", "<&", ">&", ">|", "&>"];

/** A substitution body, where it starts in the line, and whether it is arithmetic. */
interface Body {
  text: string;
  at: number;
  arith: boolean;
}

/** The masked line, and for each of its characters the source range it stands for. */
interface Masked {
  text: string;
  from: number[];
  to: number[];
}

/**
 * segments() with what made each word dynamic kept on it (see SWord). Word
 * positions are those of `command`, as segments() gives them.
 */
export function riskSegments(command: string): (Segment | "(" | ")")[] {
  if (!HAS_DYNAMIC.test(command) || /[\uE000-\uE002]/.test(command)) return segments(command);
  const docs = segments(command).flatMap((s) => (typeof s === "string" ? [] : s.docs));
  const bodies: Body[] = [];
  const masked = mask(command, docs, bodies);
  // An unclosed quote reads past the end, in the masked line as in the line itself.
  const { from, to } = masked;
  const endOf = (k: number) => (k - 1 < to.length ? to[k - 1] : to[to.length - 1] + (k - to.length));
  const unmask = (raw: Word): Word => {
    const w: Word =
      raw.start === undefined || raw.end === undefined || raw.end <= raw.start || from.length === 0
        ? raw
        : { ...raw, start: from[Math.min(raw.start, from.length - 1)], end: endOf(raw.end) };
    if (!/[\uE000\uE002]/.test(w.text)) return w;
    const subs: string[] = [];
    const subAt: number[] = [];
    const arith: string[] = [];
    const arithAt: number[] = [];
    let vars = w.dynamic;
    const text = w.text.replace(MARK, (m, n?: string) => {
      const body = bodies[Number(n)];
      if (m === VAR) vars = true;
      else if (body.arith) {
        arith.push(body.text);
        arithAt.push(body.at);
      } else {
        subs.push(body.text);
        subAt.push(body.at);
      }
      return "";
    });
    const out: SWord = {
      ...w,
      text,
      dynamic: true,
      vars,
      subs,
      subAt,
      arith,
      arithAt,
      shape: w.text.replace(MARK, DYN),
    };
    return out;
  };
  // The heredocs of the masked line are those of the line, in order: their places are the line's.
  let doc = 0;
  return segments(masked.text).map((s) =>
    typeof s === "string"
      ? s
      : {
          ...s,
          words: s.words.map(unmask),
          redirects: s.redirects.map((r) => ({ ...r, target: r.target && unmask(r.target) })),
          docs: s.docs.map((d) => docs[doc++] ?? d),
        },
  );
}

function mask(src: string, docs: Heredoc[], bodies: Body[]): Masked {
  let out = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  let pending = 0; // heredocs whose body starts after the next newline
  let next = 0; // the next of `docs`, in the tokenizer's order
  let delimiter = false; // inside a heredoc delimiter word, which stays as written
  /** Appends `text`, standing for src[start, end): copied character by character, or as one marker. */
  const put = (text: string, start: number, end: number, copied: boolean) => {
    for (let k = 0; k < text.length; k++) {
      from.push(copied ? start + k : start);
      to.push(copied ? start + k + 1 : end);
    }
    out += text;
  };
  const copy = (end: number) => {
    put(src.slice(i, end), i, end, true);
    i = end;
  };
  const sub = (end: number, body: string, at: number, arith = false) => {
    if (delimiter) return copy(end);
    put(OPEN + String(bodies.push({ text: body, at, arith }) - 1) + CLOSE, i, end, false);
    i = end;
  };
  const variable = (end: number) => {
    if (delimiter) return copy(end);
    put(VAR, i, end, false);
    i = end;
  };
  const dollar = (inDouble: boolean) => {
    const n = src[i + 1];
    if (n === "(") {
      // `$((...))` is arithmetic: kept apart, never read as a command line.
      const b = balanced(src, i + 1);
      sub(b.end, src.slice(i + 2, b.closed ? b.end - 1 : src.length), i + 2, src[i + 2] === "(");
    } else if (n === "{") variable(balanced(src, i + 1).end);
    else if (/[A-Za-z_]/.test(n ?? "")) {
      let j = i + 2;
      while (j < src.length && /\w/.test(src[j])) j++;
      variable(j);
    } else if (/[0-9@*#?$!-]/.test(n ?? ""))
      variable(i + 2); // `$$(` is `$$` and a `(`
    else if (!inDouble && n === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      copy(j + 1);
    } else copy(i + 1);
  };
  const tick = () => {
    let j = i + 1;
    while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
    sub(j + 1, src.slice(i + 1, Math.min(j, src.length)), i + 1);
  };
  let delimiterAt = -1;
  let tokenStart = true; // where the tokenizer's main loop stands: `#` starts a comment only here
  while (i < src.length) {
    const c = src[i];
    // A delimiter word ends at a metacharacter, except that it may start with `<(` or `>(`.
    const procSub = (c === "<" || c === ">") && src[i + 1] === "(";
    if (META.includes(c) && !(i === delimiterAt && procSub)) delimiter = false;
    const wasStart: boolean = tokenStart;
    tokenStart = (META.includes(c) && !procSub) || (c === "(" && src[i + 1] === "(");
    if (c === "\\") {
      if (src[i + 1] === "\n") tokenStart = wasStart; // a line continuation
      copy(i + 2);
    } else if (c === "\n") {
      copy(i + 1);
      for (; pending > 0; pending--) if (next < docs.length) copy(bodyEnd(src, i, docs[next++]));
    } else if (c === "#" && wasStart) {
      const nl = src.indexOf("\n", i);
      copy(nl === -1 ? src.length : nl);
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      copy(e === -1 ? src.length : e + 1);
    } else if (c === '"') {
      copy(i + 1);
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && '$`"\\\n'.includes(src[i + 1] ?? "")) copy(i + 2);
        else if (src[i] === "$") dollar(true);
        else if (src[i] === "`") tick();
        else copy(i + 1);
      }
      copy(i + 1);
    } else if (c === "$") dollar(false);
    else if (c === "`") tick();
    else if (procSub) {
      // `<` and `>` end a word, so the marker of `<(...)` must start one: `a>(b)` and `\|<(b)` are two words.
      if (!delimiter) put(" ", i, i, false);
      const b = balanced(src, i + 1);
      sub(b.end, src.slice(i + 2, b.closed ? b.end - 1 : src.length), i + 2);
    } else if (c === "(" && src[i + 1] === "(") copy(balanced(src, i).end);
    else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (op === "<<" || op === "<<-") {
        pending++;
        copy(i + op.length);
        while (src[i] === " " || src[i] === "\t") copy(i + 1);
        delimiter = true;
        delimiterAt = i;
        tokenStart = false; // the delimiter word starts here: `<< #x` has the delimiter `#x`
      } else copy(i + (op?.length ?? 1));
    }
  }
  return { text: out, from, to };
}

// The tokenizer's skipBalanced, telling also whether the closing bracket came.
function balanced(src: string, i: number): { end: number; closed: boolean } {
  const open = src[i];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" && c === '"' ? 2 : 1;
      i = j;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return { end: i + 1, closed: true };
  }
  return { end: src.length, closed: false };
}

// The tokenizer's readBodies for one heredoc: the index after its terminator line.
function bodyEnd(src: string, i: number, doc: Heredoc): number {
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const end = nl === -1 ? src.length : nl;
    const line = doc.strip ? src.slice(i, end).replace(/^\t+/, "") : src.slice(i, end);
    i = nl === -1 ? src.length : nl + 1;
    if (line === doc.delimiter) break;
  }
  return i;
}

// The command name.

const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "while", "until", "do"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The words from the command name on: reserved words and `NAME=value` assignments dropped. */
function commandWords(words: Word[]): Word[] {
  let k = 0;
  while (k < words.length && (RESERVED.has(words[k].text) || ASSIGNMENT.test(words[k].text))) k++;
  return words.slice(k);
}

/** A bare name, or the base name of an absolute path; a relative path is a local script. */
function commandName(text: string): string | null {
  if (!text.includes("/")) return text;
  return text.startsWith("/") ? (text.split("/").pop() ?? null) : null;
}

function run(
  words: Word[],
  seg: Segment,
  cwd: string | null,
  out: ShellRisk,
  depth: number,
  ctx: Ctx,
  next: Next | null,
): void {
  const [head, ...args] = commandWords(words);
  if (head && ctx.mode.ps && printsEnvVariable(head, args, ctx)) dumped(out, "$env:");
  if (!head || head.dynamic || depth > MAX_DEPTH) return;
  const written = commandName(head.text);
  if (written === null) return;
  // `curl.exe` and the other Windows names count as their tool.
  const name = written.replace(/\.exe$/i, "");
  const lower = name.toLowerCase();
  if (name === "env") {
    const rest = parse(args, ENV).operands;
    if (commandWords(rest).length === 0) dumped(out, "env");
    else run(rest, seg, cwd, out, depth + 1, ctx, next);
    return;
  }
  if (name === "xargs") {
    const p = parse(args, XARGS);
    const repl = values(p, "-I", "-J", "--replace").map((w) => w.text);
    if (has(p, "-i")) repl.push("{}");
    return runFed(p.operands, repl, seg, cwd, out, depth, ctx, next);
  }
  if (name === "find") {
    for (const clause of execClauses(args)) runFed(clause, ["{}"], seg, cwd, out, depth, ctx, next);
    return;
  }
  if (name === "eval") {
    if (args.length === 0 || args.some((w) => w.dynamic)) return;
    const first = args[0];
    const last = args[args.length - 1];
    const place =
      args.length === 1
        ? placeOf(first, ctx)
        : within(ctx.place, first.start ?? 0, last.end ?? ctx.line.length);
    return readLine(args.map((w) => w.text).join(" "), cwd, out, depth + 1, place, ctx.mode);
  }
  if (lower === "powershell" || lower === "pwsh") return powershell(args, cwd, out, depth, ctx);
  const psDump = psDumpOf(lower, args);
  if (psDump !== null) dumped(out, psDump);
  const web = PS_WEB.get(lower);
  if (web !== undefined) {
    out.network.push(psWeb(web, args, cwd, next));
    for (const w of args) urlValues(out, ctx, w);
    return;
  }
  if (name === "sshpass") {
    const p = parse(args, SSHPASS);
    for (const o of p.options) {
      if (o.name !== "-p" || !o.value) continue;
      const holder = o.inline ? o.from : o.value;
      const from = o.inline ? o.from.text.length - o.value.text.length : 0;
      secretValue(out, ctx, holder, from, holder.text.length, shapeText(o.value), "plain");
    }
    return run(p.operands, seg, cwd, out, depth + 1, ctx, next);
  }
  const wrapper = WRAPPERS.get(name);
  if (wrapper) {
    const p = parse(args, wrapper);
    if (name === "command" && has(p, "-v", "-V")) return; // a lookup, not a run
    return run(p.operands.slice(wrapper.skip ?? 0), seg, cwd, out, depth + 1, ctx, next);
  }
  if (SHELLS.has(name)) {
    const p = parse(args, SHELL);
    const script = p.operands[0];
    if (has(p, "-c") && script && !script.dynamic)
      readLine(script.text, cwd, out, depth + 1, placeOf(script, ctx), { ...ctx.mode, ps: false });
    return;
  }
  const dump = dumpOf(name, args);
  if (dump !== null) dumped(out, dump);
  // A getter's output is registered only when it is what the call printed (task 11 item 3c).
  if (dump !== null && printsOneSecret(dump, args) && ctx.mode.printed && !pipedOn(next))
    out.secretOutput = true;
  const found = NETWORK.get(name)?.(args, seg, cwd);
  if (found) {
    subSends(found, name, args, seg, cwd);
    out.network.push(found);
    positionValues(name, args, ctx, out);
  }
}

function dumped(out: ShellRisk, what: string): void {
  if (out.envDump === null) out.envDump = what;
}

// Options: a small getopt that keeps every option in order (curl repeats -T and -d).

interface Spec {
  short?: string; // short options that take a value
  optional?: string; // short options whose value is optional and only attached (`od -w16`)
  long?: string[]; // long options that take a value
  posix?: boolean; // the first operand ends the options
  skip?: number; // wrappers: operands to drop before the command (the duration of `timeout`)
}
interface Parsed {
  // `from` is the word that holds the option; `inline` when the value sits in it too (`--name=value`).
  options: { name: string; value: Word | null; from: Word; inline: boolean }[];
  operands: Word[];
}

// The value part of `--name=value` or `-dvalue`, keeping the word's substitutions
// and the part of its shape that falls into the value. Before the first dynamic
// piece the shape is the text itself; a dynamic piece in the name leaves the value unknown.
const part = (w: Word, text: string): Word => {
  const shape = (w as SWord).shape;
  const out: SWord = { ...w, text };
  if (shape !== undefined) {
    const cut = w.text.length - text.length;
    const first = shape.indexOf(DYN);
    out.shape = first === -1 || first >= cut ? shape.slice(cut) : DYN;
  }
  return out;
};

/** True when a dynamic piece starts at index `i` of the word (`-o"$(...)"` at 2). */
const dynamicAt = (w: Word, i: number) => shapeOf(w)?.[i] === DYN;

function parse(args: Word[], spec: Spec): Parsed {
  const options: Parsed["options"] = [];
  const operands: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const t = a.text;
    if (t === "--") {
      operands.push(...args.slice(k + 1));
      break;
    }
    // A dynamic word that starts with `-` is an option with an unknown value (`--post-file=$F`).
    if (!t.startsWith("-") || t === "-") {
      if (spec.posix) {
        operands.push(...args.slice(k));
        break;
      }
      operands.push(a);
    } else if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq < 0 ? t : t.slice(0, eq);
      const takes = spec.long?.includes(name.slice(2)) ?? false;
      const value = eq >= 0 ? part(a, t.slice(eq + 1)) : takes ? (args[++k] ?? null) : null;
      options.push({ name, value, from: a, inline: eq >= 0 });
    } else {
      for (let q = 1; q < t.length; q++) {
        const optional = spec.optional?.includes(t[q]) ?? false;
        if (!spec.short?.includes(t[q]) && !optional) {
          options.push({ name: "-" + t[q], value: null, from: a, inline: false });
          continue;
        }
        // The value is attached when text or a dynamic piece follows the letter: `-o"$(...)"`.
        const inline = q + 1 < t.length || dynamicAt(a, q + 1);
        const value = inline ? part(a, t.slice(q + 1)) : optional ? null : (args[++k] ?? null);
        options.push({ name: "-" + t[q], value, from: a, inline });
        break;
      }
    }
  }
  return { options, operands };
}

const has = (p: Parsed, ...names: string[]) => p.options.some((o) => names.includes(o.name));
const values = (p: Parsed, ...names: string[]): Word[] =>
  p.options.flatMap((o) => (o.value && names.includes(o.name) ? [o.value] : []));

const ENV: Spec = { short: "uCS", long: ["unset", "chdir", "split-string"], posix: true };
const WRAPPERS = new Map<string, Spec>([
  ["sudo", { short: "ugpChDrtU", long: ["user", "group", "prompt", "chdir", "role", "type"], posix: true }],
  ["nohup", { posix: true }],
  ["time", { posix: true }],
  ["exec", { short: "a", posix: true }],
  ["command", { posix: true }],
  ["nice", { short: "n", long: ["adjustment"], posix: true }],
  ["timeout", { short: "sk", long: ["signal", "kill-after"], posix: true, skip: 1 }],
  ["doas", { short: "aCu", posix: true }],
  ["stdbuf", { short: "ioe", long: ["input", "output", "error"], posix: true }],
  ["watch", { short: "nq", long: ["interval", "equexit"], posix: true }],
  ["caffeinate", { short: "tw", posix: true }],
]);
const XARGS: Spec = {
  short: "adEIJLnPRSs",
  optional: "eil",
  long: ["arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars"],
  posix: true,
};

/**
 * Runs a command that xargs or `find -exec` builds: a replacement word (`{}`,
 * the value of `-I`) stands for paths the line does not spell, and xargs adds
 * the words of its input, so every network use it makes sends files the line
 * does not name.
 */
function runFed(
  words: Word[],
  repl: readonly string[],
  seg: Segment,
  cwd: string | null,
  out: ShellRisk,
  depth: number,
  ctx: Ctx,
  next: Next | null,
): void {
  const fed = words.map((w) => (repl.includes(w.text) ? { ...w, dynamic: true } : w));
  const before = out.network.length;
  run(fed, seg, cwd, out, depth + 1, ctx, next);
  for (const u of out.network.slice(before)) u.sendsNamed = false;
}

/** The commands of `find`'s `-exec`, `-execdir`, `-ok` and `-okdir`, each up to its `;` or `+`. */
function execClauses(args: Word[]): Word[][] {
  const out: Word[][] = [];
  for (let k = 0; k < args.length; k++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k].text)) continue;
    const clause: Word[] = [];
    for (k++; k < args.length && args[k].text !== ";" && args[k].text !== "+"; k++) clause.push(args[k]);
    out.push(clause);
  }
  return out;
}

// PowerShell (final wave item 4b), read for a few cmdlets only: the web
// cmdlets as network commands, the Env: drive and $env: as dumps, and the
// command of `powershell -Command` or `pwsh -c` as a line.

const PS_WEB = new Map<string, string>([
  ["invoke-webrequest", "Invoke-WebRequest"],
  ["iwr", "Invoke-WebRequest"],
  ["invoke-restmethod", "Invoke-RestMethod"],
  ["irm", "Invoke-RestMethod"],
]);
const PS_VALUES = new Set([
  "uri",
  "method",
  "infile",
  "outfile",
  "body",
  "headers",
  "contenttype",
  "credential",
  "websession",
  "sessionvariable",
  "form",
  "timeoutsec",
  "maximumredirection",
  "proxy",
  "proxycredential",
  "useragent",
  "certificatethumbprint",
  "transferencoding",
  "custommethod",
  "path",
  "literalpath",
]);
const PS_READERS = new Set(["get-content", "gc", "type", "cat"]);
const ENV_DRIVE = /^env:/i;
const ENV_VARIABLE = /^\$(?:env:[A-Za-z_]\w*|\{env:[^}]+\})$/i;
const PS_PRINT = new Set(["echo", "write-output", "write-host", "write", "out-host", "write-information"]);

/** PowerShell parameters: `-Name value` for the names that take one, `-Name:value`, and switches. */
function psParams(args: Word[]): { params: Map<string, Word | null>; operands: Word[] } {
  const params = new Map<string, Word | null>();
  const operands: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const m = /^-([A-Za-z][\w-]*)(?::(.*))?$/s.exec(args[k].text);
    if (!m || args[k].dynamic) {
      operands.push(args[k]);
      continue;
    }
    const key = m[1].toLowerCase();
    if (m[2] !== undefined) params.set(key, part(args[k], m[2]));
    else params.set(key, PS_VALUES.has(key) ? (args[++k] ?? null) : null);
  }
  return { params, operands };
}

/** The files a Get-Content (gc, type, cat) reads; unnamed when it is another command or a path is dynamic. */
function psContentFiles(words: Word[], cwd: string | null): { files: string[]; unnamed: boolean } {
  const [head, ...args] = words;
  if (!head || !PS_READERS.has(head.text.toLowerCase())) return { files: [], unnamed: true };
  const p = psParams(args);
  const paths = [...p.operands, ...["path", "literalpath"].flatMap((k) => p.params.get(k) ?? [])];
  return {
    files: paths.filter((w) => !w.dynamic).map((w) => resolvePath(w.text, cwd)),
    unnamed: paths.some((w) => w.dynamic),
  };
}

/** Invoke-WebRequest and Invoke-RestMethod: the host of -Uri or the first URL, -InFile, and a -Body read from a file. */
function psWeb(tool: string, args: Word[], cwd: string | null, next: Next | null): NetworkUse {
  const p = psParams(args);
  const uri = p.params.get("uri");
  const u = networkUse(tool, firstHost(uri ? [uri] : p.operands, true));
  const inFile = p.params.get("infile");
  if (inFile) send(u, inFile, cwd);
  if (!p.params.has("body")) return u;
  const body = p.params.get("body") ?? null;
  const read: { files: string[]; unnamed: boolean } = { files: [], unnamed: false };
  if (body === null) {
    // `-Body (Get-Content f)`: the parenthesis opens the next item of the line.
    const after = next?.items[next.at + 2];
    const inner = next?.items[next.at + 1] === "(" && after !== undefined && typeof after !== "string";
    const r = inner ? psContentFiles(after.words, cwd) : { files: [], unnamed: true };
    read.files.push(...r.files);
    read.unnamed = r.unnamed;
  } else if (body.dynamic) {
    // `-Body $(Get-Content f)` reads the file; a variable can hold anything.
    const subs = subsOf(body);
    if (varsOf(body) && subs.length === 0) read.unnamed = true;
    for (const line of subs) {
      for (const seg of riskSegments(line)) {
        if (typeof seg === "string") continue;
        const r = psContentFiles(seg.words, cwd);
        read.files.push(...r.files);
        if (r.unnamed) read.unnamed = true;
      }
    }
  }
  for (const f of read.files) addSend(u, f);
  if (read.unnamed) u.sendsNamed = false;
  return u;
}

/** Get-ChildItem Env:, Get-Item Env:NAME and their aliases print variables. */
function psDumpOf(lower: string, args: Word[]): string | null {
  if (!args.some((w) => ENV_DRIVE.test(w.text))) return null;
  if (["get-childitem", "gci", "dir", "ls"].includes(lower)) return "Get-ChildItem Env:";
  if (["get-item", "gi"].includes(lower)) return "Get-Item Env:";
  return null;
}

/** `$env:NAME` on its own or as what echo or Write-Output prints; `$env:NAME = x` sets it. */
function printsEnvVariable(head: Word, args: Word[], ctx: Ctx): boolean {
  const raw = (w: Word) =>
    w.start === undefined || w.end === undefined ? "" : ctx.line.slice(w.start, w.end);
  if (ENV_VARIABLE.test(raw(head))) return !args[0]?.text.startsWith("=");
  return PS_PRINT.has(head.text.toLowerCase()) && args.some((w) => ENV_VARIABLE.test(raw(w)));
}

/** `powershell -Command ...` and `pwsh -c ...`: the rest of the words is one line. An encoded command is not read. */
function powershell(args: Word[], cwd: string | null, out: ShellRisk, depth: number, ctx: Ctx): void {
  const at = args.findIndex((w) => /^-(?:c|com|comm|comma|comman|command)(?::.*)?$/i.test(w.text));
  if (at < 0) return;
  const rest = args.slice(at + 1);
  if (rest.length === 0 || rest.some((w) => w.dynamic)) return;
  const first = rest[0];
  const last = rest[rest.length - 1];
  const place =
    rest.length === 1
      ? placeOf(first, ctx)
      : within(ctx.place, first.start ?? 0, last.end ?? ctx.line.length);
  readLine(rest.map((w) => w.text).join(" "), cwd, out, depth + 1, place, { ...ctx.mode, ps: true });
}
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL: Spec = { short: "o", long: ["rcfile", "init-file"], posix: true };
const SSHPASS: Spec = { short: "fdpP", posix: true };

/** The place of a line read from the text of `w`: exact when the line spells the text plainly or in one pair of quotes. */
function placeOf(w: Word, ctx: Ctx): Place {
  const r = textRange(w, ctx, 0, w.text.length);
  if (r === null || w.start === undefined || w.end === undefined)
    return within(ctx.place, 0, ctx.line.length);
  return r.exact ? shift(ctx.place, r.start) : within(ctx.place, w.start, w.end);
}

// Environment and keychain dumps (design section 3): the command printed
// variables or a stored secret to its output, which the model reads.

const SECURITY = new Set(["find-generic-password", "find-internet-password", "dump-keychain"]);
const AWS: Spec = {
  long: [
    "profile",
    "region",
    "output",
    "endpoint-url",
    "query",
    "color",
    "ca-bundle",
    "cli-read-timeout",
    "cli-connect-timeout",
    "cli-binary-format",
  ],
};
const OP: Spec = { long: ["account", "config", "encoding", "format", "session", "vault", "fields"] };

/** The dumps that print one stored secret and nothing else: `security` only with `-w`. */
const ONE_SECRET = new Set(["gh auth token", "op read", "pass show"]);
/** The keys `aws configure get` prints a secret for, alone or after a profile (`prod.aws_session_token`). */
const AWS_SECRET_KEYS = new Set(["aws_access_key_id", "aws_secret_access_key", "aws_session_token"]);

/** Commands a getter's output may pass through and stay the line's own output (fix round 2 item 5). */
const PASS_THROUGH = new Set(["head", "tail", "tr", "cut"]);

/** True when a later command of the line takes this one's output from a pipe, other than head, tail, tr or cut. */
function pipedOn(next: Next | null): boolean {
  if (next === null) return false;
  for (let k = next.at + 1; ; k++) {
    while (next.items[k] === ")") k++;
    const after = next.items[k];
    if (after === undefined || typeof after === "string" || !after.piped) return false;
    const head = commandWords(after.words)[0];
    const name = head === undefined || head.dynamic ? null : commandName(head.text);
    if (name === null || !PASS_THROUGH.has(name)) return true;
  }
}

function printsOneSecret(dump: string, args: Word[]): boolean {
  if (ONE_SECRET.has(dump)) return true;
  if (dump === "aws configure get") {
    const key = parse(args, AWS).operands[2]?.text ?? "";
    return AWS_SECRET_KEYS.has(key.slice(key.lastIndexOf(".") + 1));
  }
  return dump.startsWith("security find-") && args.some((w) => /^-[A-Za-z]*w[A-Za-z]*$/.test(w.text));
}

function dumpOf(name: string, args: Word[]): string | null {
  const ops = (spec: Spec = {}) => parse(args, spec).operands.map((w) => w.text);
  if (name === "printenv") return "printenv";
  if (name === "set") return args.length === 0 ? "set" : null;
  if (name === "export") {
    if (!args.every((a) => a.text === "-p")) return null;
    return args.length > 0 ? "export -p" : "export";
  }
  if (name === "security") {
    const [sub] = ops({ short: "p" });
    return sub !== undefined && SECURITY.has(sub) ? `security ${sub}` : null;
  }
  if (name === "declare" || name === "typeset") {
    if (!args.every((a) => /^-[px]+$/.test(a.text))) return null;
    return [name, ...args.map((a) => a.text)].join(" ");
  }
  if (name === "compgen") {
    const p = parse(args, { short: "AGWXPSFCo" });
    if (has(p, "-v")) return "compgen -v";
    if (has(p, "-e")) return "compgen -e";
    const action = values(p, "-A").find((w) => w.text === "variable" || w.text === "export");
    return action ? `compgen -A ${action.text}` : null;
  }
  const [a, b] = ops(name === "aws" ? AWS : name === "op" ? OP : {});
  if (name === "gh" && a === "auth" && b === "token") return "gh auth token";
  if (name === "aws" && a === "configure" && (b === "get" || b === "export-credentials"))
    return `aws configure ${b}`;
  if (name === "op" && a === "read") return "op read";
  if (name === "op" && a === "item" && b === "get") return "op item get";
  if (name === "pass" && a === "show") return "pass show";
  return null;
}

// Hosts: `scheme://[user@]host[:port]` or a remote spec `[user@]host:path`, as written.

const URL_HOST = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]/]*\]|[^:/?#]*)/;
const REMOTE_HOST = /^(?:[^@/:]*@)?(\[[^\]/]*\]|[^:/@\s[]+):/;
// curl, wget and httpie take a target without a scheme: `example.com/api`.
const BARE_HOST =
  /^(?:[^@/:\s]+@)?(localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\[[0-9A-Fa-f:.]+\])(?::\d+)?(?:[/?#]|$)/;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const literalPart = (shape: string) => shape.split(DYN)[0];

// A dynamic word is remote by the literal text before its first dynamic piece.
const isRemote = (w: Word) => {
  const s = shapeOf(w);
  return s !== null && (URL_HOST.test(literalPart(s)) || REMOTE_HOST.test(literalPart(s)));
};

/**
 * The shape a host is read from. When a dynamic piece stands before an `@` in
 * the authority, the userinfo up to that `@` is dropped: `https://u:$P@h/x`
 * names `h`. In a URL the authority ends at `/`, `?` or `#`. A word without a
 * scheme is a URL only for a tool that takes one (`urlish`), and there it must
 * start with a literal: `$CDN` can hold `scheme://host/` itself. Otherwise it is
 * a remote spec or an ssh destination, whose user sits before the first `:`: in
 * scp `h:$D@x/y` the `:` ends the host. A user with a `/` is not dropped. scp
 * reads such a word as a local path; ssh takes a `/` in the user, and there the
 * host is null on purpose.
 */
function hostShape(w: Word, urlish: boolean): string | null {
  const s = shapeOf(w);
  if (s === null) return null;
  const scheme = SCHEME.exec(s)?.[0] ?? "";
  const rest = s.slice(scheme.length);
  const url = scheme !== "" || urlish;
  if (scheme === "" && urlish && rest.startsWith(DYN)) return null;
  const end = url ? rest.search(/[/?#]/) : rest.indexOf(":");
  const authority = end < 0 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  const user = authority.slice(0, Math.max(at, 0));
  if (at < 0 || !user.includes(DYN) || (!url && user.includes("/"))) return s;
  return scheme + rest.slice(at + 1);
}

function hostOf(w: Word | null | undefined, urlish = false, bare = false): string | null {
  const s = w ? hostShape(w, urlish) : null;
  if (s === null) return null;
  const t = literalPart(s);
  const m = URL_HOST.exec(t) ?? REMOTE_HOST.exec(t) ?? (bare ? BARE_HOST.exec(t) : null);
  if (!m || m[1] === "") return null;
  // The host must end before the first dynamic piece: `https://h$X` names no host.
  if (s.includes(DYN) && m[0].length === t.length && !/[:/?#]$/.test(m[0])) return null;
  return m[1];
}

/**
 * The host of the first word that names one. With `bare` (curl, wget, httpie:
 * tools that take a URL) a later pass also takes a target without a scheme.
 */
function firstHost(words: Word[], bare = false): string | null {
  for (const w of words) {
    const h = hostOf(w, bare);
    if (h !== null) return h;
  }
  if (!bare) return null;
  for (const w of words) {
    const h = hostOf(w, true, true);
    if (h !== null) return h;
  }
  return null;
}

/**
 * The host of an ssh destination: `[user@]host`, `[user@]host:path` or `ssh://...`.
 * Of a dynamic word only a dynamic user is dropped (`"$U@h"` names `h`), and
 * the host after it must be literal; any other dynamic word names no host.
 */
function destination(w: Word | undefined): string | null {
  if (!w) return null;
  if (w.dynamic) {
    const s = hostShape(w, false);
    if (s === null || s === shapeOf(w) || SCHEME.test(s)) return null;
    return /^(\[[^\]\uE002]*\]|[^:@/\s\uE002[]+)(?=$|[:/])/.exec(s)?.[1] ?? null;
  }
  const url = URL_HOST.exec(w.text);
  if (url) return url[1] || null;
  return /^(?:[^@]*@)?(\[[^\]]*\]|[^:@/\s]+)/.exec(w.text)?.[1] ?? null;
}

// Network commands (design section 3, R8).

type NetRule = (args: Word[], seg: Segment, cwd: string | null) => NetworkUse | null;

function networkUse(tool: string, host: string | null, sendsNamed = true): NetworkUse {
  return { tool, host, sends: [], sendsNamed };
}

const addSend = (u: NetworkUse, path: string) => {
  if (!u.sends.includes(path)) u.sends.push(path);
};

/** Adds a file the command sends; a word the line does not spell makes the use unnamed. */
function send(u: NetworkUse, w: Word, cwd: string | null, text = w.text): void {
  if (w.dynamic) u.sendsNamed = false;
  else if (text !== "" && text !== "-") addSend(u, resolvePath(text, cwd));
}

/**
 * A value the command sends as data (its files are sent by subSends). A
 * variable, or a substitution that reads no file the line names, leaves the use
 * unnamed: a value the line does not spell can be `@file`. Arithmetic is a
 * number and changes nothing.
 */
function data(u: NetworkUse, w: Word, cwd: string | null): void {
  if (!w.dynamic) return;
  if (varsOf(w)) u.sendsNamed = false;
  for (const body of subsOf(w)) {
    const r = subFiles(body, cwd, 1);
    if (r.files.length === 0 || r.unnamed) u.sendsNamed = false;
  }
}

/**
 * A command that sends its standard input: a `<` file is sent, a here-string is
 * a data value, a pipe carries data the line does not name.
 */
function sendStdin(u: NetworkUse, seg: Segment, cwd: string | null): void {
  for (const r of seg.redirects) {
    if (!r.target || !(r.fd === null || r.fd === 0)) continue;
    if (r.op === "<") send(u, r.target, cwd);
    else if (r.op === "<<<") data(u, r.target, cwd);
  }
  if (seg.piped) u.sendsNamed = false;
}

/**
 * Review round 2, rule 1: in a network command the files a substitution reads
 * are sent, wherever it stands (an operand, any option value, a here-string),
 * except in an option that names where the output goes.
 */
function subSends(u: NetworkUse, name: string, args: Word[], seg: Segment, cwd: string | null): void {
  const output = OUTPUTS.get(name);
  const skip = new Set<Word>();
  if (output) {
    for (const o of parse(args, output.spec).options) {
      if (!o.value || !output.is(o.name)) continue;
      skip.add(o.inline ? o.from : o.value);
    }
  }
  const strings = seg.redirects.flatMap((r) => (r.op === "<<<" && r.target ? [r.target] : []));
  for (const w of [...args, ...strings]) {
    if (skip.has(w)) continue;
    for (const body of subsOf(w)) {
      const r = subFiles(body, cwd, 1);
      for (const f of r.files) addSend(u, f);
      if (r.unnamed) u.sendsNamed = false;
    }
  }
}

interface SubRead {
  files: string[];
  unnamed: boolean;
}

/**
 * What a substitution body reads: the files shell.ts sees it read, those of the
 * content printers below and those of nested substitutions. A dynamic word, a
 * nested substitution or a script in it makes the use unnamed (round 2, rule 3).
 */
function subFiles(body: string, cwd: string | null, depth: number): SubRead {
  if (depth > MAX_DEPTH) return { files: [], unnamed: true };
  const res: SubRead = { files: [], unnamed: false };
  const add = (p: string) => {
    if (!res.files.includes(p)) res.files.push(p);
  };
  const r = shellTouches(body, cwd);
  if (r.script !== null || r.inline) res.unnamed = true;
  for (const t of r.touches) if (t.kind === "read" && !t.folder && t.path !== r.script) add(t.path);
  for (const item of riskSegments(body)) {
    if (typeof item === "string") continue;
    for (const w of wordsOf(item)) {
      if (varsOf(w) || subsOf(w).length > 0) res.unnamed = true;
      for (const nested of subsOf(w)) {
        const n = subFiles(nested, cwd, depth + 1);
        n.files.forEach(add);
        if (n.unnamed) res.unnamed = true;
      }
    }
    const [head, ...args] = commandWords(item.words);
    const printer = head && !head.dynamic ? PRINTERS.get(commandName(head.text) ?? "") : undefined;
    for (const w of printer?.(args) ?? [])
      if (!w.dynamic && w.text !== "" && !w.text.startsWith("-")) add(resolvePath(w.text, cwd));
  }
  return res;
}

// Commands that print a file's bytes, encoded or not, and that shell.ts does not read.
const PRINTERS = new Map<string, (args: Word[]) => Word[]>([
  [
    "base64",
    (a) => {
      // macOS reads `-i file`; GNU takes `-i` as a flag and the file as an operand.
      const p = parse(a, { short: "bwio", long: ["break", "wrap", "input", "output"] });
      return [...values(p, "-i", "--input"), ...p.operands];
    },
  ],
  ["xxd", xxdInput],
  [
    "od",
    (a) =>
      parse(a, {
        short: "AjNtS",
        optional: "w", // GNU `-w16`; a bare `-w` takes no value
        long: ["address-radix", "skip-bytes", "read-bytes", "format", "endian"],
      }).operands,
  ],
  ["hexdump", (a) => parse(a, { short: "efns" }).operands],
  ["strings", (a) => parse(a, { short: "nte" }).operands],
]);

// xxd reads each word as one option, `--x` as `-x`, and knows an option by its
// letter. `-s 16`, `-seek 16`, `--seek 16`, `-seekx 16` and `-group 2` take the
// next word: the word is the letter alone or starts with the long name. `-s16`
// and `-co` carry their value, `-ps` is a flag (as /usr/bin/xxd 2025-08-24 does).
const XXD_NEXT = new Map<string, string[]>([
  ["c", ["ols"]],
  ["g", ["roup"]],
  ["l", ["en"]],
  ["n", ["ame"]],
  ["o", ["ffset"]],
  ["s", ["eek", "kip"]],
  ["R", []],
]);

function xxdInput(args: Word[]): Word[] {
  const operands: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const s = shapeOf(args[k]) ?? args[k].text;
    if (s === "--") {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (!s.startsWith("-") || s === "-") {
      operands.push(args[k]);
      continue;
    }
    const o = s.startsWith("--") ? s.slice(1) : s;
    const tails = XXD_NEXT.get(o[1]);
    if (tails && (o.length === 2 || tails.some((t) => o.startsWith(t, 2)))) k++;
  }
  return operands.slice(0, 1); // the second operand is the output
}

const CURL: Spec = {
  short: "AbcCdDeEFHKmoPQrTtuUwxXyYz",
  long: [
    "data",
    "data-ascii",
    "data-binary",
    "data-raw",
    "data-urlencode",
    "json",
    "form",
    "form-string",
    "upload-file",
    "url",
    "request",
    "header",
    "output",
    "output-dir",
    "user",
    "user-agent",
    "referer",
    "cookie",
    "cookie-jar",
    "proxy",
    "proxy-user",
    "preproxy",
    "write-out",
    "max-time",
    "connect-timeout",
    "config",
    "cacert",
    "capath",
    "cert",
    "cert-type",
    "key",
    "key-type",
    "pass",
    "resolve",
    "connect-to",
    "retry",
    "retry-delay",
    "retry-max-time",
    "range",
    "continue-at",
    "dump-header",
    "oauth2-bearer",
    "limit-rate",
    "interface",
    "unix-socket",
    "abstract-unix-socket",
    "variable",
    "url-query",
    "aws-sigv4",
    "max-filesize",
    "max-redirs",
    "time-cond",
    "speed-limit",
    "speed-time",
    "quote",
    "telnet-option",
    "ftp-port",
    "local-port",
    "dns-servers",
    "doh-url",
    "proto",
    "proto-redir",
    "proxy-header",
    "socks5",
    "socks5-hostname",
    "netrc-file",
    "trace",
    "trace-ascii",
    "stderr",
    "mail-from",
    "mail-rcpt",
    "mail-auth",
    "request-target",
    "noproxy",
    "etag-save",
    "etag-compare",
  ],
};
const CURL_DATA = ["-d", "--data", "--data-ascii", "--data-binary", "--json"];
const CURL_FORM = ["-F", "--form"];
const CURL_UPLOAD = ["-T", "--upload-file"];

function curl(args: Word[], seg: Segment, cwd: string | null): NetworkUse {
  const p = parse(args, CURL);
  const u = networkUse("curl", firstHost([...values(p, "--url"), ...p.operands], true));
  let stdin = false;
  const file = (w: Word, text: string) => {
    if (text === "-" && !w.dynamic) stdin = true;
    else send(u, w, cwd, text);
  };
  for (const { name, value: w } of p.options) {
    if (!w) continue;
    if (CURL_UPLOAD.includes(name)) file(w, w.text === "." ? "-" : w.text);
    else if (CURL_DATA.includes(name) && w.text.startsWith("@")) file(w, w.text.slice(1));
    else if (CURL_DATA.includes(name) || name === "--data-raw") data(u, w, cwd);
    else if (name === "--data-urlencode") {
      const m = /^[^=@]*@(.*)$/s.exec(w.text);
      if (m) file(w, m[1]);
      else data(u, w, cwd);
    } else if (CURL_FORM.includes(name)) {
      const m = /^[^=]*=[@<]([^;]*)/s.exec(w.text);
      if (m) file(w, m[1]);
      else data(u, w, cwd);
    } else if (name === "-H" || name === "--header") {
      const s = shapeOf(w) ?? "";
      if (s.startsWith("@")) file(w, w.text.slice(1));
      else if (w.dynamic && (s === "" || s.startsWith(DYN))) u.sendsNamed = false; // can expand to `@file`
    } else if (name === "--url-query") {
      const m = /^[^=@]*@(.*)$/s.exec(w.text); // `@file` and `name@file`, as --data-urlencode
      if (m) file(w, m[1]);
      else if (w.dynamic && !literalPart(shapeOf(w) ?? "").includes("=")) u.sendsNamed = false;
    } else if ((name === "-b" || name === "--cookie") && !w.text.includes("="))
      file(w, w.text); // a cookie file
    else if (name === "--etag-compare") send(u, w, cwd); // the ETag it reads goes out as a header
  }
  if (stdin) sendStdin(u, seg, cwd);
  if (has(p, "-K", "--config")) u.sendsNamed = false; // a config file can hold more data and uploads
  return u;
}

const WGET: Spec = {
  short: "OoaPiUtTwQleBDRAIXn",
  long: [
    "post-file",
    "post-data",
    "body-file",
    "body-data",
    "method",
    "header",
    "output-document",
    "output-file",
    "append-output",
    "directory-prefix",
    "input-file",
    "user-agent",
    "tries",
    "timeout",
    "wait",
    "quota",
    "level",
    "execute",
    "base",
    "domains",
    "reject",
    "accept",
    "include-directories",
    "exclude-directories",
    "user",
    "password",
    "http-user",
    "http-password",
    "referer",
    "load-cookies",
    "save-cookies",
    "ca-certificate",
    "certificate",
    "private-key",
    "bind-address",
    "limit-rate",
    "proxy-user",
    "proxy-password",
    "dns-timeout",
    "connect-timeout",
    "read-timeout",
    "waitretry",
    "config",
  ],
};

function wget(args: Word[], _seg: Segment, cwd: string | null): NetworkUse {
  const p = parse(args, WGET);
  const u = networkUse("wget", firstHost(p.operands, true));
  for (const w of values(p, "--post-file", "--body-file", "--load-cookies")) send(u, w, cwd);
  if (has(p, "-i", "--input-file")) u.sendsNamed = false; // the requests are named in a file
  if (has(p, "--config")) u.sendsNamed = false; // a wgetrc can name uploads too
  // `-e` runs a wgetrc command; wgetrc ignores case, `-` and `_` in its names.
  for (const w of values(p, "-e", "--execute")) {
    const m = /^\s*([A-Za-z_-]+)\s*=\s*(.*?)\s*$/s.exec(w.text);
    const command = m?.[1].toLowerCase().replace(/[-_]/g, "");
    if (m && (command === "postfile" || command === "bodyfile")) send(u, part(w, m[2]), cwd);
    else u.sendsNamed = false;
  }
  return u;
}

const HTTPIE: Spec = {
  short: "aAops",
  long: [
    "auth",
    "auth-type",
    "output",
    "print",
    "style",
    "session",
    "session-read-only",
    "verify",
    "cert",
    "cert-key",
    "cert-key-pass",
    "timeout",
    "proxy",
    "max-redirects",
    "max-headers",
    "boundary",
    "raw",
    "format-options",
    "response-charset",
    "response-mime",
    "ssl",
    "ciphers",
    "default-scheme",
    "pretty",
  ],
};
// httpie request items that read a file: `field@file`, `field=@file`, `field:=@file`, `@file`.
const HTTPIE_FILE = /^[^=:@]*(?::=@|=@|@)(.+)$/s;

/** httpie, as `http` or `https`. */
function httpie(tool: string): NetRule {
  return (args, seg, cwd) => {
    const p = parse(args, HTTPIE);
    const ops = p.operands;
    const method = ops.length > 1 && !ops[0].dynamic && /^[A-Za-z]+$/.test(ops[0].text) ? 1 : 0;
    const u = networkUse(tool, firstHost(ops.slice(method, method + 1), true));
    for (const w of ops.slice(method + 1)) {
      const m = HTTPIE_FILE.exec(w.text);
      if (m) send(u, w, cwd, m[1]);
    }
    if (!has(p, "-I", "--ignore-stdin")) sendStdin(u, seg, cwd);
    return u;
  };
}

const SCP: Spec = { short: "cDFiJloPSX" };
const SFTP: Spec = { short: "BbcDFiJloPRSsX" };
const RSYNC: Spec = {
  short: "efBTM@",
  long: [
    "exclude",
    "include",
    "filter",
    "exclude-from",
    "include-from",
    "files-from",
    "rsh",
    "rsync-path",
    "password-file",
    "log-file",
    "log-file-format",
    "port",
    "chmod",
    "chown",
    "usermap",
    "groupmap",
    "backup-dir",
    "suffix",
    "compare-dest",
    "copy-dest",
    "link-dest",
    "partial-dir",
    "temp-dir",
    "timeout",
    "contimeout",
    "bwlimit",
    "max-size",
    "min-size",
    "max-delete",
    "block-size",
    "remote-option",
    "out-format",
    "info",
    "debug",
    "iconv",
    "address",
    "sockopts",
    "modify-window",
    "checksum-choice",
    "compress-choice",
    "compress-level",
    "skip-compress",
    "outbuf",
  ],
};

/** scp and rsync: local sources are sent when the target is remote; no remote side, no network. */
function copy(tool: string, spec: Spec): NetRule {
  return (args, _seg, cwd) => {
    const p = parse(args, spec);
    const ops = p.operands;
    if (!ops.some((w) => isRemote(w) || w.dynamic)) return null;
    const u = networkUse(tool, firstHost(ops));
    const target = ops[ops.length - 1];
    if (ops.length > 1 && (isRemote(target) || target.dynamic)) {
      for (const s of ops.slice(0, -1)) if (!isRemote(s)) send(u, s, cwd);
    }
    if (has(p, "--files-from")) u.sendsNamed = false;
    return u;
  };
}

/** sftp moves the files its session or batch file names, never the line. */
function sftp(args: Word[]): NetworkUse {
  return networkUse("sftp", destination(parse(args, SFTP).operands[0]), false);
}

const SSH: Spec = { short: "BbcDEeFIiJLlmOoPpQRSWw" };

function ssh(args: Word[], seg: Segment, cwd: string | null): NetworkUse {
  const u = networkUse("ssh", destination(parse(args, SSH).operands[0]));
  sendStdin(u, seg, cwd);
  return u;
}

const NC: Spec = {
  short: "cegGIiMmOoPpsTVWwXx",
  long: [
    "exec",
    "sh-exec",
    "lua-exec",
    "proxy",
    "proxy-type",
    "proxy-auth",
    "source",
    "source-port",
    "wait",
    "idle-timeout",
    "output",
    "hex-dump",
    "allow",
    "allowfile",
    "deny",
    "denyfile",
    "max-conns",
  ],
};

function nc(tool: string): NetRule {
  return (args, seg, cwd) => {
    const p = parse(args, NC);
    const listen = has(p, "-l", "--listen");
    const target = p.operands[0];
    const u = networkUse(tool, listen || !target || target.dynamic ? null : target.text);
    sendStdin(u, seg, cwd);
    return u;
  };
}

const TELNET: Spec = { short: "beklnSX" };

function telnet(args: Word[], seg: Segment, cwd: string | null): NetworkUse {
  const target = parse(args, TELNET).operands[0];
  const u = networkUse("telnet", !target || target.dynamic ? null : target.text);
  sendStdin(u, seg, cwd);
  return u;
}

const GIT: Spec = {
  short: "Cc",
  long: ["git-dir", "work-tree", "namespace", "config-env"],
  posix: true,
};
const PUSH: Spec = { short: "o", long: ["repo", "receive-pack", "exec", "push-option"] };

function git(args: Word[]): NetworkUse | null {
  const [sub, ...rest] = parse(args, GIT).operands;
  if (sub?.text !== "push") return null;
  const p = parse(rest, PUSH);
  // Only the repository names a host; a refspec such as `HEAD:main` looks like a remote spec.
  return networkUse("git push", firstHost([...values(p, "--repo"), ...p.operands.slice(0, 1)]), false);
}

const NPM: Spec = {
  short: "w",
  long: ["registry", "tag", "access", "otp", "workspace", "prefix", "userconfig", "cache"],
};

function npm(args: Word[]): NetworkUse | null {
  const p = parse(args, NPM);
  if (p.operands[0]?.text !== "publish") return null;
  // A registry is a URL: a value that starts with a dynamic piece names no host.
  const host = values(p, "--registry")
    .map((w) => hostOf(w, true))
    .find((h) => h !== null);
  return networkUse("npm publish", host ?? null, false);
}

const NETWORK = new Map<string, NetRule>([
  ["curl", curl],
  ["wget", wget],
  ["http", httpie("http")],
  ["https", httpie("https")],
  ["scp", copy("scp", SCP)],
  ["rsync", copy("rsync", RSYNC)],
  ["sftp", sftp],
  ["ssh", ssh],
  ["nc", nc("nc")],
  ["ncat", nc("ncat")],
  ["telnet", telnet],
  ["git", git],
  ["npm", npm],
]);

// Values in credential positions (card 605, final wave item 1b). The report
// masks them by position, because a value of any shape can stand there.

/**
 * For each character of a literal word's text, its index in `src`, the word's
 * source: quotes and backslashes taken out as the tokenizer takes them out.
 * Null for a form this does not follow (`$'...'`), or when the result does
 * not spell `text`.
 */
function sourceIndex(src: string, text: string): number[] | null {
  const map: number[] = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] !== "\n" && i + 1 < src.length) map.push(i + 1);
      i += 2;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close < 0 ? src.length : close;
      for (let k = i + 1; k < stop; k++) map.push(k);
      i = stop + 1;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && '$`"\\\n'.includes(src[i + 1] ?? "")) {
          if (src[i + 1] !== "\n") map.push(i + 1);
          i += 2;
        } else map.push(i++);
      }
      i++;
    } else if (c === "$") return null;
    else map.push(i++);
  }
  if (map.length !== text.length) return null;
  for (let k = 0; k < map.length; k++) if (src[map[k]] !== text[k]) return null;
  return map;
}

/**
 * The range of `w`'s text [from, to) in the line. `exact` when the line spells
 * that text as one run (plainly or inside one pair of quotes). A range the
 * quoting splits runs on over the quote that closes it; a dynamic word, or one
 * whose quoting this does not follow, is the whole word.
 */
function textRange(
  w: Word,
  ctx: Ctx,
  from: number,
  to: number,
): { start: number; end: number; exact: boolean } | null {
  if (w.start === undefined || w.end === undefined) return null;
  const whole = { start: w.start, end: w.end, exact: false };
  if (w.dynamic) return whole;
  const map = sourceIndex(ctx.line.slice(w.start, w.end), w.text);
  if (map === null) return whole;
  if (from >= to)
    return {
      start: w.start + (map[from] ?? w.end - w.start),
      end: w.start + (map[from] ?? w.end - w.start),
      exact: true,
    };
  let exact = true;
  for (let k = from + 1; k < to; k++) if (map[k] !== map[k - 1] + 1) exact = false;
  let end = w.start + map[to - 1] + 1;
  if (!exact) while (end < w.end && !map.includes(end - w.start)) end++;
  return { start: w.start + map[from], end, exact };
}

function addValue(
  out: ShellRisk,
  ctx: Ctx,
  start: number,
  end: number,
  value: string,
  secret: string,
  named: boolean,
): void {
  const [s, e] = "at" in ctx.place ? [ctx.place.at + start, ctx.place.at + end] : ctx.place.span;
  const known = out.values.find((v) => v.start === s && v.end === e);
  if (known === undefined) out.values.push({ start: s, end: e, value, secret, named });
  else if (named) known.named = true;
}

/** The words that say a query parameter holds a credential, alone or as a word of its name (task 11 item 11). */
export const CREDENTIAL_NAME_WORDS: readonly string[] = [
  "key",
  "token",
  "secret",
  "pass",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "auth",
  "authorization",
  "sig",
  "signature",
  "session",
  "sid",
  "code",
  "credential",
  "bearer",
];
/** Joined forms of those words that a name writes as one word. */
export const CREDENTIAL_NAME_JOINED: readonly string[] = [
  "apikey",
  "accesskey",
  "accesstoken",
  "authtoken",
  "secretkey",
  "sessionid",
];
const CREDENTIAL_WORDS = new Set([...CREDENTIAL_NAME_WORDS, ...CREDENTIAL_NAME_JOINED]);
/** The words beside which `key` and `code` name a credential; alone they do too (fix round 2 item 4). */
export const KEY_PARTNERS: readonly string[] = [
  "api",
  "access",
  "secret",
  "private",
  "auth",
  "client",
  "master",
  "signing",
  "encryption",
];
export const CODE_PARTNERS: readonly string[] = [
  "auth",
  "authorization",
  "otp",
  "verification",
  "access",
  "refresh",
  "device",
  "oauth",
];
const PARTNERS = new Map<string, ReadonlySet<string>>([
  ["key", new Set(KEY_PARTNERS)],
  ["code", new Set(CODE_PARTNERS)],
]);

/**
 * Whether a query parameter's name says it holds a credential: a word of it,
 * split at every character that is not a letter and at a case change
 * (`apiKey`, `X-Api-Key`, `access_token`), is one of the words, or the word
 * with a plural `s`. `side` and `zipcode` say nothing (task 11 item 11).
 */
export function saysCredential(name: string): boolean {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase())
    .map((w) => (w.endsWith("s") && CREDENTIAL_WORDS.has(w.slice(0, -1)) ? w.slice(0, -1) : w));
  return words.some((w) => {
    if (!CREDENTIAL_WORDS.has(w)) return false;
    // `key` and `code` alone, or beside a word that says what they open (fix round 2 item 4).
    const partners = PARTNERS.get(w);
    return partners === undefined || words.length === 1 || words.some((x) => partners.has(x));
  });
}

const AUTH_SCHEME = /^\s*(?:bearer|basic|token|digest|negotiate|bot)\s+/i;

/**
 * Records the text [from, to) of `holder` as a credential value, or counts it
 * as a placeholder: a value the line does not spell (a variable), and a B4
 * placeholder. `shape` is the value with each dynamic piece as DYN (the text
 * itself for a literal word). `kind` says where the secret part is: after the
 * first `:` of a `user:password`, after the scheme word of a header, or the
 * whole value (a `query` value too). A dynamic holder is masked as a whole
 * word. A query value names a credential only when `name` (the parameter's
 * name) says so, and a user only with a password after its colon.
 */
function secretValue(
  out: ShellRisk,
  ctx: Ctx,
  holder: Word,
  from: number,
  to: number,
  shape: string,
  kind: "user" | "header" | "plain" | "query",
  name: string | null = null,
): void {
  let secret = shape;
  const colon = shape.indexOf(":");
  // A user before an empty password is the credential: a token given as the user (fix round 2 item 5).
  if (kind === "user" && colon >= 0)
    secret = colon + 1 < shape.length ? shape.slice(colon + 1) : shape.slice(0, colon);
  // A query value counts by its name, a user value by the password after its colon (task 11 item 11).
  const named =
    kind === "query" ? name !== null && saysCredential(name) : kind === "user" ? colon >= 0 : true;
  if (kind === "header") secret = secret.replace(AUTH_SCHEME, "");
  const literal = secret.split(DYN).join("").trim();
  const value = shape.split(DYN).join("");
  if (literal === "" || isPlaceholder("position", value) || isPlaceholder("position", literal)) {
    // Only a value that counts by its name is a placeholder of a credential (task 11 item 10).
    if (named) out.placeholders++;
    return;
  }
  const r = textRange(holder, ctx, from, to);
  if (r !== null) addValue(out, ctx, r.start, r.end, value, secret.split(DYN).join("").trim(), named);
}

/** A word's shape, or its text when it is literal; DYN for a dynamic word of unknown pieces. */
const shapeText = (w: Word): string => shapeOf(w) ?? DYN;

/** curl's option names that join a credential word to another, which the word rule would miss. */
export const COMPOUND_OPTIONS: readonly string[] = ["tlspassword", "proxy-tlspassword"];
/** Options whose name says key and whose value is a path or a type (task 11 item 3e). */
const KEY_FILE_OPTIONS = new Set(["key", "key-type", "pubkey", "pinnedpubkey"]);
/** An option whose name says credential by its words (saysCredential), or one of curl's compound names. */
const secretOption = (name: string): boolean =>
  !KEY_FILE_OPTIONS.has(name.toLowerCase()) &&
  (COMPOUND_OPTIONS.includes(name.toLowerCase()) || saysCredential(name));
/** Cookie, and a header whose name says credential by its words (Authorization, X-Api-Key). */
const secretHeader = (name: string): boolean => name.toLowerCase() === "cookie" || saysCredential(name);
const HEADER_NAME = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*/;

const VALUE_SPECS = new Map<string, Spec>([
  ["curl", CURL],
  ["wget", WGET],
  ["http", HTTPIE],
  ["https", HTTPIE],
  ["scp", SCP],
  ["rsync", RSYNC],
  ["sftp", SFTP],
  ["ssh", SSH],
  ["nc", NC],
  ["ncat", NC],
  ["telnet", TELNET],
  ["npm", NPM],
]);
const USER_OPTIONS = new Map<string, string[]>([
  ["curl", ["-u", "--user", "-U", "--proxy-user"]],
  ["wget", ["--user", "--http-user", "--proxy-user"]],
  ["http", ["-a", "--auth"]],
  ["https", ["-a", "--auth"]],
]);
const HEADER_OPTIONS = new Map<string, string[]>([
  ["curl", ["-H", "--header", "--proxy-header"]],
  ["wget", ["--header"]],
]);

/** The values in credential positions of one network command. */
function positionValues(name: string, args: Word[], ctx: Ctx, out: ShellRisk): void {
  let words = args;
  let spec = VALUE_SPECS.get(name);
  if (name === "git") {
    words = parse(args, GIT).operands.slice(1);
    spec = PUSH;
  }
  if (spec === undefined) return;
  const p = parse(words, spec);
  const user = USER_OPTIONS.get(name) ?? [];
  const header = HEADER_OPTIONS.get(name) ?? [];
  for (const o of p.options) {
    if (!o.value) continue;
    const holder = o.inline ? o.from : o.value;
    const from = o.inline ? o.from.text.length - o.value.text.length : 0;
    const to = holder.text.length;
    const shape = shapeText(o.value);
    if (user.includes(o.name)) secretValue(out, ctx, holder, from, to, shape, "user");
    else if (name === "curl" && o.name === "--oauth2-bearer")
      // A bearer token, not a user: it counts whole.
      secretValue(out, ctx, holder, from, to, shape, "plain");
    else if (header.includes(o.name)) headerValue(out, ctx, holder, from, shape);
    else if (name === "curl" && (o.name === "-b" || o.name === "--cookie") && shape.includes("="))
      secretValue(out, ctx, holder, from, to, shape, "plain");
    else if (name === "curl" && o.name === "--url-query") {
      const eq = shape.indexOf("=");
      if (eq >= 0 && shape[eq + 1] !== "@" && eq + 1 < shape.length)
        secretValue(out, ctx, holder, from + eq + 1, to, shape.slice(eq + 1), "query", shape.slice(0, eq));
    } else if (o.name.startsWith("--") && secretOption(o.name.slice(2)))
      secretValue(out, ctx, holder, from, to, shape, "plain");
  }
  // A long option the tool's table does not list still takes the next word when its name says secret.
  for (let k = 0; k + 1 < words.length; k++) {
    const t = words[k].text;
    if (!t.startsWith("--") || t.includes("=") || !secretOption(t.slice(2))) continue;
    if (spec.long?.includes(t.slice(2))) continue;
    const next = words[k + 1];
    if (next.text.startsWith("-") || SCHEME.test(next.text)) continue;
    secretValue(out, ctx, next, 0, next.text.length, shapeText(next), "plain");
  }
  for (const w of words) urlValues(out, ctx, w);
  if (name === "http" || name === "https") {
    for (const w of p.operands) {
      const t = shapeText(w);
      const h = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):(?![=@])/.exec(t);
      if (h && secretHeader(h[1])) headerValue(out, ctx, w, 0, t);
      const q = /^[^=:@]+==/.exec(t);
      if (q)
        secretValue(
          out,
          ctx,
          w,
          q[0].length,
          w.text.length,
          t.slice(q[0].length),
          "query",
          q[0].slice(0, -2),
        );
    }
  }
}

/** The value of a header with a secret name, after `Name:`. `shape` is the holder's shape from `from` on. */
function headerValue(out: ShellRisk, ctx: Ctx, holder: Word, from: number, shape: string): void {
  const m = HEADER_NAME.exec(shape);
  if (!m || !secretHeader(m[1]) || shape.length === m[0].length) return;
  secretValue(out, ctx, holder, from + m[0].length, holder.text.length, shape.slice(m[0].length), "header");
}

/** A URL's userinfo (a user without a colon too) and each query value. */
function urlValues(out: ShellRisk, ctx: Ctx, w: Word): void {
  const t = shapeText(w);
  const scheme = SCHEME.exec(t);
  if (!scheme) return;
  const authStart = scheme[0].length;
  const tail = t.slice(authStart).search(/[/?#]/);
  const authEnd = tail < 0 ? t.length : authStart + tail;
  const at = t.lastIndexOf("@", authEnd - 1);
  if (at > authStart) secretValue(out, ctx, w, authStart, at, t.slice(authStart, at), "user");
  const q = t.indexOf("?", authEnd);
  if (q < 0) return;
  const hash = t.indexOf("#", q);
  const end = hash < 0 ? t.length : hash;
  for (let start = q + 1; start < end;) {
    const amp = t.indexOf("&", start);
    const stop = amp < 0 || amp > end ? end : amp;
    const eq = t.indexOf("=", start);
    if (eq >= 0 && eq + 1 < stop)
      secretValue(out, ctx, w, eq + 1, stop, t.slice(eq + 1, stop), "query", t.slice(start, eq));
    start = stop + 1;
  }
}

// Options that name where the output goes; a substitution there sends nothing (subSends).
const CURL_OUT = new Set([
  "-o",
  "--output",
  "--output-dir",
  "-O",
  "-D",
  "--dump-header",
  "-c",
  "--cookie-jar",
  "--etag-save",
  "--stderr",
]);
const WGET_OUT = new Set([
  "-O",
  "--output-document",
  "-o",
  "--output-file",
  "-a",
  "--append-output",
  "-P",
  "--directory-prefix",
  "--save-cookies",
]);
const HTTPIE_OUT = new Set(["-o", "--output"]);
const OUTPUTS = new Map<string, { spec: Spec; is: (name: string) => boolean }>([
  ["curl", { spec: CURL, is: (n) => CURL_OUT.has(n) || n.startsWith("--trace") }],
  ["wget", { spec: WGET, is: (n) => WGET_OUT.has(n) }],
  ["http", { spec: HTTPIE, is: (n) => HTTPIE_OUT.has(n) }],
  ["https", { spec: HTTPIE, is: (n) => HTTPIE_OUT.has(n) }],
]);
