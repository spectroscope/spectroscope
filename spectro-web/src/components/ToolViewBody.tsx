// The three faces of a tool call (card 94), rendered from the pure
// describeTool() shape:
//   structured — the default: each tool AS ITSELF (a file with its path, an
//                edit as before/after, a listing as a list, a command in a
//                terminal well). Nothing is dropped; the raw payload is one
//                click away.
//   json       — input and output as collapsible trees (JsonTree, the trace's).
//   raw        — exactly what the card always showed: the two pre blocks.
//
// The look is deliberately light (owner: "filigraner"): hairlines instead of
// boxes, one quiet label per region, the mono well only where content is
// genuinely code.

import { useState } from "react";
import type { AskedQuestion, QuestionOption, ToolView } from "./toolViews";
import { describeTool, splitInput } from "./toolViews";
import { JsonTree } from "./JsonTree";
import { Markdown } from "./Markdown";
import { prettyJson } from "../format";
import { t } from "../i18n/i18n";
import { highlight } from "./Highlighted";
import { hlLangForPath } from "../workspace/highlight";
import { imageUrl } from "../lab/flowmap/imageUrl";
import { statusLabel } from "./PlanTab";
import { useLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

/** Visible clip for long bodies — the full payload lives in raw/json. */
const CLIP_CHARS = 4000;

const cut = (s: string, max = CLIP_CHARS): string =>
  s.length > max ? `${s.slice(0, max)}\n... (truncated)` : s;

/** One labeled region — the hairline label the light look leans on. `faces` is
 *  the trailing slot for a region that has more than one way to be read. */
function Region(props: { label: string; meta?: string; faces?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tv-region">
      <div className="tv-region-head">
        <span className="tv-label">{props.label}</span>
        {props.meta !== undefined && <span className="tv-meta tabular">{props.meta}</span>}
        {props.faces}
      </div>
      {props.children}
    </div>
  );
}

/** Where a question's answer is legible. */
export type AnswerFace =
  | { show: "marks" }
  | { show: "words"; text: string }
  | { show: "note"; key: "tv.dismissed" | "tv.unanswered" };

/**
 * Which face of a question carries its answer: the marks on the options, the
 * person's own words, or a line stating that no answer came.
 *
 * `option` adds nothing under the list. describeTool reports it only when the
 * answer text consists of the labels themselves, so the marks already carry
 * every word of it and a copy underneath would read as a second answer. What
 * that drops is the ORDER the labels were listed in; for a set of choices it
 * claims nothing, and the raw face still has the sentence.
 *
 * A dismissal is stated in our own words on purpose. The harness writes the
 * refusal into the answer slot as an instruction to the model ("do not proceed,
 * wait for next instruction"), which read by a person is a command, not a reply.
 */
export function answerFace(q: AskedQuestion): AnswerFace {
  switch (q.answered) {
    case "option":
      return { show: "marks" };
    case "text":
      return { show: "words", text: q.answer ?? "" };
    case "dismissed":
      return { show: "note", key: "tv.dismissed" };
    case "none":
      return { show: "note", key: "tv.unanswered" };
  }
}

/** Extensions whose body may be offered as rendered prose. `mdx` is absent
 *  deliberately: it is JSX inside markdown, and this parser reads a component
 *  tag as text and its braces as prose — a render that is wrong about the file. */
const MD_EXT = new Set(["md", "markdown"]);

/**
 * Whether a path names a markdown file.
 *
 * The extension decides, and the body is never sniffed: a `#` on the first line
 * of a log is a character someone typed, and promoting it to a heading would be
 * the chrome inventing structure the file does not have.
 *
 * @param path the path the tool named, as it named it
 * @return true when the body is markdown by the file's own name
 */
export function markdownBody(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? false : MD_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** The two ways to read a markdown body, as chips in the region's own head. */
function BodyFaces(props: { rendered: boolean; onPick: (rendered: boolean) => void; lang: Lang }) {
  return (
    <div
      className="tv-faces"
      role="group"
      aria-label={t(props.lang, "tv.bodyAria")}
      title={t(props.lang, "tv.bodyHint")}
    >
      {[false, true].map((face) => (
        <button
          key={String(face)}
          type="button"
          className={`tv-mode${props.rendered === face ? " tv-mode--on" : ""}`}
          aria-pressed={props.rendered === face}
          onClick={() => props.onPick(face)}
        >
          {t(props.lang, face ? "tv.bodyMd" : "tv.bodyText")}
        </button>
      ))}
    </div>
  );
}

/**
 * A file's body, coloured by the file's language — and for a markdown file, with
 * the rendered face one click away.
 *
 * Text is the default, and that is the decision, not an omission: a tool result
 * is EVIDENCE. Colouring lays a class over every byte and moves none of them,
 * which is why every other well here is coloured; rendering markdown CONSUMES
 * bytes — the hashes of a heading, the pipes of a table, the two trailing spaces
 * that became a line break are gone from the screen. A reader who came to check
 * whether an Edit's anchor is really in this file cannot check it against prose.
 * So the bytes are what a reader gets without asking, and the reading face is a
 * click they take on purpose.
 */
function Body(props: { label: string; path: string; text: string; lang: Lang }) {
  const [rendered, setRendered] = useState(false);
  const md = markdownBody(props.path);
  return (
    <Region
      label={props.label}
      faces={md ? <BodyFaces rendered={rendered} onPick={setRendered} lang={props.lang} /> : undefined}
    >
      {md && rendered ? (
        // Both faces are clipped at the same place, so the "(truncated)" line is
        // the last thing the rendered one shows too.
        <div className="tv-md">
          <Markdown text={cut(props.text)} />
        </div>
      ) : (
        <pre className="tv-well mono">{highlight(cut(props.text), hlLangForPath(props.path))}</pre>
      )}
    </Region>
  );
}

/** What became of one question, under its options. */
function AnswerLine({ q, lang }: { q: AskedQuestion; lang: Lang }) {
  const face = answerFace(q);
  if (face.show === "marks") return null;
  if (face.show === "note") return <p className="tv-note">{t(lang, face.key)}</p>;
  return (
    <div className="tv-ask-answer">
      <span className="tv-label">{t(lang, "tv.answer")}</span>
      {/* A `pre` because a typed answer carries its own line breaks; the reading
          face comes from the stylesheet, since a bare `pre` would inherit the
          browser's generic monospace. */}
      <pre className="tv-well">{cut(face.text)}</pre>
    </div>
  );
}

/** One offered choice. The pick is marked THREE ways that survive a reader who
 *  cannot tell the accent from the text colour: the check glyph, the word, and
 *  the label at full strength while the others recede. */
function Option({ option, lang }: { option: QuestionOption; lang: Lang }) {
  return (
    <li className={option.chosen ? "tv-opt tv-opt--chosen" : "tv-opt"}>
      <span className="tv-opt-mark" aria-hidden="true">
        {option.chosen ? "✓" : ""}
      </span>
      <div className="tv-opt-body">
        <div className="tv-opt-head">
          <span className="tv-opt-label">{option.label}</span>
          {option.chosen && <span className="tv-chosen">{t(lang, "tv.chosen")}</span>}
        </div>
        {option.description !== null && <div className="tv-desc">{option.description}</div>}
        {/* The fourth field the corpus carries: a sample of what picking this
            would do. Multi-line, so it gets a well of its own. */}
        {option.preview !== null && <pre className="tv-well mono">{cut(option.preview)}</pre>}
      </div>
    </li>
  );
}

/** The picture itself. A store blob can be gone (a scripted session, a cleaned
 *  store, a build with no backend behind it), so onError falls back to a frame
 *  that SAYS the image is unavailable — never a broken-image glyph, and never a
 *  decorative stand-in that could pass for the picture. */
function ImageBlob({ src, alt, lang }: { src: string; alt: string; lang: Lang }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return <p className="tv-imggone">{t(lang, "tv.imageGone")}</p>;
  }
  return <img className="tv-img" src={src} alt={alt} onError={() => setBroken(true)} />;
}

/**
 * An input object as the shape plus the text: the JSON keeps the keys and the
 * scalars, and every multi-line string gets its own labelled well underneath.
 *
 * This is the fallback path, so it carries the tools nobody wrote a shape for —
 * including MCP tools whose schemas we deliberately never read. The label is the
 * field's own key, untranslated: it is the payload's word, not our chrome.
 *
 * The clip is the trace's convenience and a gate's hazard, which is why it is a
 * prop: a record has the raw face one click away, a permission dialog has no
 * second chance — whatever it hides gets approved unread. Callers on a decision
 * surface pass `clip={false}` and bound the box instead.
 */
export function InputRegions(props: {
  label: string;
  name: string;
  input: unknown;
  lang: Lang;
  clip?: boolean;
}) {
  const split = splitInput(props.name, props.input);
  const fit = (s: string): string => (props.clip === false ? s : cut(s));
  return (
    <>
      <Region label={props.label}>
        <pre className="tv-well mono">{fit(prettyJson(split.shape))}</pre>
      </Region>
      {split.blocks.map((block) => (
        <Region key={block.key} label={block.key}>
          <pre className="tv-well mono">{highlight(fit(block.text), block.lang)}</pre>
        </Region>
      ))}
    </>
  );
}

/** The structured face — one branch per tool shape. */
function Structured({ view, name, lang }: { view: ToolView; name: string; lang: Lang }) {
  switch (view.kind) {
    case "file":
      return (
        <>
          <Region
            label={t(lang, "tv.file")}
            meta={view.range ?? (view.lineCount > 0 ? t(lang, "tv.lines", { n: view.lineCount }) : undefined)}
          >
            <div className="tv-path mono">{view.path}</div>
          </Region>
          {view.body !== "" && (
            <Body label={t(lang, "tv.content")} path={view.path} text={view.body} lang={lang} />
          )}
        </>
      );

    case "write":
      return (
        <>
          <Region label={t(lang, "tv.wrote")} meta={view.result}>
            <div className="tv-path mono">{view.path}</div>
          </Region>
          {/* The same two faces as a read: the content of a write is a file body
              too, and the one about to be on disk is the one worth checking
              byte for byte. */}
          <Body label={t(lang, "tv.content")} path={view.path} text={view.content} lang={lang} />
        </>
      );

    case "edit":
      return (
        <>
          <Region label={t(lang, "tv.edited")} meta={view.result}>
            <div className="tv-path mono">{view.path}</div>
          </Region>
          <div className="tv-diff">
            <div className="tv-diff-side tv-diff-side--before">
              <span className="tv-label">{t(lang, "tv.before")}</span>
              <pre className="tv-well mono">{cut(view.before)}</pre>
            </div>
            <div className="tv-diff-side tv-diff-side--after">
              <span className="tv-label">{t(lang, "tv.after")}</span>
              <pre className="tv-well mono">{cut(view.after)}</pre>
            </div>
          </div>
        </>
      );

    case "listing":
      return (
        <Region label={t(lang, "tv.listing")} meta={t(lang, "tv.entries", { n: view.entries.length })}>
          <div className="tv-path mono">{view.path}</div>
          <ul className="tv-entries mono">
            {view.entries.map((entry, i) => (
              <li key={i} className={entry.endsWith("/") ? "tv-entry tv-entry--dir" : "tv-entry"}>
                {entry}
              </li>
            ))}
          </ul>
        </Region>
      );

    case "matches":
      return (
        <Region label={t(lang, "tv.matches")} meta={t(lang, "tv.hits", { n: view.lines.length })}>
          <div className="tv-path mono">
            <span className="tv-pattern">{view.pattern}</span>
            {view.path !== null && <span className="tv-in"> · {view.path}</span>}
          </div>
          <ul className="tv-entries mono">
            {view.lines.map((line, i) => (
              <li key={i} className="tv-entry">
                {line}
              </li>
            ))}
          </ul>
        </Region>
      );

    case "command":
      return (
        <>
          <Region label={t(lang, "tv.command")}>
            <div className="tv-cmd mono">
              <span className="tv-prompt" aria-hidden="true">
                $
              </span>
              {highlight(view.command, "shell")}
            </div>
          </Region>
          {view.output !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className={`tv-well tv-term mono${view.failed ? " tv-term--failed" : ""}`}>
                {cut(view.output)}
              </pre>
            </Region>
          )}
        </>
      );

    case "image":
      return (
        <>
          <Region label={t(lang, "tv.image")} meta={view.result === "" ? undefined : view.result}>
            {view.prompt !== null && <div className="tv-path">{view.prompt}</div>}
            {view.source !== null && <div className="tv-src mono">{view.source}</div>}
          </Region>
          {view.preview !== null && (
            <ImageBlob src={imageUrl(view.preview)} alt={view.prompt ?? t(lang, "tv.image")} lang={lang} />
          )}
          {/* Honest about WHY there is no picture: the store serves its own
              content-addressed files, so a workspace image has no URL at all. */}
          {view.source !== null && view.preview === null && (
            <p className="tv-note">{t(lang, "tv.noPreview")}</p>
          )}
        </>
      );

    case "mcp":
      return (
        <>
          <Region label={t(lang, "tv.mcp")}>
            <div className="tv-path mono">
              <span className="tv-server">{view.server}</span>
              <span className="tv-in"> · </span>
              <span className="tv-pattern">{view.tool}</span>
            </div>
          </Region>
          {/* Each server owns its tools' schemas, so the payload is shown as it
              came — the name is the only part we can honestly interpret. */}
          <InputRegions label={t(lang, "tv.input")} name={name} input={view.input} lang={lang} />
          {view.output !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className="tv-well mono">{cut(view.output)}</pre>
            </Region>
          )}
        </>
      );

    case "agents":
      return (
        <>
          <Region label={t(lang, "tv.agents")} meta={t(lang, "tv.agentsN", { n: view.children.length })}>
            <ul className="tv-agents">
              {view.children.map((child, i) => (
                <li key={i} className="tv-agent">
                  <div className="tv-agent-head">
                    <span className="tv-agent-type mono">{child.type}</span>
                    {child.label !== null && <span className="tv-in">{child.label}</span>}
                  </div>
                  <pre className="tv-well">{cut(child.task)}</pre>
                </li>
              ))}
            </ul>
          </Region>
          {view.result !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className="tv-well">{cut(view.result)}</pre>
            </Region>
          )}
        </>
      );

    case "plan":
      return (
        <Region label={t(lang, "tv.plan")} meta={t(lang, "tv.steps", { n: view.steps.length })}>
          {/* The agent-card dot/badge vocabulary, same as the Plan tab, so a step
              reads identically wherever it shows up and reskins with the design. */}
          <ul className="tv-plan">
            {view.steps.map((step, i) => (
              <li key={i} className="tv-step">
                {step.status !== null && (
                  <span className={`agent-dot agent-dot--${step.status}`} aria-hidden="true" />
                )}
                <span className="tv-step-text">{step.text}</span>
                {step.status !== null && (
                  <span className={`agent-badge agent-badge--${step.status}`}>
                    {statusLabel(step.status, lang)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Region>
      );

    case "question":
      return (
        <Region
          label={t(lang, "tv.question")}
          meta={
            view.questions.length > 1 ? t(lang, "tv.questionsN", { n: view.questions.length }) : undefined
          }
        >
          {/* Several questions in one call are several blocks, in the order they
              were asked — the result may list its answers in any order, but the
              asking had one. */}
          <ul className="tv-asks">
            {view.questions.map((q, i) => (
              <li key={i} className="tv-ask">
                <div className="tv-ask-head">
                  {q.header !== null && <span className="tv-ask-tag">{q.header}</span>}
                  <span className="tv-ask-q">{q.question}</span>
                </div>
                <div className="tv-ask-meta">
                  <span className="tv-in">{t(lang, "tv.optionsN", { n: q.options.length })}</span>
                  {q.multiSelect && <span className="tv-in"> · {t(lang, "tv.multiSelect")}</span>}
                </div>
                <ul className="tv-opts">
                  {q.options.map((option, j) => (
                    <Option key={j} option={option} lang={lang} />
                  ))}
                </ul>
                <AnswerLine q={q} lang={lang} />
              </li>
            ))}
          </ul>
        </Region>
      );

    case "web":
      return (
        <>
          {view.url !== null && (
            <Region label={t(lang, "tv.fetch")}>
              <div className="tv-path mono">{view.url}</div>
            </Region>
          )}
          {view.query !== null && (
            <Region label={t(lang, "tv.search")}>
              <div className="tv-path">
                <span className="tv-pattern">{view.query}</span>
              </div>
            </Region>
          )}
          {view.body !== "" && (
            <Region label={t(lang, "tv.output")}>
              {/* A fetched page and a result list are prose, not code. */}
              <pre className="tv-well">{cut(view.body)}</pre>
            </Region>
          )}
        </>
      );

    case "skill":
      return (
        <>
          <Region label={t(lang, "tv.skill")}>
            <div className="tv-path mono">{view.name}</div>
          </Region>
          {view.body !== "" && (
            <Region label={t(lang, "tv.content")}>
              <pre className="tv-well mono">{cut(view.body)}</pre>
            </Region>
          )}
        </>
      );

    case "workflow":
      return (
        <>
          {/* The reader's order: what this workflow is, how far it goes, then
              the code — and the code is never withheld over a header that would
              not parse. A script named only by path HAS no header, so the region
              is left out entirely rather than shown as an empty label; the card
              already carries the tool's name. */}
          {(view.name !== null || view.description !== null) && (
            <Region label={t(lang, "tv.workflow")}>
              {view.name !== null && <div className="tv-path mono">{view.name}</div>}
              {view.description !== null && <div className="tv-desc">{view.description}</div>}
            </Region>
          )}
          {view.phases.length > 0 && (
            <Region label={t(lang, "tv.phases")} meta={t(lang, "tv.phasesN", { n: view.phases.length })}>
              <ul className="tv-entries mono">
                {view.phases.map((phase, i) => (
                  <li key={i} className="tv-entry">
                    <span className="tv-in tabular">{i + 1} </span>
                    {phase}
                  </li>
                ))}
              </ul>
            </Region>
          )}
          {view.scriptPath !== null && (
            <Region label={t(lang, "tv.file")}>
              <div className="tv-path mono">{view.scriptPath}</div>
            </Region>
          )}
          {view.script !== null && (
            <Region label={t(lang, "tv.script")}>
              <pre className="tv-well mono">{highlight(cut(view.script), "javascript")}</pre>
            </Region>
          )}
          {view.args !== undefined && (
            <InputRegions label={t(lang, "tv.args")} name={name} input={view.args} lang={lang} />
          )}
          {view.result !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className="tv-well mono">{cut(view.result)}</pre>
            </Region>
          )}
        </>
      );

    case "generic":
      return (
        <>
          <InputRegions label={t(lang, "tv.input")} name={name} input={view.input} lang={lang} />
          {view.output !== "" && (
            <Region label={t(lang, "tv.output")}>
              <pre className="tv-well mono">{cut(view.output)}</pre>
            </Region>
          )}
        </>
      );
  }
}

/** Output parsed as JSON when it IS JSON — else null (most outputs are text). */
function parseMaybeJson(output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function ToolViewBody(props: {
  mode: "structured" | "json" | "raw";
  name: string;
  input: unknown;
  output?: string;
  isError: boolean;
  denied: boolean;
}) {
  const lang = useLang();

  if (props.denied) {
    return <p className="tv-denied">{t(lang, "tool.deniedByUser")}</p>;
  }

  if (props.mode === "structured") {
    return (
      <Structured
        view={describeTool(props.name, props.input, props.output, props.isError)}
        name={props.name}
        lang={lang}
      />
    );
  }

  if (props.mode === "json") {
    const parsed = props.output !== undefined ? parseMaybeJson(props.output) : null;
    return (
      <>
        <Region label={t(lang, "tv.input")}>
          <JsonTree value={props.input} defaultDepth={2} />
        </Region>
        {props.output !== undefined && (
          <Region label={t(lang, "tv.output")}>
            {parsed !== null ? (
              <JsonTree value={parsed} defaultDepth={2} />
            ) : (
              /* Honest: a text output is not JSON — say so rather than fake a tree. */
              <>
                <p className="tv-note">{t(lang, "tv.notJson")}</p>
                <pre className="tv-well mono">{cut(props.output)}</pre>
              </>
            )}
          </Region>
        )}
      </>
    );
  }

  return (
    <>
      <Region label={t(lang, "tv.input")}>
        <pre className="tv-well mono">{cut(prettyJson(props.input))}</pre>
      </Region>
      <Region label={t(lang, "tv.output")}>
        <pre className={`tv-well mono${props.isError ? " tv-well--error" : ""}`}>
          {props.output === undefined ? t(lang, "tv.pending") : cut(props.output)}
        </pre>
      </Region>
    </>
  );
}
