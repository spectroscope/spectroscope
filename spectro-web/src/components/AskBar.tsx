// The ask surface (card 265): the run has stopped and is waiting for a person.
// Cloned from GateBar — same slot, same "render only pending[0]" rule, same
// violet "waiting on you" line — and deliberately NOT the same component.
//
// The reason is one keystroke. PermissionDialog maps Escape to `decide(false)`:
// deny is the safe default at a gate, and a denial is a verdict a gate can
// honestly report. A question has no such verdict. Escape here would turn a
// keystroke somebody pressed to get their cursor back into an answer, and that
// answer would sit in the session file forever. So Escape does nothing at all on
// this bar; the only ways out are picking an option, typing one, or clicking skip
// on purpose.
//
// The question renders as plain text, never as markdown with links: it is
// model-authored text, and a model that read a hostile page must not be able to
// draw a link in the operator's own chrome.

import { useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { PendingAsk } from "../state/reducer";
import { agentAccent } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** What a keystroke means on the ask bar. Exported so the rule is provable
 *  without a DOM — and consulted by the handler below, so it cannot rot into a
 *  decoration beside a handler that does something else.
 *
 *  The handler lives on the SECTION, so every keystroke on the bar reaches it,
 *  including one meant for a button that has focus. That is why WHERE the key was
 *  pressed is half the rule: on a button, Enter is the button's own — it is the
 *  keystroke the browser turns into a click, and the bar cancelling it once meant
 *  an option could not be picked with the keyboard and Enter on Skip sent the
 *  typed text as the answer.
 *
 *  @param key       the KeyboardEvent key
 *  @param targetTag tag name of the element the key was pressed on (any case;
 *                   "" when the event carries no element)
 *  @return "submit" for Enter on the bar itself; "button" for Enter on a button,
 *          which the bar must hand back untouched; "ignore" for everything else,
 *          Escape included */
export function askKeyAction(key: string, targetTag: string): "submit" | "button" | "ignore" {
  if (key !== "Enter") return "ignore";
  return targetTag.toLowerCase() === "button" ? "button" : "submit";
}

export function AskBar(props: {
  pending: PendingAsk[];
  /** Sends the answer. `cancelled` is the skip: released, never answered — an
   *  empty answers array with cancelled false would be a person saying nothing,
   *  which is a different fact from nobody saying anything. */
  onAnswer: (callId: string, answers: string[], cancelled: boolean) => void;
}) {
  const lang = useLang();
  const [chosen, setChosen] = useState<string[]>([]);
  const [typed, setTyped] = useState("");

  const current = props.pending[0];
  if (current === undefined) return null;
  const question = current.questions[0];
  if (question === undefined) return null;

  const clear = (): void => {
    setChosen([]);
    setTyped("");
  };

  const send = (answers: string[], cancelled: boolean): void => {
    props.onAnswer(current.callId, answers, cancelled);
    clear();
  };

  /** One option chip. A single-choice question answers immediately — the click
   *  IS the answer; a multi-select one collects until Send. */
  const pick = (label: string): void => {
    if (question.multiSelect !== true) {
      send([label], false);
      return;
    }
    setChosen((now) => (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]));
  };

  /** What is currently answerable: the picked labels, else the typed words. The
   *  labels are joined with ", " because that is the wording the transcript
   *  renderer reads back into the marks on the options. */
  const answerNow = (): string[] => {
    if (chosen.length > 0) return [chosen.join(", ")];
    return typed.trim() === "" ? [] : [typed.trim()];
  };

  const submit = (): void => {
    const answers = answerNow();
    if (answers.length === 0) return; // nothing to send; Enter on an empty bar is a no-op
    send(answers, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The tag off the event, never an instanceof: this runs in the browser and is
    // reasoned about in a suite with no DOM, and a tag name is the same fact in
    // both places.
    const tag = (event.target as { tagName?: string } | null)?.tagName ?? "";
    if (askKeyAction(event.key, tag) !== "submit") return;
    // Only the bar's own Enter is cancelled — a form submit or a page scroll.
    // Doing this for a button would cancel the click the browser was about to
    // synthesize, which is exactly how picking an option with the keyboard broke.
    event.preventDefault();
    submit();
  };

  return (
    <section className="ask-bar" aria-label={t(lang, "ask.aria")} onKeyDown={onKeyDown}>
      <div className="gate-line pulse" aria-hidden="true" />
      <div className="ask-head">
        <span className="ask-kicker mono">{t(lang, "ask.kicker")}</span>
        <span
          className="agent-badge"
          style={{ "--agent-color": agentAccent(current.agentId) } as CSSProperties}
        >
          {current.agentId}
        </span>
        {question.header !== undefined && question.header !== "" && (
          <span className="ask-header">{question.header}</span>
        )}
        {props.pending.length > 1 && (
          <span className="ask-queue mono tabular">
            {t(lang, "ask.queue", { n: props.pending.length - 1 })}
          </span>
        )}
      </div>
      <p className="ask-question">{question.question}</p>
      <div className="ask-options">
        {question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`ask-option${chosen.includes(option.label) ? " ask-option--chosen" : ""}`}
            aria-pressed={question.multiSelect === true ? chosen.includes(option.label) : undefined}
            onClick={() => pick(option.label)}
          >
            <span className="ask-option-label">{option.label}</span>
            {option.description !== undefined && option.description !== "" && (
              <span className="ask-option-desc">{option.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="ask-row">
        <input
          className="ask-text"
          type="text"
          value={typed}
          placeholder={t(lang, "ask.placeholder")}
          aria-label={t(lang, "ask.placeholder")}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="button" className="ask-skip" onClick={() => send([], true)}>
          {t(lang, "ask.skip")}
        </button>
        <button type="button" className="ask-send" disabled={answerNow().length === 0} onClick={submit}>
          {t(lang, "ask.send")}
        </button>
      </div>
      <p className="ask-notice">{t(lang, "ask.notice")}</p>
    </section>
  );
}
