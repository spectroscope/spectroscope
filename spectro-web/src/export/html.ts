// "Export this tab as HTML": the chat and the text feed as ONE file you can
// open, mail, or attach to a ticket. Pure renderers over the event stream, not
// a DOM scrape — scraping would capture whichever cards happened to be open and
// would drag the app's whole stylesheet along, while a fold over RunEvent[]
// gives a stable, complete document that also works for a stream nobody is
// currently looking at.
//
// The document is self-contained by construction: inline CSS, no script, no
// link, no font fetch, no remote image. It opens from file:// with the network
// unplugged, which is the only way an attachment on a ticket is worth anything.
//
// ESCAPING IS THE JOB. A session is a third party's data — shell commands,
// quotes, angle brackets, sometimes literal HTML. Every interpolation goes
// through escapeHtml, and the two places that could still produce markup are
// closed at the source: link protocols are vetted by the markdown parser
// (which never emits raw HTML), and the only style attribute carries one of
// four constant colour tokens.
//
// Because every view in this app is a fold over the same RunEvent[], a
// translated stream exports exactly like the recorded one, with no work here.
// Provenance rides in `note` — outside the frozen event union, where it belongs.

import type { RunEvent } from "../events";
import type { Lang } from "../i18n/i18n";
import type { Block, Inline } from "../markdown/parse";
import { parseMarkdown } from "../markdown/parse";
import type { HlLang } from "../workspace/highlight";
import { hlLangForFence, tokenize } from "../workspace/highlight";
import { buildTextFeed } from "../state/textFeed";
import type { ToolCard, Turn, UiState } from "../state/reducer";
import { initialState, reduceAll } from "../state/reducer";
import { groupTurns } from "../state/threads";
import { agentAccent, compactJson, formatDuration, prettyJson } from "../format";

export interface ExportOptions {
  /** Shown in the header and the browser tab — a session id, a first prompt. */
  label?: string;
  /** Export moment; injectable so the output is byte-stable in tests. */
  now?: number;
  /** Chrome language of the DOCUMENT (the session's own text is untouched). */
  lang?: Lang;
  /** A line under the header, e.g. "translated to Deutsch (de)". */
  note?: string;
  /** Text feed only: the extended feed, exactly as the tab's toggle builds it. */
  extended?: boolean;
}

// ---- escaping ---------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Every character that could open markup or close an attribute. One pass, so
 * an ampersand is escaped exactly once, and the same function serves text and
 * attributes — one rule is one rule fewer to get wrong at a call site.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// ---- chrome strings ---------------------------------------------------------

// Deliberately local, not i18n keys: the export is a file that outlives the
// app it came from, and a missing key would print as a key in a document
// someone mails to a colleague.
const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    chat: "chat",
    text: "text feed",
    you: "you",
    reasoning: "reasoning",
    chars: "{n} characters",
    input: "input",
    output: "output",
    events: "{n} events",
    exported: "exported {when}",
    error: "error",
    noResult: "no result",
    allowed: "allowed",
    denied: "denied",
    pending: "pending",
    totals: "{in} in · {out} out",
    ended: "ended: {reason}",
    empty: "This session carries no events.",
    theme: "dark",
  },
  de: {
    chat: "Chat",
    text: "Text-Feed",
    you: "du",
    reasoning: "Denken",
    chars: "{n} Zeichen",
    input: "Eingabe",
    output: "Ausgabe",
    events: "{n} events",
    exported: "exportiert {when}",
    error: "Fehler",
    noResult: "kein Ergebnis",
    allowed: "erlaubt",
    denied: "verweigert",
    pending: "offen",
    totals: "{in} rein · {out} raus",
    ended: "beendet: {reason}",
    empty: "Diese Session trägt keine Events.",
    theme: "dunkel",
  },
};

function label(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = LABELS[lang][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

// ---- time -------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** UTC everywhere: the file is written on one machine and read on another, and
 *  a bare local stamp in a mailed document is a stamp nobody can place. */
function utcStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
  );
}

function utcClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// ---- the document shell -----------------------------------------------------

// The handful of brand tokens the export actually uses, copied from tokens.css.
// DARK ONLY (the espresso ground): one theme keeps the file small and the
// reading predictable, and dark is the app's default — the header says so.
// No @font-face and no url(): the font stack names local families and falls
// back to the system, because a web font would be a network fetch.
const CSS = `
:root{
  --bg: #17120d; --surface: #201913; --surface-2: #292019; --surface-3: #2e251c;
  --border: #33291f; --border-strong: #5c5142; --shade: rgba(0,0,0,.18);
  --text: #ede7dc; --text-dim: #a2988a; --text-faint: #5c5142;
  --accent: #ce9440; --sand: #8b7cf0;
  --sp-red: #c05a4c; --sp-amber: #ce9440; --sp-teal: #2dd4a7; --sp-ocean: #2cb1c4; --sp-violet: #8b7cf0;
  --ok: #2dd4a7; --warn: #ce9440; --error: #c05a4c;
  --agent-root: #2dd4a7; --agent-explore: #2cb1c4; --agent-worker: #8b7cf0; --agent-extra: #ce9440;
  --font-ui: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased}
.x-wrap{max-width:860px;margin:0 auto;padding:32px 24px 64px}
.x-head{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:24px}
.x-brand{display:flex;align-items:center;gap:10px;color:var(--text);font-weight:500;letter-spacing:-.01em}
.x-title{margin:12px 0 4px;font-size:20px;font-weight:300;letter-spacing:-.015em;overflow-wrap:break-word}
.x-meta{margin:0;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;
  text-transform:uppercase}
.x-note{margin:8px 0 0;color:var(--sand);font-size:12px}
.x-empty{color:var(--text-faint);font-size:13px}
.x-eyebrow{color:var(--text-faint);font-family:var(--font-mono);font-size:11px;letter-spacing:.18em;
  text-transform:uppercase;margin-bottom:4px}

/* chat */
.x-user{width:fit-content;max-width:min(78%,44rem);margin:16px 0 12px auto;background:var(--surface-3);
  border-radius:10px;padding:8px 16px}
.x-user-text{white-space:pre-wrap;overflow-wrap:break-word}
.x-assistant{margin:0 0 16px}
.x-answer{line-height:1.65;overflow-wrap:break-word}
.x-badge{display:inline-block;margin-bottom:4px;padding:1px 7px;border:1px solid var(--agent-color,var(--border));
  border-radius:7px;color:var(--text-dim);font-family:var(--font-mono);font-size:11px}
.x-assistant-meta{margin-top:6px;color:var(--text-faint);font-family:var(--font-mono);font-size:12px;
  font-variant-numeric:tabular-nums}
.x-info{margin:8px 0;color:var(--text-dim);font-size:12px}
.x-info--warn{color:var(--warn)}
.x-error{margin:12px 0;border:1px solid var(--error);border-radius:10px;padding:8px 16px}
.x-error-text{color:var(--error);white-space:pre-wrap;overflow-wrap:break-word}
.x-thread{margin:12px 0;border-left:2px solid var(--agent-color,var(--border));padding-left:16px}
.x-thread-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.x-thread-task{color:var(--text-faint);font-size:12px}

/* reasoning + tools: native disclosure, so the file needs no script */
details{margin:8px 0;border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden}
summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 12px;cursor:pointer;
  font-family:var(--font-mono);font-size:12px;color:var(--text-dim);list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";color:var(--text-faint);font-size:10px}
details[open]>summary::before{content:"\\25BE"}
.x-think summary{color:var(--sp-violet)}
.x-tool{border-left:2px solid var(--line-color,var(--border))}
.x-tool-name{color:var(--text);font-weight:500}
.x-tool-preview{color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch}
.x-chip{border:1px solid var(--border-strong);border-radius:7px;padding:0 6px;font-size:11px;color:var(--text-dim)}
.x-chip--denied{border-color:var(--error);color:var(--error)}
.x-chip--allowed{border-color:var(--ok);color:var(--ok)}
.x-chip--error{border-color:var(--error);color:var(--error)}
.x-body{padding:0 12px 12px}
.x-io{margin:8px 0 4px;color:var(--text-faint);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;
  text-transform:uppercase}
.x-think-body{padding:0 12px 12px;color:var(--text-dim);font-style:italic;white-space:pre-wrap;
  overflow-wrap:break-word}

/* code */
pre{margin:0;padding:12px;background:var(--shade);border:1px solid var(--border);border-radius:10px;
  overflow-x:auto;font-family:var(--font-mono);font-size:12px;line-height:1.55;white-space:pre-wrap;
  overflow-wrap:break-word}
code{font-family:var(--font-mono)}
.hl-keyword{color:var(--sp-violet)}
.hl-string{color:var(--sp-teal)}
.hl-number{color:var(--sp-ocean)}
.hl-comment{color:var(--text-faint);font-style:italic}

/* markdown */
.x-md h1,.x-md h2,.x-md h3,.x-md h4,.x-md h5,.x-md h6{margin:16px 0 8px;font-weight:500;line-height:1.3}
.x-md>*:first-child{margin-top:0}
.x-md h1{font-size:20px;font-weight:300;padding-bottom:8px;border-bottom:1px solid var(--border)}
.x-md h2{font-size:18px;font-weight:300}
.x-md h3{font-size:15px}
.x-md p{margin:0 0 12px}
.x-md a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent}
.x-md a:hover{border-bottom-color:var(--accent)}
.x-md-code{font-family:var(--font-mono);font-size:.86em;background:var(--shade);border:1px solid var(--border);
  border-radius:7px;padding:1px 5px}
.x-pre{margin:0 0 12px}
.x-pre-lang{color:var(--text-faint);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;
  text-transform:uppercase;margin-bottom:4px}
.x-md ul,.x-md ol{margin:0 0 12px;padding-left:1.5em}
.x-md li{margin:0 0 4px}
.x-md blockquote{margin:0 0 12px;padding:4px 0 4px 12px;border-left:2px solid var(--sand);color:var(--text-dim)}
.x-md hr{border:0;border-top:1px solid var(--border-strong);margin:16px 0}
.x-md table{border-collapse:collapse;font-size:13px;margin:0 0 12px}
.x-md th,.x-md td{border:1px solid var(--border);padding:4px 12px;text-align:left}
.x-md th{background:var(--surface-2)}

/* text feed */
.x-feed{font-family:var(--font-mono);font-size:13px;line-height:1.55}
.x-tf{white-space:pre-wrap;word-break:break-word}
.x-tf+.x-tf{margin-top:2px}
.x-tf-agent{color:var(--text-faint);margin-right:8px}
.x-tf--marker{color:var(--text-faint)}
.x-tf--prompt{color:var(--sand)}
.x-tf--thinking{color:var(--text-dim);font-style:italic}
.x-tf--answer{color:var(--text)}
.x-tf--output{color:var(--text-dim)}
.x-tf--error{color:var(--error)}

.x-foot{margin-top:32px;padding-top:12px;border-top:1px solid var(--border);color:var(--text-faint);
  font-family:var(--font-mono);font-size:11px}
@media print{body{background:#fff;color:#000}details{break-inside:avoid}}
`;

/** The M1 line bundle — the brand mark as geometry, so it needs no image. */
const MARK =
  '<svg viewBox="0 0 64 64" width="18" height="18" aria-hidden="true">' +
  '<rect x="13.2" y="14" width="2.6" height="36" rx=".7" fill="var(--sp-red)"/>' +
  '<rect x="21.7" y="14" width="1.6" height="36" rx=".7" fill="var(--sp-amber)"/>' +
  '<rect x="28.9" y="14" width="5.2" height="36" rx=".7" fill="var(--sp-teal)"/>' +
  '<rect x="42" y="14" width="2" height="36" rx=".7" fill="var(--sp-ocean)"/>' +
  '<rect x="49.35" y="14" width="1.3" height="36" rx=".7" fill="var(--text-faint)"/>' +
  "</svg>";

interface ShellInput {
  kind: "chat" | "text";
  events: readonly RunEvent[];
  opts: ExportOptions;
  /** Already markup — the renderers build it node by node, escaping as they go. */
  body: string;
  /** PLAIN TEXT: totals, stop reason, whatever the view knows. The shell escapes
   *  it, so no caller can forget to. */
  foot: string;
}

function wrapDocument({ kind, events, opts, body, foot }: ShellInput): string {
  const lang: Lang = opts.lang ?? "en";
  const now = opts.now ?? Date.now();
  const kindName = label(lang, kind);
  const title = opts.label !== undefined && opts.label !== "" ? opts.label : `spectroscope ${kindName}`;
  const meta = [
    kindName,
    label(lang, "events", { n: events.length }),
    label(lang, "exported", { when: utcStamp(now) }),
    label(lang, "theme"),
  ].join(" · ");
  const note =
    opts.note !== undefined && opts.note !== "" ? `<p class="x-note">${escapeHtml(opts.note)}</p>` : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · spectroscope</title>
<style>${CSS}</style>
</head>
<body>
<div class="x-wrap">
<header class="x-head">
<div class="x-brand">${MARK}<span>spectroscope</span></div>
<h1 class="x-title">${escapeHtml(title)}</h1>
<p class="x-meta">${escapeHtml(meta)}</p>
${note}
</header>
<main>
${body}
</main>
<footer class="x-foot">${escapeHtml(foot)}</footer>
</div>
</body>
</html>
`;
}

// ---- markdown -> html -------------------------------------------------------

/**
 * Code as coloured spans, or escaped text when the language is unknown —
 * the same rule the app's Highlighted follows: colouring is a claim about what
 * the characters mean, and a wrong claim about a shell command is worse than
 * no colour at all. The token class comes from a closed union, never from data.
 */
function codeHtml(text: string, lang: HlLang | null): string {
  if (lang === null || text === "") return escapeHtml(text);
  return tokenize(text, lang)
    .map((tok) =>
      tok.cls === "plain"
        ? escapeHtml(tok.text)
        : `<span class="hl hl-${tok.cls}">${escapeHtml(tok.text)}</span>`,
    )
    .join("");
}

function inlineHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "text":
          return escapeHtml(n.text);
        case "br":
          return "<br>";
        case "code":
          return `<code class="x-md-code">${escapeHtml(n.text)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(n.children)}</strong>`;
        case "em":
          return `<em>${inlineHtml(n.children)}</em>`;
        case "del":
          return `<del>${inlineHtml(n.children)}</del>`;
        case "link":
          // href is null unless the parser vetted the protocol; escaping on top
          // means the attribute cannot be broken out of either way.
          return n.href !== null
            ? `<a href="${escapeHtml(n.href)}" target="_blank" rel="noopener noreferrer">${inlineHtml(n.children)}</a>`
            : `<span>${inlineHtml(n.children)}</span>`;
      }
    })
    .join("");
}

function listHtml(list: Extract<Block, { kind: "list" }>): string {
  const items = list.items
    .map((item) => `<li>${inlineHtml(item.children)}${item.sub !== null ? listHtml(item.sub) : ""}</li>`)
    .join("");
  if (!list.ordered) return `<ul>${items}</ul>`;
  return `<ol${list.start !== 1 ? ` start="${escapeHtml(String(list.start))}"` : ""}>${items}</ol>`;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      return `<h${level}>${inlineHtml(block.children)}</h${level}>`;
    }
    case "para":
      return `<p>${inlineHtml(block.children)}</p>`;
    case "code": {
      const lang = block.lang !== null ? hlLangForFence(block.lang) : null;
      const name = block.lang !== null && block.lang !== "" ? block.lang : "text";
      return (
        `<div class="x-pre"><div class="x-pre-lang">${escapeHtml(name)}</div>` +
        `<pre><code>${codeHtml(block.text, lang)}</code></pre></div>`
      );
    }
    case "list":
      return listHtml(block);
    case "quote":
      return `<blockquote>${block.children.map(blockHtml).join("")}</blockquote>`;
    case "hr":
      return "<hr>";
    case "table": {
      const cell = (tag: "th" | "td", nodes: readonly Inline[], align: string | null): string => {
        // align comes from the parser's closed union, so it is safe inline.
        const style = align !== null ? ` style="text-align:${align}"` : "";
        return `<${tag}${style}>${inlineHtml(nodes)}</${tag}>`;
      };
      const head = block.header.map((c, i) => cell("th", c, block.align[i] ?? null)).join("");
      const rows = block.rows
        .map((row) => `<tr>${row.map((c, i) => cell("td", c, block.align[i] ?? null)).join("")}</tr>`)
        .join("");
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  }
}

function markdownHtml(text: string): string {
  return `<div class="x-md">${parseMarkdown(text).map(blockHtml).join("")}</div>`;
}

// ---- chat -------------------------------------------------------------------

function badge(agentId: string): string {
  // agentAccent returns one of four constant var() names — never session data.
  return (
    `<span class="x-badge" style="--agent-color:${agentAccent(agentId)}">` + `${escapeHtml(agentId)}</span>`
  );
}

function toolHtml(card: ToolCard, lang: Lang): string {
  const denied = card.permission === "denied";
  const status = denied
    ? label(lang, "denied")
    : card.status === "pending"
      ? label(lang, "noResult")
      : card.status;
  const chips: string[] = [];
  if (card.permission !== undefined) {
    chips.push(
      `<span class="x-chip x-chip--${card.permission}">${escapeHtml(label(lang, card.permission))}</span>`,
    );
  }
  chips.push(
    `<span class="x-chip${card.status === "error" ? " x-chip--error" : ""}">${escapeHtml(status)}</span>`,
  );
  if (card.durationMs !== undefined) {
    chips.push(`<span class="x-chip">${escapeHtml(formatDuration(card.durationMs))}</span>`);
  }
  const line = card.status === "error" ? "var(--error)" : denied ? "var(--warn)" : "var(--border)";
  // Open by default: a collapsed command in a file attached to a ticket is a
  // command nobody reads. The reader can fold it away; the record is complete.
  const parts = [
    `<details class="x-tool" open style="--line-color:${line}">`,
    `<summary><span class="x-tool-name">${escapeHtml(card.name)}</span>`,
    card.agentId !== "main" ? badge(card.agentId) : "",
    `<span class="x-tool-preview">${escapeHtml(compactJson(card.input))}</span>`,
    chips.join(""),
    "</summary>",
    `<div class="x-body">`,
    `<div class="x-io">${escapeHtml(label(lang, "input"))}</div>`,
    `<pre><code>${codeHtml(prettyJson(card.input), "json")}</code></pre>`,
  ];
  // A denied call produced no output — printing an empty block would suggest it ran.
  if (card.output !== undefined && !denied) {
    parts.push(
      `<div class="x-io">${escapeHtml(label(lang, "output"))}</div>`,
      `<pre>${escapeHtml(card.output)}</pre>`,
    );
  }
  parts.push("</div></details>");
  return parts.join("");
}

function assistantMeta(turn: Extract<Turn, { kind: "assistant" }>): string {
  if (turn.usage === undefined) return "";
  const bits = [`${turn.usage.inputTokens} in`];
  if (turn.usage.cacheReadTokens !== undefined && turn.usage.cacheReadTokens > 0) {
    bits.push(`${turn.usage.cacheReadTokens} cache read`);
  }
  if (turn.usage.cacheCreationTokens !== undefined && turn.usage.cacheCreationTokens > 0) {
    bits.push(`${turn.usage.cacheCreationTokens} cache write`);
  }
  bits.push(`${turn.usage.outputTokens} out`);
  if (turn.durationMs !== undefined) bits.push(formatDuration(turn.durationMs));
  if (turn.endTs !== undefined && turn.durationMs !== undefined) {
    bits.push(`${utcClock(turn.endTs - turn.durationMs)} → ${utcClock(turn.endTs)} UTC`);
  }
  if (turn.model !== undefined) bits.push(turn.model);
  return `<div class="x-assistant-meta">${escapeHtml(bits.join(" · "))}</div>`;
}

function turnHtml(turn: Turn, state: UiState, lang: Lang, inThread: boolean): string {
  switch (turn.kind) {
    case "user": {
      const thumbs = (turn.attachments ?? [])
        // A data: URI is bytes in the file, not a fetch — the document stays offline.
        .map(
          (a) =>
            `<img alt="${escapeHtml(a.name)}" style="max-width:160px;border-radius:7px;margin:4px 0 0 4px"` +
            ` src="data:${escapeHtml(a.mediaType)};base64,${escapeHtml(a.dataBase64)}">`,
        )
        .join("");
      return (
        `<article class="x-user"><div class="x-eyebrow">${escapeHtml(label(lang, "you"))}</div>` +
        thumbs +
        `<div class="x-user-text">${escapeHtml(turn.text)}</div></article>`
      );
    }
    case "assistant": {
      const parts = ['<article class="x-assistant">'];
      if (turn.agentId !== "main" && !inThread) parts.push(badge(turn.agentId));
      if (turn.thinking !== "") {
        // Collapsed like the app's default disclosure; the summary says how much
        // is folded away, so nothing is hidden by surprise.
        parts.push(
          `<details class="x-think"><summary>${escapeHtml(label(lang, "reasoning"))} · ` +
            `${escapeHtml(label(lang, "chars", { n: turn.thinking.length }))}</summary>` +
            `<div class="x-think-body">${escapeHtml(turn.thinking)}</div></details>`,
        );
      }
      if (turn.text !== "") parts.push(`<div class="x-answer">${markdownHtml(turn.text)}</div>`);
      parts.push(assistantMeta(turn), "</article>");
      return parts.join("");
    }
    case "tool": {
      const card = state.cards[turn.callId];
      return card !== undefined ? toolHtml(card, lang) : "";
    }
    case "info":
      return `<div class="x-info x-info--${turn.tone}">${escapeHtml(turn.text)}</div>`;
    case "error":
      return (
        `<div class="x-error"><div class="x-eyebrow">${escapeHtml(label(lang, "error"))}</div>` +
        `<div class="x-error-text">${escapeHtml(turn.text)}</div></div>`
      );
  }
}

/**
 * The chat tab as one file: prompts, answers, reasoning, and every tool call
 * with its command and its result. Folded through the app's own reducer and
 * thread grouping, so the export is the view rather than a second reading of it.
 */
export function chatToHtml(events: readonly RunEvent[], opts: ExportOptions = {}): string {
  const lang: Lang = opts.lang ?? "en";
  const state = reduceAll(initialState, [...events]);
  const blocks = groupTurns(state.turns, state.cards, state.agents);
  const body =
    blocks.length === 0
      ? `<p class="x-empty">${escapeHtml(label(lang, "empty"))}</p>`
      : blocks
          .map((b) => {
            if (b.kind === "turn") return turnHtml(b.turn, state, lang, false);
            const head = [
              badge(b.agentId),
              b.label !== null ? `<span class="x-thread-task">${escapeHtml(b.label)}</span>` : "",
              b.task !== "" ? `<span class="x-thread-task">${escapeHtml(b.task)}</span>` : "",
            ].join("");
            const items = b.items.map((it) => turnHtml(it.turn, state, lang, true)).join("");
            return (
              `<section class="x-thread" style="--agent-color:${agentAccent(b.agentId)}">` +
              `<div class="x-thread-head">${head}</div>${items}</section>`
            );
          })
          .join("\n");
  // Only what the record actually measured: a session with no usage event gets
  // no token line rather than a pair of zeros that reads as "nothing was used".
  const measured = state.usage.inputTokens > 0 || state.usage.outputTokens > 0;
  const foot = [
    // provider/model come from run_start, so an archive names its backend too.
    [state.provider, state.runModel].filter((s) => s !== null && s !== "").join(" · "),
    measured ? label(lang, "totals", { in: state.usage.inputTokens, out: state.usage.outputTokens }) : "",
    state.lastStopReason !== null ? label(lang, "ended", { reason: state.lastStopReason }) : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
  return wrapDocument({ kind: "chat", events, opts, body, foot });
}

// ---- text feed --------------------------------------------------------------

/**
 * The text tab as one file: the same fold the tab renders (buildTextFeed), with
 * the protocol markers visible as text. `extended` mirrors the tab's toggle.
 */
export function textFeedToHtml(events: readonly RunEvent[], opts: ExportOptions = {}): string {
  const lang: Lang = opts.lang ?? "en";
  const feed = buildTextFeed(events, opts.extended === true);
  const body =
    feed.length === 0
      ? `<p class="x-empty">${escapeHtml(label(lang, "empty"))}</p>`
      : `<div class="x-feed">` +
        feed
          .map((s) => {
            const agent =
              s.agentId !== "main" && s.agentId !== ""
                ? `<span class="x-tf-agent">[${escapeHtml(s.agentId)}]</span>`
                : "";
            return `<div class="x-tf x-tf--${s.kind}">${agent}${escapeHtml(s.text)}</div>`;
          })
          .join("") +
        `</div>`;
  return wrapDocument({
    kind: "text",
    events,
    opts,
    body,
    foot: label(lang, "events", { n: events.length }),
  });
}

// ---- saving -----------------------------------------------------------------

/** Punctuation that would confuse a file system, folded to single dashes. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** spectroscope-chat-incident-4712-20260727-1203.html */
export function exportFilename(kind: "chat" | "text", labelText?: string, now: number = Date.now()): string {
  const d = new Date(now);
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  const name = labelText !== undefined ? slug(labelText) : "";
  return `spectroscope-${kind}${name !== "" ? `-${name}` : ""}-${stamp}.html`;
}

/**
 * Hands the document to the browser's own save dialog. A blob URL rather than a
 * data: URI because a long session exceeds what some browsers accept in a URL;
 * the revoke waits a tick, since revoking in the same one cancels the download.
 */
export function saveHtml(filename: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
