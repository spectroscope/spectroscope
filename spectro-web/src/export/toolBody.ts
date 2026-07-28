// A tool call, drawn in an exported file as what it actually IS: a file with a
// path and a body, a command at a prompt, an edit with two sides, a decision put
// to a person. The app learned this with card 94; the export had learned half of
// it — it lifted multi-line fields out of the JSON (splitInput) but still drew
// every call as its JSON shape, so a read_file arrived as `{ "path": "auth.ts" }`
// over two lines of unlabelled output.
//
// THE SHAPE, AND WHY THIS IS NOT ToolViewBody.tsx.
// The classification lives in ONE place — describeTool in components/toolViews.
// It is pure, DOM-free and already shared with the collapsed-row teaser. What
// the two renderers do not share is markup, and they must not: the card has
// state (a markdown face to toggle, a clip with the raw payload one click away,
// an <img> that can fail over to a notice), and every one of those is a thing an
// exported file cannot have. So this module is a second WRITER over the same
// verdict: one function per `kind`, in a table keyed by the union's own tag.
//
// That keying is the point. A record typed `{ [K in ToolView["kind"]]: … }`
// cannot compile with a kind missing, and toolBody.drift.test.ts reads the union
// out of toolViews.ts to catch the case a type could not: a new kind quietly
// pointed at the generic writer. The gap this module closes appeared exactly
// that way — as a silent fallback nobody had to notice.
//
// Three deliberate divergences from the card, all of them because a file is not
// an app:
//   - NOTHING IS CLIPPED. The card cuts long bodies at 4000 characters because
//     the raw face is one click away. Here there is no second face and no way
//     back to the session, so a clip would be data loss in the one artifact that
//     exists to prevent it.
//   - NO PICTURE. A generated image lives in the app's content-addressed store
//     behind /api/images; an <img> pointing there is a network fetch, and this
//     file has to open from file:// with the network unplugged. The path is
//     printed and the absence is stated.
//   - NO MARKDOWN FACE. The card offers to render a .md body; the export ships
//     the bytes, which is the card's own default and the honest one — rendering
//     consumes the characters a reader came to check.

import type { Lang } from "../i18n/i18n";
import type { AskedQuestion, QuestionOption, ToolView } from "../components/toolViews";
import { splitInput } from "../components/toolViews";
import type { HlLang } from "../workspace/highlight";
import { hlLangForPath } from "../workspace/highlight";
import { prettyJson } from "../format";
import { codeHtml, escapeHtml, label } from "./markup";

/** What a writer knows besides the view: the tool's wire name (splitInput reads
 *  some keys per tool) and the language of the document's chrome. */
export interface ToolContext {
  name: string;
  lang: Lang;
}

// ---- the pieces every shape is built from -----------------------------------

/** A region's eyebrow: the word for it, and what it measures. */
function head(text: string, meta?: string): string {
  const m = meta === undefined || meta === "" ? "" : `<span class="x-tv-meta">${escapeHtml(meta)}</span>`;
  return `<div class="x-io">${escapeHtml(text)}${m}</div>`;
}

/** A block of someone else's text, coloured only where the language is known
 *  and never clipped (see the file header). */
function well(text: string, lang: HlLang | null = null, cls = ""): string {
  const attr = cls === "" ? "" : ` class="${cls}"`;
  return `<pre${attr}><code>${codeHtml(text, lang)}</code></pre>`;
}

/** The headline of most calls: the thing the tool acted on. */
const pathLine = (text: string): string => `<div class="x-tv-path">${escapeHtml(text)}</div>`;

/** Rows rather than a blob — a listing and a match list are line-shaped. */
function list(items: readonly string[], dirs = false): string {
  const rows = items
    .map((item) => {
      const cls = dirs && item.endsWith("/") ? "x-tv-item x-tv-item--dir" : "x-tv-item";
      return `<li class="${cls}">${escapeHtml(item)}</li>`;
    })
    .join("");
  return `<ul class="x-tv-list">${rows}</ul>`;
}

/** An output region, left out entirely when there is nothing in it: an empty
 *  well under the word "output" reads as a tool that answered with silence. */
function outputHtml(text: string, lang: Lang, cls = ""): string {
  return text === "" ? "" : head(label(lang, "output")) + well(text, null, cls);
}

/**
 * An input object as the shape plus the text — the card's InputRegions, in
 * markup: the JSON keeps the keys and the scalars, and every multi-line string
 * gets its own well under its OWN key.
 *
 * This is what the export already did for every call. It is now what it does for
 * the calls whose shape nobody named, which is the only place it belongs.
 */
function inputHtml(input: unknown, ctx: ToolContext, key = "input"): string {
  const split = splitInput(ctx.name, input);
  const parts = [head(label(ctx.lang, key)), well(prettyJson(split.shape), "json")];
  for (const block of split.blocks) {
    // The label is the payload's own word, so it is escaped like any other
    // untrusted string on its way into an element.
    parts.push(head(block.key), well(block.text, block.lang));
  }
  return parts.join("");
}

/** One offered choice. The pick is marked three ways that survive a reader who
 *  cannot tell the accent from the text colour: the glyph, the word, and the
 *  label at full strength while the others recede. */
function optionHtml(option: QuestionOption, lang: Lang): string {
  const chosen = option.chosen ? `<span class="x-tv-chosen">${escapeHtml(label(lang, "chosen"))}</span>` : "";
  return (
    `<li class="x-tv-opt${option.chosen ? " x-tv-opt--chosen" : ""}">` +
    `<span class="x-tv-mark" aria-hidden="true">${option.chosen ? "✓" : ""}</span>` +
    `<div class="x-tv-opt-body">` +
    `<div><span class="x-tv-opt-label">${escapeHtml(option.label)}</span>${chosen}</div>` +
    (option.description === null ? "" : `<div class="x-tv-desc">${escapeHtml(option.description)}</div>`) +
    (option.preview === null ? "" : well(option.preview)) +
    `</div></li>`
  );
}

/**
 * What became of one question, under its options.
 *
 * The four-way branch is describeTool's own `answered`, read here directly
 * rather than through the card's answerFace: that helper is a PRESENTATION
 * decision made in a React module, and this file makes its own from the same
 * verdict. Same classification, different markup — which is the whole seam.
 *
 * `option` adds nothing: describeTool reports it only when the answer text is
 * the labels themselves, so the marks above already carry every word of it.
 */
function answerHtml(q: AskedQuestion, lang: Lang): string {
  switch (q.answered) {
    case "option":
      return "";
    case "text":
      return head(label(lang, "answer")) + well(q.answer ?? "", null, "x-tv-prose");
    case "dismissed":
      return `<p class="x-tv-note">${escapeHtml(label(lang, "dismissed"))}</p>`;
    case "none":
      return `<p class="x-tv-note">${escapeHtml(label(lang, "unanswered"))}</p>`;
  }
}

function questionHtml(q: AskedQuestion, lang: Lang): string {
  const tag = q.header === null ? "" : `<span class="x-tv-ask-tag">${escapeHtml(q.header)}</span>`;
  const meta = [
    label(lang, "optionsN", { n: q.options.length }),
    q.multiSelect ? label(lang, "multiSelect") : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
  return (
    `<li class="x-tv-ask">` +
    `<div>${tag}<span class="x-tv-ask-q">${escapeHtml(q.question)}</span></div>` +
    `<div class="x-tv-ask-meta">${escapeHtml(meta)}</div>` +
    `<ul class="x-tv-opts">${q.options.map((o) => optionHtml(o, lang)).join("")}</ul>` +
    answerHtml(q, lang) +
    `</li>`
  );
}

// ---- one writer per kind ----------------------------------------------------

type WriterFor<V extends ToolView> = (view: V, ctx: ToolContext) => string;

/** Keyed by the union's own tag: a kind added to toolViews and not drawn here
 *  is a compile error in this object, not a shrug at runtime. */
type Writers = { [K in ToolView["kind"]]: WriterFor<Extract<ToolView, { kind: K }>> };

export const TOOL_HTML: Writers = {
  file: (view, { lang }) =>
    head(
      label(lang, "file"),
      view.range ?? (view.lineCount > 0 ? label(lang, "lines", { n: view.lineCount }) : ""),
    ) +
    pathLine(view.path) +
    (view.body === "" ? "" : head(label(lang, "content")) + well(view.body, hlLangForPath(view.path))),

  // The content of a write is a file body too, and the one about to be on disk
  // is the one worth reading byte for byte.
  write: (view, { lang }) =>
    head(label(lang, "wrote"), view.result) +
    pathLine(view.path) +
    head(label(lang, "content")) +
    well(view.content, hlLangForPath(view.path)),

  // Uncoloured, unlike the two file bodies above and like the card: an anchor is
  // a FRAGMENT of a file, and a fragment that opens inside a string literal or a
  // comment tokenizes as something it is not. The labels carry the meaning and
  // the border carries the side, so nothing here needs a claim about the syntax.
  edit: (view, { lang }) =>
    head(label(lang, "edited"), view.result) +
    pathLine(view.path) +
    `<div class="x-tv-diff">` +
    `<div class="x-tv-side x-tv-side--before">${head(label(lang, "before"))}${well(view.before)}</div>` +
    `<div class="x-tv-side x-tv-side--after">${head(label(lang, "after"))}${well(view.after)}</div>` +
    `</div>`,

  listing: (view, { lang }) =>
    head(label(lang, "listing"), label(lang, "entries", { n: view.entries.length })) +
    pathLine(view.path) +
    list(view.entries, true),

  matches: (view, { lang }) =>
    head(label(lang, "matches"), label(lang, "hits", { n: view.lines.length })) +
    `<div class="x-tv-path"><span class="x-tv-pattern">${escapeHtml(view.pattern)}</span>` +
    (view.path === null ? "" : `<span class="x-tv-in"> · ${escapeHtml(view.path)}</span>`) +
    `</div>` +
    list(view.lines),

  command: (view, { lang }) =>
    head(label(lang, "command")) +
    `<pre class="x-tv-cmd"><code><span class="x-tv-prompt" aria-hidden="true">$ </span>` +
    `${codeHtml(view.command, "shell")}</code></pre>` +
    outputHtml(view.output, lang, `x-tv-term${view.failed ? " x-tv-term--failed" : ""}`),

  // No <img>: the store is behind /api/images and this file has to open with the
  // network unplugged. The path is the record; the absence is stated rather than
  // left as a broken frame someone reads as "the file is gone".
  image: (view, { lang }) =>
    head(label(lang, "image"), view.result) +
    (view.prompt === null ? "" : `<div class="x-tv-desc">${escapeHtml(view.prompt)}</div>`) +
    (view.source === null
      ? ""
      : `<div class="x-tv-src">${escapeHtml(view.source)}</div>` +
        `<p class="x-tv-note">${escapeHtml(label(lang, "noImage"))}</p>`),

  skill: (view, { lang }) =>
    head(label(lang, "skill")) +
    pathLine(view.name) +
    (view.body === "" ? "" : head(label(lang, "content")) + well(view.body)),

  // Each server owns its tools' schemas, so the payload travels on unread — the
  // two names are the only part this can honestly interpret.
  mcp: (view, ctx) =>
    head(label(ctx.lang, "mcp")) +
    `<div class="x-tv-path"><span class="x-tv-server">${escapeHtml(view.server)}</span>` +
    `<span class="x-tv-in"> · </span>` +
    `<span class="x-tv-pattern">${escapeHtml(view.tool)}</span></div>` +
    inputHtml(view.input, ctx) +
    outputHtml(view.output, ctx.lang),

  agents: (view, { lang }) =>
    head(label(lang, "agents"), label(lang, "agentsN", { n: view.children.length })) +
    `<ul class="x-tv-agents">` +
    view.children
      .map(
        (child) =>
          `<li><div><span class="x-tv-agent-type">${escapeHtml(child.type)}</span>` +
          (child.label === null ? "" : `<span class="x-tv-in">${escapeHtml(child.label)}</span>`) +
          `</div>${well(child.task, null, "x-tv-prose")}</li>`,
      )
      .join("") +
    `</ul>` +
    outputHtml(view.result, lang, "x-tv-prose"),

  // The status stays the wire word the plan wrote. The app's translated badge
  // lives in a component, and a second copy of that table here would be a second
  // thing to drift — while the word itself is the record.
  plan: (view, { lang }) =>
    head(label(lang, "plan"), label(lang, "steps", { n: view.steps.length })) +
    `<ul class="x-tv-plan">` +
    view.steps
      .map(
        (step) =>
          `<li class="x-tv-step"><span class="x-tv-step-text">${escapeHtml(step.text)}</span>` +
          (step.status === null ? "" : `<span class="x-tv-status">${escapeHtml(step.status)}</span>`) +
          `</li>`,
      )
      .join("") +
    `</ul>`,

  // Several questions in one call are several blocks, in the order they were
  // asked — the result may list its answers in any order, but the asking had one.
  question: (view, { lang }) =>
    head(
      label(lang, "question"),
      view.questions.length > 1 ? label(lang, "questionsN", { n: view.questions.length }) : "",
    ) + `<ul class="x-tv-asks">${view.questions.map((q) => questionHtml(q, lang)).join("")}</ul>`,

  web: (view, { lang }) =>
    (view.url === null ? "" : head(label(lang, "fetch")) + pathLine(view.url)) +
    (view.query === null
      ? ""
      : head(label(lang, "search")) +
        `<div class="x-tv-path"><span class="x-tv-pattern">${escapeHtml(view.query)}</span></div>`) +
    // A fetched page and a result list are prose, not code.
    outputHtml(view.body, lang, "x-tv-prose"),

  // The reader's order: what this workflow is, how far it goes, then the code.
  workflow: (view, ctx) =>
    (view.name === null && view.description === null
      ? ""
      : head(label(ctx.lang, "workflow")) +
        (view.name === null ? "" : pathLine(view.name)) +
        (view.description === null ? "" : `<div class="x-tv-desc">${escapeHtml(view.description)}</div>`)) +
    (view.phases.length === 0
      ? ""
      : head(label(ctx.lang, "phases"), label(ctx.lang, "phasesN", { n: view.phases.length })) +
        list(view.phases)) +
    (view.scriptPath === null ? "" : head(label(ctx.lang, "file")) + pathLine(view.scriptPath)) +
    (view.script === null ? "" : head(label(ctx.lang, "script")) + well(view.script, "javascript")) +
    (view.args === undefined ? "" : inputHtml(view.args, ctx, "args")) +
    outputHtml(view.result, ctx.lang),

  generic: (view, ctx) => inputHtml(view.input, ctx) + outputHtml(view.output, ctx.lang),
};

/**
 * The kinds that are DRAWN AS the raw pair on purpose.
 *
 * `generic` is the raw pair by definition — it is what describeTool returns when
 * it did not understand the payload, and printing the shape is the honest answer.
 * Anything else in this list is a decision someone has to make in the open:
 * toolBody.drift.test.ts requires every kind outside it to render differently
 * from the raw pair, which is what a new kind wired to `generic` would not.
 */
export const DRAWN_AS_RAW: ReadonlyArray<ToolView["kind"]> = ["generic"];

/**
 * One tool call as static markup, from the same verdict the card renders.
 *
 * @param view the describeTool result for this call
 * @param ctx  the tool's wire name and the document's language
 * @return markup for the inside of the card's body
 */
export function toolViewHtml(view: ToolView, ctx: ToolContext): string {
  const write = TOOL_HTML[view.kind] as WriterFor<ToolView>;
  return write(view, ctx);
}

// ---- rules ------------------------------------------------------------------

// Literal lengths, not the app's spacing tokens: an exported file carries only
// the colour tokens themes.ts writes into it, and a var() with nothing behind it
// collapses a rule silently. Colour comes from those tokens and nowhere else.
//
// No color-mix() and no :has(): this file gets opened in whatever browser the
// person on the other end happens to have, which is the same reason the tab
// strip is sibling combinators. The edit's two sides are told apart by their
// labels and by a plain border, so nothing depends on a young colour function.
export const TOOL_CSS = `
.x-tv-meta{margin-left:8px;color:var(--text-faint);letter-spacing:0;text-transform:none}
.x-tv-path{margin:0 0 6px;font-family:var(--font-mono);font-size:12px;color:var(--text);
  overflow-wrap:anywhere}
.x-tv-src{margin:0 0 4px;font-family:var(--font-mono);font-size:11px;color:var(--text-faint);
  overflow-wrap:anywhere}
.x-tv-pattern{color:var(--accent)}
.x-tv-in{color:var(--text-faint)}
.x-tv-server{color:var(--text-dim)}
.x-tv-desc{margin:0 0 6px;font-size:13px;color:var(--text-dim);overflow-wrap:anywhere}
.x-tv-note{margin:6px 0 0;font-size:11px;color:var(--text-faint)}
.x-tv-list{margin:0;padding:0;list-style:none;font-family:var(--font-mono);font-size:12px}
.x-tv-item{padding:1px 0;color:var(--text-dim);overflow-wrap:anywhere}
.x-tv-item--dir{color:var(--text)}
.x-tv-prompt{color:var(--accent)}
.x-tv-term{color:var(--text-dim)}
.x-tv-term--failed{color:var(--error)}
.x-tv-prose{font-family:var(--font-ui);font-size:13px}
.x-tv-diff{display:flex;flex-direction:column;gap:8px}
.x-tv-side{display:flex;flex-direction:column;min-width:0}
.x-tv-side--before>pre{border-left:2px solid var(--error)}
.x-tv-side--after>pre{border-left:2px solid var(--ok)}
@media(min-width:900px){.x-tv-diff{flex-direction:row}.x-tv-side{flex:1}}
.x-tv-agents{margin:0;padding:0;list-style:none}
.x-tv-agents>li+li{margin-top:8px}
.x-tv-agent-type{margin-right:8px;font-family:var(--font-mono);font-size:12px;color:var(--accent)}
.x-tv-plan{margin:0;padding:0;list-style:none}
.x-tv-step{display:flex;align-items:baseline;gap:8px;padding:1px 0}
.x-tv-step-text{flex:1;min-width:0;font-size:13px;color:var(--text-dim);overflow-wrap:anywhere}
.x-tv-status{border:1px solid var(--border-strong);border-radius:7px;padding:0 6px;
  font-family:var(--font-mono);font-size:11px;color:var(--text-dim);white-space:nowrap}
.x-tv-asks{margin:0;padding:0;list-style:none}
.x-tv-ask+.x-tv-ask{margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.x-tv-ask-tag{margin-right:8px;border:1px solid var(--border);border-radius:999px;padding:0 6px;
  font-family:var(--font-mono);font-size:11px;color:var(--text-dim);white-space:nowrap}
.x-tv-ask-q{font-size:14px;color:var(--text);overflow-wrap:anywhere}
.x-tv-ask-meta{margin:2px 0 6px;color:var(--text-faint);font-family:var(--font-mono);font-size:11px}
.x-tv-opts{margin:0;padding:0;list-style:none}
.x-tv-opt{display:flex;gap:8px;padding:1px 0}
.x-tv-mark{flex:none;width:1em;font-family:var(--font-mono);color:var(--text-faint);text-align:center}
.x-tv-opt-body{flex:1;min-width:0}
.x-tv-opt-label{font-size:13px;color:var(--text-dim);overflow-wrap:anywhere}
.x-tv-opt--chosen .x-tv-mark{color:var(--accent)}
.x-tv-opt--chosen .x-tv-opt-label{color:var(--text);font-weight:500}
.x-tv-chosen{margin-left:8px;border:1px solid var(--accent);border-radius:999px;padding:0 6px;
  font-size:11px;color:var(--accent);white-space:nowrap}
`;
