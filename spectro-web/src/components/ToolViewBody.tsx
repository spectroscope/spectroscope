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

import { useMemo, useState } from "react";
import type { AskedQuestion, QuestionOption, ToolView, WorkflowRun } from "./toolViews";
import { describeTool, runStats, splitInput } from "./toolViews";
import { bodyFace, markdownBody } from "./bodyFace";
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
 * A file's body: a markdown file as the document it is, everything else coloured
 * by its language, and either one a click from the other.
 *
 * Which face opens is `bodyFace()`, and the argument it decides against — a tool
 * result is evidence, and rendering spends the bytes a reader came to check —
 * is written out there rather than here, because it is the reason the text chip
 * can never be removed.
 */
function Body(props: { label: string; path: string; text: string; lang: Lang }) {
  const [manual, setManual] = useState<boolean | null>(null);
  // Both faces are clipped at the same place, so the "(truncated)" line is the
  // last thing the rendered one shows too — and the probes run on the clip, not
  // on a body no reader will see.
  const text = cut(props.text);
  const face = useMemo(() => bodyFace(props.path, text), [props.path, text]);
  // The disclosure pattern: a hand-made pick outlives the default, because a
  // reader who switched this card meant this card. It cannot outlive the FILE,
  // though: React reuses an element in place, so a pick made on a .md would
  // otherwise ride along when this same slot draws the next call's .ts.
  const md = markdownBody(props.path);
  const rendered = md && (manual ?? face.rendered);
  return (
    <Region
      label={props.label}
      faces={md ? <BodyFaces rendered={rendered} onPick={setManual} lang={props.lang} /> : undefined}
    >
      {face.note !== null && <p className="tv-note">{t(props.lang, face.note)}</p>}
      {rendered ? (
        <div className="tv-md">
          <Markdown text={text} />
        </div>
      ) : (
        <pre className="tv-well mono">{highlight(text, hlLangForPath(props.path))}</pre>
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

/**
 * What became of a launched workflow: the scannable row, then every agent that
 * did not come back.
 *
 * The failures sit in a region of their own, directly under the numbers and
 * above the script — not folded into the status word, and not a footnote. The
 * outcome reports `completed` even when every agent in it hit a spend limit,
 * because that word is the workflow ENGINE finishing, not the work; a card that
 * repeats it alone reads as a clean run to the one person who most needs to know
 * it was not. The count is in the row in the error colour AND the agents are
 * named underneath, so neither a glance nor a read can miss it.
 */
function RunOutcome({ run, lang }: { run: WorkflowRun; lang: Lang }) {
  return (
    <>
      <Region label={t(lang, "tv.outcome")} meta={run.status === "" ? undefined : run.status}>
        <ul className="tv-run">
          {runStats(run).map((stat) => (
            <li key={stat.key} className={stat.bad ? "tv-run-stat tv-run-stat--bad" : "tv-run-stat"}>
              <span className="tv-run-k">{t(lang, `tv.run.${stat.key}`)}</span>
              <span className="tv-run-v mono tabular">{stat.value}</span>
            </li>
          ))}
        </ul>
      </Region>
      {run.failures.length > 0 && (
        <Region label={t(lang, "tv.failures")} meta={t(lang, "tv.failuresN", { n: run.failures.length })}>
          <ul className="tv-fails">
            {run.failures.map((f, i) => (
              <li key={i} className="tv-fail">
                {f.label !== null && <span className="tv-fail-who mono">{f.label}</span>}
                {f.phase !== null && <span className="tv-in">{f.phase}</span>}
                <span className="tv-fail-why">{f.reason}</span>
              </li>
            ))}
          </ul>
        </Region>
      )}
      {/* Counted but unnamed. An empty list under the word "failures" would read
          as none at all, so the number says so in its own sentence instead. */}
      {run.failures.length === 0 && run.errors !== null && run.errors > 0 && (
        <p className="tv-note tv-note--bad">{t(lang, "tv.wfUnnamed", { n: run.errors })}</p>
      )}
    </>
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
          {/* A lifted block with a language is a program, and it gets the room
              a program needs. A lifted block without one is prose or data, and
              the ordinary well is the right size for it. */}
          <pre className={`tv-well mono${block.lang === null ? "" : " tv-well--script"}`}>
            {highlight(fit(block.text), block.lang)}
          </pre>
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

    case "task": {
      // The heading carries the verb, so the row never has to. That is why an
      // update reads "#3 · done" and not "→ done": the call names the state it
      // asked for and never the one it came from, and an arrow with nothing on
      // its left invites a reader to look for a from-state that is not here.
      const heading =
        view.op === "create" ? "tv.taskCreated" : view.op === "update" ? "tv.taskUpdated" : "tv.tasks";
      return (
        <Region
          label={t(lang, heading)}
          // Only a roster is counted: a creation and an update are one task
          // each, and "1 task" under a heading that already said which verb ran
          // is noise. An empty roster is not called "0 tasks" either — a listing
          // with nothing back yet reads the same as a list with nothing in it,
          // and only one of those means there are no tasks.
          meta={
            view.op === "list" && view.rows.length > 0
              ? t(lang, "tv.tasksN", { n: view.rows.length })
              : undefined
          }
        >
          <ul className="tv-tasks">
            {view.rows.map((row, i) => (
              <li key={i} className="tv-task">
                <div className="tv-task-head">
                  {row.id !== null && <span className="tv-task-id mono">#{row.id}</span>}
                  {/* The agent-card dot/badge, same as the plan above, so a
                      state reads identically wherever it shows up. */}
                  {row.status !== null && (
                    <>
                      <span className={`agent-dot agent-dot--${row.status}`} aria-hidden="true" />
                      <span className={`agent-badge agent-badge--${row.status}`}>
                        {statusLabel(row.status, lang)}
                      </span>
                    </>
                  )}
                  {row.subject !== null && <span className="tv-task-subject">{row.subject}</span>}
                </div>
                {/* The substance of a creation, and the reason a plan step could
                    never have held one: a step is its text and nothing under it. */}
                {row.description !== null && <div className="tv-desc">{row.description}</div>}
                {row.blockedBy.length > 0 && (
                  <p className="tv-note">
                    {t(lang, "tv.taskBlockedBy", {
                      ids: row.blockedBy.map((id) => `#${id}`).join(", "),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {view.wrote === "nothing" && <p className="tv-note">{t(lang, "tv.taskUnchanged")}</p>}
          {/* Empty whenever the outcome line was read: it names the id and
              echoes the subject, both of which the row above already carries.
              What lands here is an error, and a shape never swallows one. */}
          {view.result !== "" && <pre className="tv-well mono">{cut(view.result)}</pre>}
        </Region>
      );
    }

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
          {/* The two states a silent card would misreport. `done` needs no line
              (the numbers are the line) and `pending` needs none either — the
              card already reads as open while the call is on the wire. */}
          {view.stage === "launched" && <p className="tv-note">{t(lang, "tv.wfOpen")}</p>}
          {view.stage === "failed" && <p className="tv-note">{t(lang, "tv.wfFailed")}</p>}
          {view.run !== null && <RunOutcome run={view.run} lang={lang} />}
          {view.phases.length > 0 && (
            <Region label={t(lang, "tv.phases")} meta={t(lang, "tv.phasesN", { n: view.phases.length })}>
              <ul className="tv-entries mono">
                {view.phases.map((phase, i) => {
                  // Only failures are marked. `agents_done` is a count with no
                  // names in it, so nothing here can say a phase SUCCEEDED —
                  // and a green tick nobody measured is the worse lie.
                  const dead = view.run?.failures.filter((f) => f.phase === phase).length ?? 0;
                  return (
                    <li key={i} className="tv-entry">
                      <span className="tv-in tabular">{i + 1} </span>
                      {phase}
                      {dead > 0 && (
                        <span className="tv-phase-dead"> {t(lang, "tv.wfDead", { n: dead })}</span>
                      )}
                    </li>
                  );
                })}
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
              <pre className="tv-well tv-well--script mono">{highlight(cut(view.script), "javascript")}</pre>
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
          {/* Last, and prose rather than code: what a run returned is an agent's
              words and runs to tens of thousands of characters. Available, one
              scroll away, and never the first thing on the card. */}
          {view.run !== null && view.run.result !== "" && (
            <Region label={t(lang, "tv.returned")}>
              <pre className="tv-well">{cut(view.run.result)}</pre>
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
