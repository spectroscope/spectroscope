// A small, dependency-free markdown parser for the agent answers — the same
// house pattern as petriModel/labScene: a PURE fold from text to typed nodes,
// rendered elsewhere. Chat-flavoured: single newlines inside a paragraph stay
// visible (soft breaks), an unclosed code fence still renders as a code block
// (answers stream token by token), and links only keep vetted protocols —
// model output is untrusted, so nothing here ever produces raw HTML.

export type Align = "left" | "center" | "right" | null;

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "br" }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; children: Inline[]; href: string | null };

export interface ListItem {
  children: Inline[];
  /** One nested list level — enough for the shapes LLM answers produce. */
  sub: Extract<Block, { kind: "list" }> | null;
}

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "para"; children: Inline[] }
  | { kind: "code"; lang: string | null; text: string; open: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; children: Block[] }
  | { kind: "hr" }
  | { kind: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] };

const ESCAPABLE = "\\`*_~[]()#>|-!";

/** Only protocols a click may follow; everything else renders as plain text. */
function sanitizeHref(raw: string): string | null {
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  if (raw.startsWith("#") || raw.startsWith("/")) return raw;
  return null;
}

// ---- inline level -----------------------------------------------------------

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;
  const flush = (): void => {
    if (text !== "") {
      out.push({ kind: "text", text });
      text = "";
    }
  };
  /** Paired marker (strong/em/del): non-empty, closed, else literal. */
  const pair = (marker: string, kind: "strong" | "em" | "del"): boolean => {
    if (!src.startsWith(marker, i)) return false;
    const close = src.indexOf(marker, i + marker.length);
    if (close === -1 || close === i + marker.length) return false;
    flush();
    out.push({ kind, children: parseInline(src.slice(i + marker.length, close)) });
    i = close + marker.length;
    return true;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const tick = src.startsWith("``", i) ? "``" : "`";
      const close = src.indexOf(tick, i + tick.length);
      if (close !== -1) {
        flush();
        out.push({ kind: "code", text: src.slice(i + tick.length, close) });
        i = close + tick.length;
        continue;
      }
    }
    if (ch === "[") {
      const closeBracket = src.indexOf("]", i + 1);
      if (closeBracket !== -1 && src[closeBracket + 1] === "(") {
        const closeParen = src.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          flush();
          out.push({
            kind: "link",
            children: parseInline(src.slice(i + 1, closeBracket)),
            href: sanitizeHref(src.slice(closeBracket + 2, closeParen).trim()),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (pair("**", "strong") || pair("__", "strong") || pair("~~", "del")) continue;
    // Single * or _ is emphasis only when it hugs the content on both sides —
    // "6*7" and "2 * 3" stay literal.
    if ((ch === "*" || ch === "_") && src[i + 1] !== undefined && src[i + 1] !== " " && src[i + 1] !== ch) {
      const close = src.indexOf(ch, i + 1);
      if (close !== -1 && src[close - 1] !== " ") {
        flush();
        out.push({ kind: "em", children: parseInline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/** One paragraph's lines as a single inline run with visible soft breaks. */
function joinWithBreaks(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ kind: "br" });
    out.push(...parseInline(line));
  });
  return out;
}

// ---- block level ------------------------------------------------------------

const FENCE_OPEN = /^\s{0,3}```\s*([^`\s]*)\s*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split a table row into cells; `\|` survives as a literal pipe. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (line[i] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += line[i];
    }
  }
  cells.push(cur);
  // A leading/trailing pipe produces empty edge cells — drop them.
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

interface ListParse {
  block: Extract<Block, { kind: "list" }>;
  next: number;
}

/** Collect one list run from `start`; indented items nest ONE level. */
function collectList(lines: string[], start: number): ListParse {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = (first as RegExpExecArray)[1].length;
  const block: Extract<Block, { kind: "list" }> = {
    kind: "list",
    ordered: (first as RegExpExecArray)[3] !== undefined,
    start: (first as RegExpExecArray)[3] !== undefined ? Number((first as RegExpExecArray)[3]) : 1,
    items: [],
  };
  const texts: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_ITEM.exec(line);
    if (m !== null) {
      if (m[1].length < baseIndent) break; // dedent — belongs to an outer list
      if (m[1].length <= baseIndent + 1) {
        texts.push(m[4]);
        block.items.push({ children: [], sub: null });
        i += 1;
        continue;
      }
      if (block.items.length > 0) {
        const sub = collectList(lines, i);
        block.items[block.items.length - 1].sub = sub.block;
        i = sub.next;
        continue;
      }
    }
    // Indented continuation of the previous item (hanging text).
    if (m === null && line.trim() !== "" && /^\s+/.test(line) && block.items.length > 0) {
      texts[texts.length - 1] += ` ${line.trim()}`;
      i += 1;
      continue;
    }
    break;
  }
  block.items.forEach((item, j) => {
    item.children = parseInline(texts[j]);
  });
  return { block, next: i };
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length > 0) {
      out.push({ kind: "para", children: joinWithBreaks(para) });
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      flushPara();
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (FENCE_CLOSE.test(lines[j])) {
          closed = true;
          j += 1;
          break;
        }
        body.push(lines[j]);
        j += 1;
      }
      out.push({ kind: "code", lang: fence[1] !== "" ? fence[1] : null, text: body.join("\n"), open: !closed });
      i = j;
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushPara();
      out.push({ kind: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      i += 1;
      continue;
    }

    // Table before hr: a delimiter row like |---|---| must not read as a rule.
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && TABLE_DELIM.test(lines[i + 1])) {
      flushPara();
      const header = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(parseAlign);
      const rows: Inline[][][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]).map(parseInline));
        j += 1;
      }
      out.push({ kind: "table", align, header, rows });
      i = j;
      continue;
    }

    if (HR.test(line)) {
      flushPara();
      out.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (q === null) break;
        inner.push(q[1]);
        i += 1;
      }
      out.push({ kind: "quote", children: parseBlocks(inner) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushPara();
      const { block, next } = collectList(lines, i);
      out.push(block);
      i = next;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return out;
}
