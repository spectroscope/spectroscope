// Card 604: the shell heuristic of the files tab. It reads one shell command
// and names the files the command probably read or changed. It never sees the
// command's output, so every touch it returns is a guess the view tags as
// probable. The rule table follows section 2 of the design document
// (docs/superpowers/specs/2026-11-09-files-tab-design.md).

import { resolvePath } from "./paths";

export type TouchKind =
  "read" | "create" | "change" | "overwrite" | "write" | "append" | "delete" | "unknown";

export interface ShellTouch {
  written: string; // the path as the command spells it, quotes removed
  path: string; // resolvePath(written, base at that point of the line)
  folder: boolean; // a folder or a pattern, not one file
  kind: TouchKind;
  reason: string; // rule name plus the matched fragment, e.g. "redirect > out.txt"
  replaced?: { old: string; new: string }[];
  content?: string;
  appended?: string;
}

export interface ShellReading {
  touches: ShellTouch[];
  script: string | null; // resolved path of the first script file the command runs
  inline: boolean; // an interpreter ran code given on the line or on stdin
}

export function shellTouches(command: string, cwd: string | null): ShellReading {
  const out: ShellReading = { touches: [], script: null, inline: false };
  const outer: (string | null)[] = [];
  let base = cwd;
  for (const item of group(lex(command))) {
    if (item === "(") outer.push(base);
    else if (item === ")") base = outer.length > 0 ? (outer.pop() ?? null) : base;
    else base = segment(item, base, out);
  }
  return out;
}

// Tokenizer.

interface Word {
  text: string; // the value after quote removal
  dynamic: boolean; // holds a variable or a substitution, so the value is unknown
  glob: boolean; // holds an unquoted pattern character
  quoted?: boolean;
}
interface Heredoc {
  strip: boolean;
  delimiter: string;
  body: string;
}
type Tok =
  | { k: "word"; w: Word }
  | { k: "op"; op: string }
  | { k: "redir"; op: string; fd: number | null }
  | { k: "doc"; doc: Heredoc };

const OPS = ["<<<", "<<-", "&>>", ">>", "<<", "<>", "<&", ">&", ">|", "&>", "&&", "||", "|&", ";;"];
const META = " \t\r\n;&|()<>";

function opAt(src: string, i: number): string | null {
  for (const op of OPS) if (src.startsWith(op, i)) return op;
  return "><|&;()".includes(src[i]) ? src[i] : null;
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let pending: Heredoc[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === "\n") i += 2;
    else if (c === " " || c === "\t" || c === "\r") i++;
    else if (c === "\n") {
      toks.push({ k: "op", op: "\n" });
      // A heredoc body is text up to its terminator and is never lexed.
      i = readBodies(src, i + 1, pending);
      pending = [];
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "(" && src[i + 1] === "(") {
      i = skipBalanced(src, i); // `(( a > b ))` is arithmetic, not a redirect
    } else {
      let op = (c === "<" || c === ">") && src[i + 1] === "(" ? null : opAt(src, i);
      let fd: number | null = null;
      if (op === null) {
        const [w, j] = readWord(src, i);
        const after = opAt(src, j);
        if (!w.quoted && /^\d+$/.test(w.text) && after && /^[<>]/.test(after) && src[j + 1] !== "(") {
          fd = Number(w.text);
          op = after;
          i = j;
        } else {
          toks.push({ k: "word", w });
          i = j;
          continue;
        }
      }
      i += op.length;
      if (op === "<<" || op === "<<-") {
        while (src[i] === " " || src[i] === "\t") i++;
        const [d, j] = readWord(src, i);
        i = j;
        const doc = { strip: op === "<<-", delimiter: d.text, body: "" };
        pending.push(doc);
        toks.push({ k: "doc", doc });
      } else if (/[<>]/.test(op)) toks.push({ k: "redir", op, fd });
      else toks.push({ k: "op", op });
    }
  }
  return toks;
}

function readBodies(src: string, i: number, docs: Heredoc[]): number {
  for (const doc of docs) {
    let body = "";
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      const line = doc.strip ? src.slice(i, end).replace(/^\t+/, "") : src.slice(i, end);
      i = nl === -1 ? src.length : nl + 1;
      if (line === doc.delimiter) break;
      body += line + "\n";
    }
    doc.body = body;
  }
  return i;
}

function readWord(src: string, start: number): [Word, number] {
  let text = "";
  let dynamic = false;
  let glob = false;
  let quoted = false;
  let brace = false;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if ((c === "<" || c === ">") && src[i + 1] === "(" && i === start) {
      i = skipBalanced(src, i + 1);
      dynamic = true;
    } else if (META.includes(c)) break;
    else if (c === "\\") {
      if (src[i + 1] !== "\n") text += src[i + 1] ?? "";
      quoted = true;
      i += 2;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const end = e === -1 ? src.length : e;
      text += src.slice(i + 1, end);
      quoted = true;
      i = end + 1;
    } else if (c === '"') {
      quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === "\\" && '$`"\\\n'.includes(src[i + 1] ?? "")) {
          if (src[i + 1] !== "\n") text += src[i + 1];
          i += 2;
        } else if (d === "$" || d === "`") {
          const [e, lit]: [number, string | null] =
            d === "$" ? dollar(src, i, true) : [skipTick(src, i), null];
          if (lit === null) dynamic = true;
          else text += lit;
          i = e;
        } else {
          text += d;
          i++;
        }
      }
      i++;
    } else if (c === "$" || c === "`") {
      const [e, lit]: [number, string | null] = c === "$" ? dollar(src, i, false) : [skipTick(src, i), null];
      if (lit === null) dynamic = true;
      else text += lit;
      if (c === "$" && src[i + 1] === "'") quoted = true;
      i = e;
    } else {
      if (c === "*" || c === "?" || c === "[") glob = true;
      if (c === "{") brace = true;
      text += c;
      i++;
    }
  }
  if (brace && text.includes(",")) glob = true;
  return [{ text, dynamic, glob, quoted }, i];
}

// Returns the end of a `$` form and its literal text, or null when its value is unknown.
function dollar(src: string, i: number, inDouble: boolean): [number, string | null] {
  const n = src[i + 1] ?? "";
  if (n === "(" || n === "{") return [skipBalanced(src, i + 1), null];
  if (/[A-Za-z_]/.test(n)) {
    let j = i + 2;
    while (j < src.length && /\w/.test(src[j])) j++;
    return [j, null];
  }
  if (/[0-9@*#?$!-]/.test(n)) return [i + 2, null];
  if (!inDouble && n === "'") {
    let j = i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
    return [j + 1, unescape(src.slice(i + 2, j))];
  }
  if (!inDouble && n === '"') return [i + 1, ""];
  return [i + 1, "$"];
}

function skipBalanced(src: string, i: number): number {
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
    else if (c === close && --depth === 0) return i + 1;
  }
  return src.length;
}

function skipTick(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
  return j + 1;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => ESCAPES[ch] ?? "\\" + ch);
}

// Grouping: words, redirects and heredocs per simple command.

interface Redirect {
  op: string;
  fd: number | null;
  target: Word | null;
}
interface Segment {
  words: Word[];
  redirects: Redirect[];
  docs: Heredoc[];
  piped: boolean; // stdin comes from a pipe
}

function group(toks: Tok[]): (Segment | "(" | ")")[] {
  const items: (Segment | "(" | ")")[] = [];
  const blank = (piped: boolean): Segment => ({ words: [], redirects: [], docs: [], piped });
  let seg = blank(false);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.k === "word") seg.words.push(t.w);
    else if (t.k === "doc") seg.docs.push(t.doc);
    else if (t.k === "redir") {
      const next = toks[k + 1];
      const target = next?.k === "word" ? next.w : null;
      if (target) k++;
      seg.redirects.push({ op: t.op, fd: t.fd, target });
    } else {
      if (seg.words.length > 0 || seg.redirects.length > 0 || seg.docs.length > 0) items.push(seg);
      seg = blank(t.op === "|" || t.op === "|&");
      if (t.op === "(" || t.op === ")") items.push(t.op);
    }
  }
  if (seg.words.length > 0 || seg.redirects.length > 0 || seg.docs.length > 0) items.push(seg);
  return items;
}

// Rules.

interface Ctx {
  base: string | null;
  seg: Segment;
  out: ShellReading;
}
type Extra = Pick<ShellTouch, "replaced" | "content" | "appended"> & { folder?: boolean };

const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "while", "until", "do"]);

function strip(words: Word[]): Word[] {
  let k = 0;
  while (k < words.length && (RESERVED.has(words[k].text) || /^[A-Za-z_]\w*=/.test(words[k].text))) k++;
  return words.slice(k);
}

function segment(seg: Segment, base: string | null, out: ShellReading): string | null {
  const words = strip(seg.words);
  const head = words[0];
  if (head?.text === "cd" && !head.dynamic) return cdTarget(words.slice(1), base);
  if (head?.text === "[[") return base; // `>` inside [[ ]] compares strings
  const c: Ctx = { base, seg, out };
  for (const r of seg.redirects)
    if (r.op === "<" && r.target) add(c, r.target, "read", `redirect < ${r.target.text}`);
  dispatch(words, c, 0);
  const text = stdoutText(words, seg);
  for (const r of seg.redirects) {
    if (!r.target || !r.op.includes(">") || r.op === "<>") continue;
    if (r.op === ">&" && /^(\d+|-)$/.test(r.target.text)) continue; // 2>&1 duplicates a descriptor
    const append = r.op.endsWith(">>");
    const known = r.fd === null || r.fd === 1 ? text : null;
    const extra = known === null ? {} : append ? { appended: known.text } : { content: known.text };
    const why = `${known?.from ?? "redirect"} ${r.fd ?? ""}${r.op} ${r.target.text}`;
    add(c, r.target, append ? "append" : "overwrite", why, extra);
  }
  return base;
}

function cdTarget(args: Word[], base: string | null): string | null {
  const dir = args.find((a) => !/^-[LPe@]+$/.test(a.text));
  if (!dir) return "~";
  if (dir.dynamic || dir.text === "-") return null;
  return resolvePath(dir.text, base);
}

function stdoutText(words: Word[], seg: Segment): { text: string; from: string } | null {
  const [head, ...args] = words;
  if (!head || head.dynamic || args.some((a) => a.dynamic || a.glob)) return null;
  if (head.text === "echo") return { text: echoText(args), from: "redirect" };
  if (head.text === "printf" && args.length === 1 && !args[0].text.replace(/%%/g, "").includes("%")) {
    return { text: unescape(args[0].text).replace(/%%/g, "%"), from: "redirect" };
  }
  const doc = seg.docs[seg.docs.length - 1];
  if (head.text === "cat" && doc && args.every((a) => a.text === "-"))
    return { text: doc.body, from: "heredoc" };
  return null;
}

function echoText(args: Word[]): string {
  let k = 0;
  let newline = true;
  let escapes = false;
  for (; k < args.length && /^-[neE]+$/.test(args[k].text); k++) {
    for (const f of args[k].text.slice(1)) {
      if (f === "n") newline = false;
      else escapes = f === "e";
    }
  }
  const s = args
    .slice(k)
    .map((a) => a.text)
    .join(" ");
  return (escapes ? unescape(s) : s) + (newline ? "\n" : "");
}

function add(
  c: Ctx,
  w: Word | string,
  kind: TouchKind,
  reason: string,
  extra: Extra = {},
): ShellTouch | null {
  const word = typeof w === "string" ? { text: w, dynamic: false, glob: false } : w;
  const text = word.text;
  if (word.dynamic || text === "" || text === "-" || text.startsWith("/dev/")) return null;
  const { folder, ...rest } = extra;
  const looksLikeFolder = folderish(text);
  const touch: ShellTouch = {
    written: text,
    path: resolvePath(text, c.base),
    folder: folder === true || word.glob || looksLikeFolder,
    kind,
    reason,
    ...rest,
  };
  c.out.touches.push(touch);
  return touch;
}

const folderish = (t: string) => t.endsWith("/") || /(^|\/)\.\.?$/.test(t);
const part = (w: Word, text: string): Word => ({ text, dynamic: w.dynamic, glob: w.glob });
const basename = (t: string) => t.replace(/\/+$/, "").split("/").pop() ?? t;
const at = (c: Ctx, dir: Word | null | undefined): Ctx =>
  dir && !dir.dynamic ? { ...c, base: resolvePath(dir.text, c.base) } : c;
const pathLike = (t: string) =>
  !t.startsWith("-") &&
  !t.includes("://") &&
  !/^[\d.]+$/.test(t) &&
  (t.includes("/") || /\.[A-Za-z]\w*$/.test(t) || t === "." || t === "..");

interface OptSpec {
  values?: string; // short options that take a value
  long?: string[]; // long options that take a value
  long2?: string[]; // long options that take two values
  posix?: boolean; // the first operand ends the options
}
interface Opts {
  flags: Map<string, Word | null>;
  operands: Word[];
}

function getopt(args: Word[], spec: OptSpec): Opts {
  const flags = new Map<string, Word | null>();
  const operands: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const t = a.text;
    if (t === "--") {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (a.dynamic || !t.startsWith("-") || t === "-") {
      if (spec.posix) {
        operands.push(...args.slice(k));
        break;
      }
      operands.push(a);
    } else if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq < 0 ? t : t.slice(0, eq);
      if (eq >= 0) flags.set(name, part(a, t.slice(eq + 1)));
      else if (spec.long2?.includes(name.slice(2))) flags.set(name, args[(k += 2)] ?? null);
      else flags.set(name, spec.long?.includes(name.slice(2)) ? (args[++k] ?? null) : null);
    } else {
      for (let q = 1; q < t.length; q++) {
        if (!spec.values?.includes(t[q])) {
          flags.set("-" + t[q], null);
          continue;
        }
        flags.set("-" + t[q], q + 1 < t.length ? part(a, t.slice(q + 1)) : (args[++k] ?? null));
        break;
      }
    }
  }
  return { flags, operands };
}

const has = (o: Opts, ...names: string[]) => names.some((n) => o.flags.has(n));
const value = (o: Opts, ...names: string[]) => names.map((n) => o.flags.get(n)).find((v) => v) ?? null;

type Rule = (args: Word[], c: Ctx, name: string, depth: number) => void;

function dispatch(words: Word[], c: Ctx, depth: number): void {
  const [head, ...args] = strip(words);
  if (!head || head.dynamic || depth > 4) return;
  let name = head.text;
  if (name.includes("/")) {
    const known = RULES.has(ruleKey(basename(name)));
    const system = name.startsWith("/") || name.includes("node_modules/.bin/");
    if (!known || !system) return runScript(head, args, name, c);
    name = basename(name);
  }
  RULES.get(ruleKey(name))?.(args, c, name, depth);
}

const ruleKey = (name: string) => (/^python[\d.]*$/.test(name) ? "python" : name);

// File verbs.

function remove(label: string, args: Word[], c: Ctx, folder: boolean): void {
  const o = getopt(args, {});
  if (has(o, "--cached")) return;
  const rec = folder || has(o, "-r", "-R", "--recursive");
  for (const a of o.operands) add(c, a, "delete", `${label} ${a.text}`, { folder: rec });
}

function make(label: string, values: string, args: Word[], c: Ctx, folder: boolean): void {
  for (const a of getopt(args, { values }).operands) add(c, a, "create", `${label} ${a.text}`, { folder });
}

function copyMove(verb: "cp" | "mv" | "ln", label: string, args: Word[], c: Ctx): void {
  const o = getopt(args, { values: "tS", long: ["target-directory", "suffix"] });
  const sources = [...o.operands];
  let dest = value(o, "-t", "--target-directory");
  let intoDir = dest !== null;
  if (!dest) {
    if (sources.length < 2) return;
    dest = sources.pop() ?? null;
    intoDir = sources.length > 1 || folderish(dest?.text ?? "");
  }
  if (!dest) return;
  const rec = verb === "cp" && has(o, "-r", "-R", "-a", "--recursive", "--archive");
  for (const s of sources) {
    if (verb === "cp") add(c, s, "read", `${label} from ${s.text}`, { folder: rec });
    if (verb === "mv") add(c, s, "delete", `${label} from ${s.text}`);
    if (intoDir && s.dynamic) continue;
    const name = basename(s.text);
    const target = !intoDir ? dest.text : dest.text.replace(/\/+$/, "") + "/" + name;
    const word = { text: target, dynamic: dest.dynamic, glob: dest.glob || (intoDir && s.glob) };
    add(c, word, verb === "cp" ? "write" : "create", `${label} to ${target}`, { folder: rec });
  }
}

function unzip(args: Word[], c: Ctx): void {
  const o = getopt(args, { values: "dP" });
  const zip = o.operands[0];
  if (!zip) return;
  add(c, zip, "read", `unzip ${zip.text}`);
  if (has(o, "-l", "-t", "-v", "-p", "-Z")) return;
  const dir = value(o, "-d");
  add(c, dir ?? ".", "unknown", `unzip into ${dir?.text ?? "."}`, { folder: true });
}

function tar(args: Word[], c: Ctx): void {
  const first = args[0];
  const oldStyle = first && !first.dynamic && /^[A-Za-z]+$/.test(first.text);
  const o = getopt(oldStyle ? [part(first, "-" + first.text), ...args.slice(1)] : args, {
    values: "fCbTX",
    long: ["file", "directory"],
  });
  const file = value(o, "-f", "--file");
  const dir = value(o, "-C", "--directory");
  if (has(o, "-x", "--extract", "--get")) {
    if (file) add(c, file, "read", `tar ${file.text}`);
    add(c, dir ?? ".", "unknown", `tar into ${dir?.text ?? "."}`, { folder: true });
  } else if (has(o, "-c", "--create")) {
    for (const a of o.operands) add(at(c, dir), a, "read", `tar from ${a.text}`);
    if (file) add(c, file, "write", `tar to ${file.text}`);
  } else if (has(o, "-t", "--list") && file) add(c, file, "read", `tar ${file.text}`);
}

function sed(args: Word[], c: Ctx): void {
  let inPlace = false;
  let fromFile = false;
  let ended = false;
  const scripts: Word[] = [];
  const operands: Word[] = [];
  const script = (w: Word | undefined, file: boolean) => {
    if (w && file) add(c, w, "read", `sed -f ${w.text}`);
    if (w && !file) scripts.push(w);
    fromFile ||= file;
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const t = a.text;
    if (ended || a.dynamic || !t.startsWith("-") || t === "-") operands.push(a);
    else if (t === "--") ended = true;
    else if (t.startsWith("--")) {
      const [name, val] = t.split(/=(.*)/s);
      if (name === "--in-place") inPlace = true;
      else if (name === "--expression" || name === "--file") {
        script(val === undefined ? args[++k] : part(a, val), name === "--file");
      }
    } else {
      for (let q = 1; q < t.length; q++) {
        const ch = t[q];
        if (ch === "i" || ch === "I") {
          inPlace = true;
          // BSD takes the backup suffix as its own word: `sed -i '' ...` or `sed -i .bak ...`.
          const next = args[k + 1];
          if (q + 1 === t.length && next && (next.text === "" || /^\.[\w.-]*$/.test(next.text))) k++;
          break;
        }
        if (ch === "e" || ch === "f") {
          script(q + 1 < t.length ? part(a, t.slice(q + 1)) : args[++k], ch === "f");
          break;
        }
      }
    }
  }
  if (scripts.length === 0 && !fromFile) {
    const first = operands.shift();
    if (first) scripts.push(first);
  }
  const single =
    scripts.length === 1 && !fromFile && !scripts[0].dynamic ? substitution(scripts[0].text) : null;
  for (const f of operands) {
    if (!inPlace) add(c, f, "read", `sed ${f.text}`);
    else add(c, f, "change", `sed -i ${f.text}`, single ? { replaced: [single] } : {});
  }
}

// Parses a bare `s/old/new/flags`; anything else (addresses, several commands) is null.
function substitution(script: string): { old: string; new: string } | null {
  const s = script.trim();
  const d = s[1];
  if (s[0] !== "s" || !d || d === "\\" || d === "\n") return null;
  const parts: string[] = [];
  let cur = "";
  let i = 2;
  for (; i < s.length && parts.length < 2; i++) {
    if (s[i] === "\\" && i + 1 < s.length) cur += s[i + 1] === d ? s[++i] : s[i] + s[++i];
    else if (s[i] === d) {
      parts.push(cur);
      cur = "";
    } else cur += s[i];
  }
  if (parts.length < 2 || !/^[gIip0-9]*$/.test(s.slice(i))) return null;
  return { old: parts[0], new: parts[1] };
}

function tee(args: Word[], c: Ctx): void {
  const o = getopt(args, {});
  const append = has(o, "-a", "--append");
  const doc = c.seg.docs[c.seg.docs.length - 1];
  const extra = !doc ? {} : append ? { appended: doc.body } : { content: doc.body };
  for (const a of o.operands)
    add(c, a, append ? "append" : "overwrite", `tee ${append ? "-a " : ""}${a.text}`, extra);
}

// Git and patch.

const GIT_TREE = new Set(["merge", "pull", "rebase", "cherry-pick", "revert", "am"]);
const STASH_QUIET = new Set(["list", "show", "drop", "clear", "create", "store"]);

function git(args: Word[], c: Ctx): void {
  const o = getopt(args, { values: "Cc", long: ["git-dir", "work-tree", "namespace"], posix: true });
  const g = at(c, value(o, "-C"));
  const [subWord, ...rest] = o.operands;
  const sub = subWord?.text ?? "";
  const repo = () => add(g, ".", "unknown", `git ${sub}`, { folder: true });
  const split = rest.findIndex((a) => a.text === "--");
  const paths = split >= 0 ? rest.slice(split + 1) : [];
  const before = split >= 0 ? rest.slice(0, split) : rest;
  const change = (a: Word) => add(g, a, "change", `git ${sub} ${a.text}`);
  if (sub === "checkout") {
    const r = getopt(before, { values: "bB", long: ["orphan"] });
    const files = r.operands.filter((a) => a.text === "." || /\.[A-Za-z]\w*$/.test(a.text));
    if (paths.length > 0 || files.length > 0) [...files, ...paths].forEach(change);
    else if (r.operands.length > 0) repo();
  } else if (sub === "restore") {
    const r = getopt(before, { values: "s", long: ["source"] });
    if (has(r, "-S", "--staged") && !has(r, "-W", "--worktree")) return;
    [...r.operands, ...paths].forEach(change);
  } else if (sub === "switch") {
    const r = getopt(rest, { values: "cC", long: ["create", "force-create"] });
    if (r.operands.length > 0) repo();
  } else if (sub === "apply") {
    const r = getopt(rest, { values: "p", long: ["directory", "exclude", "include"] });
    for (const a of r.operands) add(g, a, "read", `git apply ${a.text}`);
    if (!has(r, "--check", "--stat", "--numstat", "--summary", "--cached")) repo();
  } else if (sub === "mv") copyMove("mv", "git mv", rest, g);
  else if (sub === "rm") remove("git rm", rest, g, false);
  else if (sub === "reset") {
    if (has(getopt(rest, {}), "--hard", "--merge", "--keep")) repo();
  } else if (sub === "stash") {
    if (!STASH_QUIET.has(getopt(rest, {}).operands[0]?.text ?? "")) repo();
  } else if (sub === "clean") {
    if (!has(getopt(rest, {}), "-n", "--dry-run")) repo();
  } else if (GIT_TREE.has(sub)) repo();
}

function patch(args: Word[], c: Ctx): void {
  const o = getopt(args, { values: "pdiBDFoVYzrx", long: ["directory", "input", "output", "strip"] });
  const p = at(c, value(o, "-d", "--directory"));
  const input = value(o, "-i", "--input");
  const [original, file] = o.operands;
  if (input) add(p, input, "read", `patch ${input.text}`);
  if (file) add(p, file, "read", `patch ${file.text}`);
  if (has(o, "--dry-run")) return;
  if (original) add(p, original, "change", `patch ${original.text}`);
  else add(p, ".", "unknown", "patch", { folder: true });
}

// Package managers: the manifest and lockfile each tool usually writes.

interface Manager extends OptSpec {
  manifest: string;
  lock: string;
  edit: string[]; // with packages named: manifest and lockfile; without: the lockfile
  lockOnly?: string[];
  bare?: boolean; // the tool alone installs
  dir?: string[];
  run?: string; // the subcommand that runs another command
}
const NPM_EDIT = ["install", "i", "add", "uninstall", "un", "remove", "rm", "r", "update", "up", "upgrade"];
const MANAGERS: Record<string, Manager> = {
  npm: {
    manifest: "package.json",
    lock: "package-lock.json",
    edit: NPM_EDIT,
    dir: ["--prefix"],
    values: "w",
    long: ["prefix", "workspace", "registry", "tag"],
  },
  pnpm: {
    manifest: "package.json",
    lock: "pnpm-lock.yaml",
    edit: NPM_EDIT,
    dir: ["-C", "--dir"],
    values: "CF",
    long: ["dir", "filter"],
    run: "exec",
  },
  yarn: {
    manifest: "package.json",
    lock: "yarn.lock",
    edit: ["add", "remove", "upgrade", "up", "install"],
    bare: true,
    dir: ["--cwd"],
    long: ["cwd"],
  },
  uv: {
    manifest: "pyproject.toml",
    lock: "uv.lock",
    edit: ["add", "remove"],
    lockOnly: ["lock", "sync"],
    dir: ["--directory", "--project"],
    values: "p",
    long: ["directory", "project", "python", "with", "group", "extra", "index"],
    run: "run",
  },
  cargo: {
    manifest: "Cargo.toml",
    lock: "Cargo.lock",
    edit: ["add", "remove", "rm"],
    lockOnly: ["update"],
    values: "pF",
    long: ["package", "features", "manifest-path"],
  },
};

function manager(name: string, m: Manager, args: Word[], c: Ctx, depth: number): void {
  const o = getopt(args, { ...m, posix: true });
  const [sub, ...rest] = o.operands;
  const cc = at(c, value(o, ...(m.dir ?? [])));
  const r = getopt(rest, { ...m, posix: sub?.text === m.run });
  if (sub && sub.text === m.run) {
    const [first, ...more] = r.operands;
    if (first && /\.(py|js|mjs|cjs|ts)$/.test(first.text)) runScript(first, more, `${name} ${sub.text}`, cc);
    else dispatch(r.operands, cc, depth + 1);
    return;
  }
  if (has(o, "-g", "--global") || has(r, "-g", "--global")) return;
  let files: string[] = [];
  if (!sub) files = m.bare ? [m.lock] : [];
  else if (m.edit.includes(sub.text)) files = r.operands.length > 0 ? [m.manifest, m.lock] : [m.lock];
  else if (m.lockOnly?.includes(sub.text)) files = [m.lock];
  for (const f of files) add(cc, f, "change", sub ? `${name} ${sub.text}` : name);
}

function pip(args: Word[], c: Ctx): void {
  const o = getopt(args, {
    values: "rceit",
    long: ["requirement", "constraint", "editable", "index-url", "target"],
  });
  const req = value(o, "-r", "--requirement");
  if (req) add(c, req, "read", `pip ${req.text}`);
}

// Read verbs: `pattern` lists the flags that move a pattern out of the first operand.

interface Reader extends OptSpec {
  pattern?: string[];
  folder?: true | string[];
  files?: string[]; // options whose value is a file the verb reads
}
const GREP: Reader = {
  values: "efmABCdD",
  long: ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude"],
  pattern: ["-e", "-f", "--regexp", "--file"],
  folder: ["-r", "-R", "--recursive"],
  files: ["-f", "--file"],
};
const READERS: Record<string, Reader> = {
  cat: {},
  less: {},
  more: {},
  nl: {},
  wc: {},
  cmp: {},
  head: { values: "nc" },
  tail: { values: "nc" },
  bat: { values: "lHrm", long: ["language", "line-range", "highlight-line", "style", "theme"] },
  diff: { values: "xXILUCFD", long: ["label", "exclude", "exclude-from", "ignore-matching-lines"] },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: {
    values: "efgtTmABCMjrd",
    long: [
      "regexp",
      "file",
      "glob",
      "iglob",
      "type",
      "type-not",
      "max-count",
      "context",
      "replace",
      "max-depth",
    ],
    pattern: ["-e", "-f", "--regexp", "--file", "--files", "--type-list"],
    files: ["-f", "--file"],
  },
  awk: { values: "Ffv", pattern: ["-f"], files: ["-f"] },
  jq: {
    values: "fL",
    long: ["indent", "from-file"],
    long2: ["arg", "argjson", "slurpfile", "rawfile"],
    pattern: ["-f", "--from-file"],
    files: ["-f", "--from-file"],
  },
  ls: { folder: true }, // BSD ls on macOS has no option that takes a value
  tree: { values: "LIPo", folder: true },
};

function reader(name: string, spec: Reader, args: Word[], c: Ctx): void {
  const o = getopt(args, spec);
  const operands = [...o.operands];
  if (spec.pattern && !has(o, ...spec.pattern)) operands.shift();
  const folder = spec.folder === true || (spec.folder !== undefined && has(o, ...spec.folder));
  for (const f of spec.files ?? []) {
    const v = o.flags.get(f);
    if (v) add(c, v, "read", `${name} ${v.text}`);
  }
  for (const a of operands) if (!a.text.startsWith("+")) add(c, a, "read", `${name} ${a.text}`, { folder });
}

function find(args: Word[], c: Ctx): void {
  let k = 0;
  while (k < args.length && /^-[HLPEXdsx]$/.test(args[k].text)) k++;
  for (; k < args.length; k++) {
    const t = args[k].text;
    if (t.startsWith("-") || t === "(" || t === "!") break;
    add(c, args[k], "read", `find ${t}`, { folder: true });
  }
}

function testRunner(name: string, args: Word[], c: Ctx): void {
  for (const a of args) {
    const text = a.text.split("::")[0];
    if (pathLike(text)) add(c, part(a, text), "read", `${name} ${text}`);
  }
}

// Scripts: the script is read, every path-like argument may have changed.

interface Interpreter extends OptSpec {
  inline: string[];
  module?: boolean;
}
const SH: Interpreter = { values: "co", inline: ["-c"] };
const TS: Interpreter = { values: "er", long: ["eval"], inline: ["-e", "--eval"] };
const INTERPRETERS: Record<string, Interpreter> = {
  python: { values: "cmWX", inline: ["-c"], module: true },
  node: {
    values: "eprC",
    long: ["eval", "print", "require", "import", "loader", "experimental-loader"],
    inline: ["-e", "-p", "--eval", "--print"],
  },
  bash: SH,
  sh: SH,
  zsh: SH,
  ruby: { values: "erI", inline: ["-e"] },
  perl: { values: "eEIM", inline: ["-e", "-E"] },
  tsx: TS,
  "ts-node": TS,
  "vite-node": TS,
};

function interpreter(label: string, spec: Interpreter, args: Word[], c: Ctx, depth: number): void {
  const o = getopt(args, { ...spec, posix: true });
  if (has(o, ...spec.inline)) return inlineScript(c);
  const mod = spec.module ? value(o, "-m") : null;
  if (mod) {
    if (RULES.has(mod.text)) return dispatch([mod, ...o.operands], c, depth + 1);
    for (const a of o.operands) if (pathLike(a.text)) add(c, a, "unknown", `module ${mod.text} ${a.text}`);
    return;
  }
  const [script, ...rest] = o.operands;
  if (script && script.text !== "-") return runScript(script, rest, label, c);
  const fed = c.seg.docs.length > 0 || c.seg.piped || c.seg.redirects.some((r) => r.op === "<<<");
  if (fed || script) return inlineScript(c);
  const from = c.seg.redirects.find((r) => r.op === "<" && r.target && !r.target.dynamic)?.target;
  if (from && c.out.script === null) c.out.script = resolvePath(from.text, c.base);
}

function runScript(script: Word, rest: Word[], label: string, c: Ctx): void {
  const t = add(c, script, "read", `script ${label}`);
  if (t && c.out.script === null) c.out.script = t.path;
  for (const a of rest) {
    const eq = a.text.indexOf("=");
    const v = a.text.startsWith("-") && eq > 0 ? part(a, a.text.slice(eq + 1)) : a;
    if (pathLike(v.text)) add(c, v, "unknown", `script argument ${v.text}`);
  }
}

function inlineScript(c: Ctx): void {
  c.out.inline = true;
  const here = resolvePath(".", c.base);
  if (!c.out.touches.some((t) => t.reason === "inline script" && t.path === here)) {
    add(c, ".", "unknown", "inline script", { folder: true });
  }
}

// Wrappers run the command that follows them.

const WRAPPERS: Record<string, OptSpec & { skip?: number }> = {
  env: { values: "uCS", long: ["unset", "chdir"] },
  sudo: { values: "ugpChDrtU", long: ["user", "group"] },
  nohup: {},
  time: {},
  exec: { values: "a" },
  command: {},
  nice: { values: "n" },
  timeout: { values: "sk", long: ["signal", "kill-after"], skip: 1 },
  npx: { values: "pc", long: ["package", "call"] },
};

const RULES = new Map<string, Rule>([
  ["rm", (a, c) => remove("rm", a, c, false)],
  ["rmdir", (a, c) => remove("rmdir", a, c, true)],
  ["mkdir", (a, c) => make("mkdir", "m", a, c, true)],
  ["touch", (a, c) => make("touch", "tdr", a, c, false)],
  ["cp", (a, c) => copyMove("cp", "cp", a, c)],
  ["mv", (a, c) => copyMove("mv", "mv", a, c)],
  ["ln", (a, c) => copyMove("ln", "ln", a, c)],
  ["unzip", unzip],
  ["tar", tar],
  ["sed", sed],
  ["tee", tee],
  ["git", git],
  ["patch", patch],
  ["pip", pip],
  ["pip3", pip],
  ["find", find],
]);
for (const n of ["vitest", "jest", "mocha", "pytest"]) RULES.set(n, (a, c) => testRunner(n, a, c));
for (const [n, r] of Object.entries(READERS)) RULES.set(n, (a, c) => reader(n, r, a, c));
for (const [n, m] of Object.entries(MANAGERS)) RULES.set(n, (a, c, _l, d) => manager(n, m, a, c, d));
for (const [n, s] of Object.entries(INTERPRETERS)) RULES.set(n, (a, c, l, d) => interpreter(l, s, a, c, d));
for (const [n, w] of Object.entries(WRAPPERS)) {
  RULES.set(n, (a, c, _l, d) =>
    dispatch(getopt(a, { ...w, posix: true }).operands.slice(w.skip ?? 0), c, d + 1),
  );
}
