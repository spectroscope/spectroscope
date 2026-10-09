// The bar that says what an import was, and which session it belongs to.
//
// The bar is dismissible, so holding it in its own state is right. What was
// missing is the other half: it describes ONE loaded file, and the reader can
// leave that file without dismissing anything. Stamping the session id on the
// bar and checking it at render time is the whole fix, and it is a pure
// function so the rule is pinned rather than left to a stray effect.

import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import type { ImportedRunSummary } from "../import/claudeCodeRun";
import type { ImportKind } from "../import/detect";
import type { SubagentTranscript } from "../import/subagentFile";
import type { SourceStats } from "../state/traceSource";

/** The conversation, in the units a reader counts it in (card 440). */
export interface ConversationCounts {
  /** The turns with words the chat draws on the person's side: each root run's
   *  prompt, every steering message, and every later message the importer
   *  read as not the model's words. In a subagent transcript that side holds
   *  what the parent agent sent. */
  prompts: number;
  /** The main agent's responses: one per turn a root agent opened. */
  answers: number;
}

/** What the bar states, plus the session it states it about. */
export interface ImportBarState {
  /** The replay id this bar describes ("import:claude-code:<file>"). */
  sessionId: string;
  file: string;
  /** The importer's own numbers, shown behind the details control. */
  stats: SourceStats;
  counts: ConversationCounts;
  /** The notes for special kinds of file ({@link importBarNote}), or null. */
  note: string | null;
  /** The file is one agent's transcript, not a session (card 152), so the
   *  bar's own sentence does not call it a session. */
  agentTranscript: boolean;
}

/** The bar's text: what it says, and the raw numbers behind "Details". */
export interface ImportBarText {
  said: string;
  details: string;
}

/**
 * The bar to render, if any.
 *
 * @param bar     the bar the last import raised, or null once dismissed
 * @param session the replay currently on screen, null for the live session
 * @return the bar when it describes THAT session, otherwise nothing
 */
export function shownImportBar(bar: ImportBarState | null, session: string | null): ImportBarState | null {
  return bar !== null && bar.sessionId === session ? bar : null;
}

/**
 * What the bar says about a file that was one agent's transcript (card 152).
 *
 * A subagent transcript presented as an ordinary session is a second false
 * statement on top of the one the counts made: the reader is told this is a
 * session, when it is one agent lifted out of another session's run. The file
 * names its own agent, and often the session it ran under and the kind of agent
 * it was, so the bar can state all three without inventing any of them.
 *
 * Every clause is conditional, the rule import/sourceNotes.ts states in full: a
 * fact the file does not carry produces NOTHING, not a blank and not a
 * placeholder id. The parent session is a pointer to where the rest of the run
 * lives, which is the one thing a reader of this file goes looking for.
 *
 * @param lang the chrome language
 * @param sub  what the file said about itself, or nothing for a session file
 * @return the sentence, or null when there is nothing of the kind to say
 */
export function subagentNote(lang: Lang, sub: SubagentTranscript | null | undefined): string | null {
  if (!sub) return null;
  const parts = [t(lang, "imp.subagent", { agent: sub.agentId })];
  if (sub.attributionAgent !== undefined)
    parts.push(t(lang, "imp.subagentKind", { kind: sub.attributionAgent }));
  if (sub.sessionId !== undefined) parts.push(t(lang, "imp.subagentSession", { session: sub.sessionId }));
  return parts.join(" ");
}

/**
 * What the bar says about the children a run import carried (card 291).
 *
 * Only a run import — a session picked together with its subagents/ set —
 * ever constructs a summary, so a lone-file import keeps its bar exactly as
 * it was. A run whose directory held no sidecars at all says nothing either:
 * "0 children merged" would read as a defect where there was simply nothing
 * to merge. Skips are stated whenever they happened, the worker chip's rule:
 * the honest count is both halves or neither.
 *
 * Card 297 adds a third half to the same rule: a workflow run's state file
 * can NAME an agent whose transcript is not beside the session at all. That
 * is neither merged nor skipped — nothing was there to skip — and it is said
 * whenever it happened, for the same reason a skip is: without it the run
 * quietly shows fewer agents than it reported.
 *
 * @param lang the chrome language
 * @param run  what the coordinator measured, or nothing for a lone file
 * @return the sentence(s), or null when there is nothing of the kind to say
 */
export function childrenNote(lang: Lang, run: ImportedRunSummary | null | undefined): string | null {
  if (!run || (run.childrenMerged === 0 && run.childrenSkipped === 0 && run.childrenUnrecorded === 0))
    return null;
  const parts = [t(lang, "imp.childrenMerged", { n: run.childrenMerged })];
  if (run.childrenSkipped > 0) parts.push(t(lang, "imp.childrenSkipped", { n: run.childrenSkipped }));
  if (run.childrenUnrecorded > 0)
    parts.push(t(lang, "imp.childrenUnrecorded", { n: run.childrenUnrecorded }));
  return parts.join(" ");
}

/**
 * The conversation an imported stream holds, counted as the chat shows it.
 *
 * A prompt is a turn with words that the chat draws on the person's side: the
 * prompt of a run that has no parent, every `user_message` the importer
 * emitted, and every `steering_message`, read by the run or not (card 380
 * draws both). The wire says only that a `user_message` is not the model's
 * words, so in a merged run a parent's message to its child counts here too,
 * the same way it shows in the chat. An empty prompt counts for nothing: an
 * export that opens mid-session starts its run with one, because the request
 * is not in the file. A picture sent without words is left out as well: the
 * importer gives each such picture its own bubble, so counting those bubbles
 * would count pictures, not messages.
 *
 * An answer is one response of a root agent, which is what a `turn_start`
 * marks in every format this importer reads. A child agent's runs and turns
 * are left out: the bar's children note speaks for them.
 *
 * @param events the imported stream
 * @return the two counts
 */
export function conversationCounts(events: readonly RunEvent[]): ConversationCounts {
  const roots = new Set<string>();
  let prompts = 0;
  let answers = 0;
  for (const event of events) {
    if (event.type === "run_start") {
      if (event.parentId != null) continue;
      roots.add(event.agentId);
      if (event.prompt !== "") prompts++;
    } else if (event.type === "turn_start") {
      if (roots.has(event.agentId)) answers++;
    } else if (event.type === "steering_message") {
      if (event.text !== "") prompts++;
    } else if ((event as { type: string }).type === "user_message") {
      const text = (event as unknown as { text?: unknown }).text;
      if (typeof text === "string" && text !== "") prompts++;
    }
  }
  return { prompts, answers };
}

const grouped = (n: number, lang: Lang): string => n.toLocaleString(lang === "de" ? "de-DE" : "en-US");

/**
 * What the bar says (card 440).
 *
 * One sentence names the file and the conversation and says the session is only
 * shown; for a subagent transcript it says the transcript is, because the
 * subagent note after it says the file is not a session. The notes for special
 * kinds of file follow it. Lines, frames and the
 * lines the importer could not match stay in `details`, for whoever wants to
 * check the counts. No sentence names the unmatched lines: owner call 2 on the
 * card (option D) measured them on every recent Claude Code file, nearly all of
 * them records the importer skips on purpose.
 *
 * @param lang the chrome language
 * @param bar  the bar the import raised
 * @return the sentence(s) and the raw numbers
 */
export function importBarText(lang: Lang, bar: ImportBarState): ImportBarText {
  const { prompts, answers } = bar.counts;
  const { lines, frames, zeroLines } = bar.stats;
  const said = [
    // The file name is filled last, so a name that looks like a slot stays a name.
    t(lang, bar.agentTranscript ? "imp.openedTranscript" : "imp.opened", {
      prompts: t(lang, prompts === 1 ? "imp.promptsOne" : "imp.prompts", { n: grouped(prompts, lang) }),
      answers: t(lang, answers === 1 ? "imp.answersOne" : "imp.answers", { n: grouped(answers, lang) }),
      file: bar.file,
    }),
  ];
  if (bar.note !== null) said.push(bar.note);
  return {
    said: said.join(" "),
    details: t(lang, "imp.detailsCounts", {
      lines: grouped(lines, lang),
      frames: grouped(frames, lang),
      zero: grouped(zeroLines, lang),
    }),
  };
}

/**
 * The notes a special kind of file adds to the bar, in a fixed order.
 *
 * The VS Code note is about a FORMAT's limits (that export records that each
 * tool ran and whether it succeeded, never what it returned); the subagent note
 * is about what THIS file is (card 152); the children note is what a run import
 * carried (card 291); `extra` is a sentence the store owes the reader, such as
 * a run that fell back to its session file (card 318); `found` is what came
 * with a spectroscope session file: its wires and child sessions (card 473).
 *
 * @param lang  the chrome language
 * @param about what the import knows about the file
 * @return the notes joined, or null when there is none
 */
export function importBarNote(
  lang: Lang,
  about: {
    kind: ImportKind;
    subagent?: SubagentTranscript | null;
    run?: ImportedRunSummary | null;
    extra?: string | null;
    /** Card 473: what came with a spectroscope session file, said once. */
    found?: string | null;
  },
): string | null {
  const notes = [
    about.kind === "vscode-agent" ? t(lang, "imp.vscodeNote") : null,
    subagentNote(lang, about.subagent),
    childrenNote(lang, about.run),
    about.extra ?? null,
    about.found ?? null,
  ].filter((line): line is string => line !== null && line !== "");
  return notes.length > 0 ? notes.join(" ") : null;
}

/**
 * The parts of the bar that follow from what kind of file was opened: the notes
 * and whether the file is one agent's transcript. Both come from this one call,
 * so a bar that carries the subagent note never calls the file a session.
 *
 * @param lang  the chrome language
 * @param about what the import knows about the file
 * @return the note and the transcript flag for {@link ImportBarState}
 */
export function importBarAbout(
  lang: Lang,
  about: Parameters<typeof importBarNote>[1],
): Pick<ImportBarState, "note" | "agentTranscript"> {
  return { note: importBarNote(lang, about), agentTranscript: about.subagent != null };
}
