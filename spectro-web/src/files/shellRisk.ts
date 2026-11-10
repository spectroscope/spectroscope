// Card 605: environment dumps and network commands in one shell line, for the
// files report (design section 3 and call B7). It reads the simple commands of
// the shell heuristic's tokenizer (shellTokens.ts), so quoted text and heredoc
// bodies are never commands. The body of a `$(...)`, backtick or `<(...)`
// substitution is read as a line of its own. A `cd` inside the line is not
// followed: every path resolves against `cwd`.

import { resolvePath } from "./paths";
import { shellTouches } from "./shell";
import { segments, type Heredoc, type Segment, type Word } from "./shellTokens";

export interface NetworkUse {
  tool: string; // "curl", "git push", "npm publish", ...
  host: string | null; // as written, without user and port; null when the line does not name it
  sends: string[]; // local files the command sends, resolved against cwd
  sendsNamed: boolean; // false when it also sends files the line does not name (B7)
}

export interface ShellRisk {
  envDump: string | null; // the first command that printed the environment or a stored secret
  network: NetworkUse[];
}

export function shellRisk(command: string, cwd: string | null): ShellRisk {
  const out: ShellRisk = { envDump: null, network: [] };
  readLine(command, cwd, out, 0);
  return out;
}

// How deep substitutions, wrappers and `sh -c` lines are followed.
const MAX_DEPTH = 4;

function readLine(line: string, cwd: string | null, out: ShellRisk, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const item of riskSegments(line)) {
    if (item === "(" || item === ")") continue;
    readSubs(item, cwd, out, depth); // a substitution runs before the command that holds it
    run(item.words, item, cwd, out, depth);
  }
}

/** Reads the substitutions of a segment as lines; an arithmetic body only for the substitutions in it. */
function readSubs(item: Segment, cwd: string | null, out: ShellRisk, depth: number): void {
  for (const w of wordsOf(item)) {
    for (const body of subsOf(w)) readLine(body, cwd, out, depth + 1);
    for (const body of arithOf(w)) {
      if (depth + 1 > MAX_DEPTH) continue;
      for (const inner of riskSegments(body))
        if (typeof inner !== "string") readSubs(inner, cwd, out, depth + 1);
    }
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
// their words, with the literal text before the first dynamic piece.

/**
 * A word with what made it dynamic: `subs` are the bodies of its command
 * substitutions, `arith` of its `$((...))`, `vars` is true for a variable or
 * parameter, `prefix` is the literal text before the first dynamic piece.
 */
type SWord = Word & { subs?: string[]; arith?: string[]; vars?: boolean; prefix?: string };
const subsOf = (w: Word): string[] => (w as SWord).subs ?? [];
const arithOf = (w: Word): string[] => (w as SWord).arith ?? [];
const varsOf = (w: Word): boolean => (w as SWord).vars ?? w.dynamic;
const prefixOf = (w: Word): string | null => (w.dynamic ? ((w as SWord).prefix ?? null) : w.text);

const OPEN = "\uE000"; // a substitution: OPEN, its index, CLOSE
const CLOSE = "\uE001";
const VAR = "\uE002"; // a variable or parameter
const MARK = /\uE000(\d+)\uE001|\uE002/g;
const HAS_DYNAMIC = /[`$]|[<>]\(/;
const META = " \t\r\n;&|()<>";
const OPERATORS = ["<<<", "<<-", "&>>", ">>", "<<", "<>", "<&", ">&", ">|", "&>"];

/** segments() with what made each word dynamic kept on it (see SWord). */
export function riskSegments(command: string): (Segment | "(" | ")")[] {
  if (!HAS_DYNAMIC.test(command) || /[\uE000-\uE002]/.test(command)) return segments(command);
  const docs = segments(command).flatMap((s) => (typeof s === "string" ? [] : s.docs));
  const bodies: { text: string; arith: boolean }[] = [];
  const unmask = (w: Word): Word => {
    const first = w.text.search(/[\uE000\uE002]/);
    if (first < 0) return w;
    const subs: string[] = [];
    const arith: string[] = [];
    let vars = w.dynamic;
    const text = w.text.replace(MARK, (m, n?: string) => {
      if (m === VAR) vars = true;
      else if (bodies[Number(n)].arith) arith.push(bodies[Number(n)].text);
      else subs.push(bodies[Number(n)].text);
      return "";
    });
    const out: SWord = { ...w, text, dynamic: true, vars, subs, arith, prefix: w.text.slice(0, first) };
    return out;
  };
  return segments(mask(command, docs, bodies)).map((s) =>
    typeof s === "string"
      ? s
      : {
          ...s,
          words: s.words.map(unmask),
          redirects: s.redirects.map((r) => ({ ...r, target: r.target && unmask(r.target) })),
        },
  );
}

function mask(src: string, docs: Heredoc[], bodies: { text: string; arith: boolean }[]): string {
  let out = "";
  let i = 0;
  let pending = 0; // heredocs whose body starts after the next newline
  let next = 0; // the next of `docs`, in the tokenizer's order
  let delimiter = false; // inside a heredoc delimiter word, which stays as written
  const copy = (end: number) => {
    out += src.slice(i, end);
    i = end;
  };
  const sub = (end: number, body: string, arith = false) => {
    if (delimiter) return copy(end);
    out += OPEN + String(bodies.push({ text: body, arith }) - 1) + CLOSE;
    i = end;
  };
  const variable = (end: number) => {
    if (delimiter) return copy(end);
    out += VAR;
    i = end;
  };
  const dollar = (inDouble: boolean) => {
    const n = src[i + 1];
    if (n === "(") {
      // `$((...))` is arithmetic: kept apart, never read as a command line.
      const b = balanced(src, i + 1);
      sub(b.end, src.slice(i + 2, b.closed ? b.end - 1 : src.length), src[i + 2] === "(");
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
    sub(j + 1, src.slice(i + 1, Math.min(j, src.length)));
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
      if (!delimiter) out += " ";
      const b = balanced(src, i + 1);
      sub(b.end, src.slice(i + 2, b.closed ? b.end - 1 : src.length));
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
  return out;
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

function run(words: Word[], seg: Segment, cwd: string | null, out: ShellRisk, depth: number): void {
  const [head, ...args] = commandWords(words);
  if (!head || head.dynamic || depth > MAX_DEPTH) return;
  const name = commandName(head.text);
  if (name === null) return;
  if (name === "env") {
    const rest = parse(args, ENV).operands;
    if (commandWords(rest).length === 0) dumped(out, "env");
    else run(rest, seg, cwd, out, depth + 1);
    return;
  }
  const wrapper = WRAPPERS.get(name);
  if (wrapper) {
    const p = parse(args, wrapper);
    if (name === "command" && has(p, "-v", "-V")) return; // a lookup, not a run
    return run(p.operands.slice(wrapper.skip ?? 0), seg, cwd, out, depth + 1);
  }
  if (SHELLS.has(name)) {
    const p = parse(args, SHELL);
    const script = p.operands[0];
    if (has(p, "-c") && script && !script.dynamic) readLine(script.text, cwd, out, depth + 1);
    return;
  }
  const dump = dumpOf(name, args);
  if (dump !== null) dumped(out, dump);
  const found = NETWORK.get(name)?.(args, seg, cwd);
  if (found) {
    subSends(found, name, args, seg, cwd);
    out.network.push(found);
  }
}

function dumped(out: ShellRisk, what: string): void {
  if (out.envDump === null) out.envDump = what;
}

// Options: a small getopt that keeps every option in order (curl repeats -T and -d).

interface Spec {
  short?: string; // short options that take a value
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
// and the part of its literal prefix that falls into the value.
const part = (w: Word, text: string): Word => {
  const prefix = (w as SWord).prefix;
  const cut = w.text.length - text.length;
  const out: SWord = { ...w, text };
  if (prefix !== undefined) out.prefix = prefix.length >= cut ? prefix.slice(cut) : "";
  return out;
};

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
        if (!spec.short?.includes(t[q])) {
          options.push({ name: "-" + t[q], value: null, from: a, inline: false });
          continue;
        }
        const inline = q + 1 < t.length;
        const value = inline ? part(a, t.slice(q + 1)) : (args[++k] ?? null);
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
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL: Spec = { short: "o", long: ["rcfile", "init-file"], posix: true };

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
const REMOTE_HOST = /^(?:[^@/:]*@)?(\[[^\]/]*\]|[^:/@\s]+):/;
// curl, wget and httpie take a target without a scheme: `example.com/api`.
const BARE_HOST =
  /^(?:[^@/:\s]+@)?(localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\[[0-9A-Fa-f:.]+\])(?::\d+)?(?:[/?#]|$)/;

// A dynamic word is read up to its first dynamic piece (prefixOf).
const isRemote = (w: Word) => {
  const t = prefixOf(w);
  return t !== null && (URL_HOST.test(t) || REMOTE_HOST.test(t));
};

function hostOf(w: Word | null | undefined, bare = false): string | null {
  const t = w ? prefixOf(w) : null;
  if (t === null) return null;
  const m = URL_HOST.exec(t) ?? REMOTE_HOST.exec(t) ?? (bare ? BARE_HOST.exec(t) : null);
  if (!m || m[1] === "") return null;
  // The host must end before the first dynamic piece: `https://h$X` names no host.
  if (w?.dynamic && m[0].length === t.length && !/[:/?#]$/.test(m[0])) return null;
  return m[1];
}

/** The host of the first word that names one; with `bare`, a later pass takes a target without a scheme. */
function firstHost(words: Word[], bare = false): string | null {
  for (const w of words) {
    const h = hostOf(w);
    if (h !== null) return h;
  }
  if (!bare) return null;
  for (const w of words) {
    const h = hostOf(w, true);
    if (h !== null) return h;
  }
  return null;
}

/** The host of an ssh destination: `[user@]host`, `[user@]host:path` or `ssh://...`. */
function destination(w: Word | undefined): string | null {
  if (!w || w.dynamic) return null;
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
  ["xxd", (a) => parse(a, { short: "cgl" }).operands.slice(0, 1)], // the second operand is the output
  ["od", (a) => parse(a, { short: "AjNt" }).operands],
  ["hexdump", (a) => parse(a, { short: "efns" }).operands],
  ["strings", (a) => parse(a, { short: "nte" }).operands],
]);

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
    } else if ((name === "-H" || name === "--header") && w.text.startsWith("@")) file(w, w.text.slice(1));
    else if (name === "--url-query") {
      const m = /^[^=@]*@(.*)$/s.exec(w.text); // `@file` and `name@file`, as --data-urlencode
      if (m) file(w, m[1]);
    }
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
  for (const w of values(p, "--post-file", "--body-file")) send(u, w, cwd);
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
  return networkUse("npm publish", firstHost(values(p, "--registry")), false);
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

// Options that name where the output goes; a substitution there sends nothing (subSends).
const CURL_OUT = new Set(["-o", "--output", "-O", "-D", "--dump-header", "-c", "--cookie-jar", "--stderr"]);
const WGET_OUT = new Set([
  "-O",
  "--output-document",
  "-o",
  "--output-file",
  "-a",
  "--append-output",
  "-P",
  "--directory-prefix",
]);
const HTTPIE_OUT = new Set(["-o", "--output"]);
const OUTPUTS = new Map<string, { spec: Spec; is: (name: string) => boolean }>([
  ["curl", { spec: CURL, is: (n) => CURL_OUT.has(n) || n.startsWith("--trace") }],
  ["wget", { spec: WGET, is: (n) => WGET_OUT.has(n) }],
  ["http", { spec: HTTPIE, is: (n) => HTTPIE_OUT.has(n) }],
  ["https", { spec: HTTPIE, is: (n) => HTTPIE_OUT.has(n) }],
]);
