// Card 604: the tokenizer behind the shell heuristic (shell.ts). It turns one
// command string into simple commands: words with their quoting resolved,
// redirects, heredocs and subshell markers. A heredoc body is captured as text
// up to its terminator and never lexed as a command.

/** The simple commands of a line in order, with "(" and ")" marking subshells. */
export function segments(command: string): (Segment | "(" | ")")[] {
  return group(lex(command));
}

export interface Word {
  text: string; // the value after quote removal
  dynamic: boolean; // holds a variable or a substitution, so the value is unknown
  glob: boolean; // holds an unquoted pattern character
  quoted?: boolean;
  start?: number; // where the word starts in the command, quotes included (card 605)
  end?: number; // where it ends, exclusive
}
export interface Heredoc {
  strip: boolean;
  delimiter: string;
  body: string;
  /** Where the body starts and ends in the command, its terminator line left out (card 605). */
  start?: number;
  end?: number;
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
          toks.push({ k: "word", w: { ...w, start: i, end: j } });
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
    doc.start = i;
    doc.end = i;
    while (i < src.length) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      const line = doc.strip ? src.slice(i, end).replace(/^\t+/, "") : src.slice(i, end);
      i = nl === -1 ? src.length : nl + 1;
      if (line === doc.delimiter) break;
      body += line + "\n";
      doc.end = end;
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
export function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => ESCAPES[ch] ?? "\\" + ch);
}

// Grouping: words, redirects and heredocs per simple command.

export interface Redirect {
  op: string;
  fd: number | null;
  target: Word | null;
}
export interface Segment {
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
