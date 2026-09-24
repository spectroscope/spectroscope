// The progress guard's three counts, the turn ceiling and the leash budget —
// the five numbers that decide when a run has to come back to a person.
//
// Cards 281 and 282. Everything here was configurable through the settings
// chain already and had no control anywhere: card 262 recorded that gap itself
// rather than hiding it, and the owner met the turn ceiling as a run that ended
// on a green tool result with no closing word.
//
// Three ReachBlocks, not one. The guard's three counts are bound when the agent
// is built, maxTurns likewise, and continuationBudget is re-read per prompt —
// reachOf() throws on a mixed block, which is the machinery card 222 left
// behind so a page cannot promise a reach it does not have.

import { t, type Lang } from "../i18n/i18n";
import type { SettingsView } from "../state/serverSettings";
import { NumberField } from "./settingsNumberField";
import { OriginRow } from "./settingsOrigin";
import { ReachBlock } from "./settingsReach";
import {
  PROGRESS_FIELDS,
  armedState,
  progressSummary,
  type ProgressCounts,
  type ProgressField,
} from "./progressSection";

/** Reads a count out of the resolved view, tolerating a null the server sends
 *  for a field no layer set. */
function count(view: SettingsView, field: string): number {
  const raw = view.effective[field];
  return typeof raw === "number" ? raw : 0;
}

/** One count, with the chip that says whether it is watching.
 *
 *  The chip's state goes on `data-progress-state` and never on the sentence:
 *  in German "scharf" is a substring of "unscharf" and "aus" of
 *  "ausgeschaltet", so a test reading the rendered word would be green for the
 *  opposite of what it means. */
function CountField({
  view,
  field,
  lang,
  onSave,
}: {
  view: SettingsView;
  field: ProgressField;
  lang: Lang;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const value = count(view, field);
  const state = armedState(value);
  return (
    <label className="settings-field" data-progress-state={state} data-progress-field={field}>
      <span>{t(lang, `set.progress.${field}`)}</span>
      <NumberField view={view} field={field} lang={lang} onSave={onSave} />
      <span className="settings-chip" data-progress-state={state}>
        {t(lang, state === "armed" ? "set.progress.chipArmed" : "set.progress.chipOff")}
      </span>
      <p className="settings-note">{t(lang, `set.progress.${field}Note`)}</p>
      <OriginRow view={view} field={field} lang={lang} onReset={() => onSave({ [field]: null })} />
    </label>
  );
}

/**
 * The whole section.
 *
 * @param props.anchorId what a deep link scrolls to
 * @param props.view     the resolved settings view
 * @param props.lang     the operator's language
 * @param props.onSave   writes a patch to the USER scope
 * @returns the section
 */
export function ProgressGuardSettings({
  anchorId,
  view,
  lang,
  onSave,
}: {
  anchorId: string;
  view: SettingsView;
  lang: Lang;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const counts = Object.fromEntries(
    PROGRESS_FIELDS.map((field) => [field, count(view, field)]),
  ) as ProgressCounts;
  const summary = progressSummary(counts);
  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secProgress")}
      </div>
      <p className="settings-note">{t(lang, "set.progressHint")}</p>
      {/* One derived summary, fed by the SAME function as the chips above, so
        the two cannot disagree. Nothing armed gets its own sentence rather than
        "0 of 3" — a count reads as a number somebody chose. */}
      <p className="settings-note" data-progress-summary={summary.armed}>
        {t(lang, summary.key, { armed: summary.armed, total: summary.total })}
      </p>
      {/* Criterion 9: the guard only runs where somebody can answer it. Saying
        so is not a nicety — spectro run, cron fires and fleet nodes register no
        guard at all, and a page implying otherwise would be true of two faces
        out of five. */}
      <p className="settings-note">{t(lang, "set.progress.whereItRuns")}</p>
      {/* The three names are written out here rather than passed as
        PROGRESS_FIELDS, and that is not redundancy. settingsReach.test.tsx
        WALKS this file's source to check that no block promises a reach its
        fields do not have, and a variable is invisible to a reader of text —
        the guard reported "a ReachBlock names no fields" and it was right.
        progressSection.test.ts pins this literal against PROGRESS_FIELDS, so
        the two cannot drift. */}
      <ReachBlock
        lang={lang}
        fields={["progressGuardWrites", "progressGuardFailures", "progressGuardPlanTurns"]}
      >
        <div className="settings-grid">
          {PROGRESS_FIELDS.map((field) => (
            <CountField key={field} view={view} field={field} lang={lang} onSave={onSave} />
          ))}
        </div>
        <p className="settings-note">{t(lang, "set.progress.floorNote")}</p>
      </ReachBlock>

      <div className="settings-label">{t(lang, "set.secRunLimits")}</div>
      <p className="settings-note">{t(lang, "set.runLimitsHint")}</p>
      {/* Its own block: bound at the agent build, like the three above but a
        different subject — a ceiling, not a net. Nothing is detected when it
        fires; the run simply ran out of room. */}
      <ReachBlock lang={lang} fields={["maxTurns"]}>
        <div className="settings-grid">
          <label className="settings-field">
            <span>{t(lang, "set.maxTurns")}</span>
            <NumberField view={view} field="maxTurns" lang={lang} onSave={onSave} />
            <p className="settings-note">{t(lang, "set.maxTurnsNote")}</p>
            <OriginRow view={view} field="maxTurns" lang={lang} onReset={() => onSave({ maxTurns: null })} />
          </label>
        </div>
      </ReachBlock>
      {/* Card 372's floor under every child. Its own block although it shares
        maxTurns' reach, for the same reason the shell clock further down has
        one: the two bound different things, how long ONE child may work against
        how many turns the whole run gets, and a single sentence over both would
        read as one limit. The reach was measured at the call site rather than
        inherited from the neighbours: SessionConnection.buildAgentOnce() builds
        the SubagentManager from the config it adopted at that moment
        (SessionConnection.java:1298), and the manager keeps it, so a save
        reaches the next session and not this one. The reasoning stands beside
        the entry in settingsReach.tsx. */}
      <ReachBlock lang={lang} fields={["subagentBudgetSeconds"]}>
        <div className="settings-grid">
          <label className="settings-field" data-progress-field="subagentBudgetSeconds">
            <span>{t(lang, "set.subagentBudgetSeconds")}</span>
            <NumberField view={view} field="subagentBudgetSeconds" lang={lang} onSave={onSave} />
            <p className="settings-note">{t(lang, "set.subagentBudgetSecondsNote")}</p>
            <OriginRow
              view={view}
              field="subagentBudgetSeconds"
              lang={lang}
              onReset={() => onSave({ subagentBudgetSeconds: null })}
            />
          </label>
        </div>
      </ReachBlock>
      {/* Card 364's completion budget. Its own block for the reason the shell
        clock below has one: it shares maxTurns' reach and bounds a different
        thing — how much ONE provider call may write, against how many calls a
        run may make. Same reach because it is read at the agent's build, on
        every face: SessionConnection, the REPL, HeadlessRunner and every child
        pass it in their AgentOptions chain, and AgentBuildReachDriftTest counts
        those call sites from the source rather than from a list. */}
      <ReachBlock lang={lang} fields={["maxTokens"]}>
        <div className="settings-grid">
          <label className="settings-field" data-progress-field="maxTokens">
            <span>{t(lang, "set.maxTokens")}</span>
            <NumberField view={view} field="maxTokens" lang={lang} onSave={onSave} />
            <p className="settings-note">{t(lang, "set.maxTokensNote")}</p>
            <OriginRow
              view={view}
              field="maxTokens"
              lang={lang}
              onReset={() => onSave({ maxTokens: null })}
            />
          </label>
        </div>
      </ReachBlock>
      {/* Card 359's shell clock. Its own block although it shares maxTurns'
        reach, because the two bound different things: one is the ceiling on a
        whole run, the other the ceiling on a single shell call, and one
        sentence over both would read as one limit. The reach was measured on
        the call that carries the number: SessionConnection.buildAgentOnce()
        calls StandardTools.all(active.commandTimeoutSeconds()), and
        StandardTools.runCommand closes over that budget as it builds the tool.
        The tool has no setter and nothing re-reads the config per call, so a
        save reaches the next session and not the one already open. The
        reasoning is written down beside the entry in settingsReach.tsx. */}
      <ReachBlock lang={lang} fields={["commandTimeoutSeconds"]}>
        <div className="settings-grid">
          <label className="settings-field" data-progress-field="commandTimeoutSeconds">
            <span>{t(lang, "set.commandTimeoutSeconds")}</span>
            <NumberField view={view} field="commandTimeoutSeconds" lang={lang} onSave={onSave} />
            <p className="settings-note">{t(lang, "set.commandTimeoutSecondsNote")}</p>
            <OriginRow
              view={view}
              field="commandTimeoutSeconds"
              lang={lang}
              onReset={() => onSave({ commandTimeoutSeconds: null })}
            />
          </label>
        </div>
      </ReachBlock>
      {/* A block of its own because its REACH differs: SessionConnection calls
        setBudget on the live agent once per prompt. reachOf() would throw if
        this shared a block with maxTurns, which is the guard doing its job. */}
      <ReachBlock lang={lang} fields={["continuationBudget"]}>
        <div className="settings-grid">
          <label
            className="settings-field"
            data-progress-state={armedState(count(view, "continuationBudget"))}
            data-progress-field="continuationBudget"
          >
            <span>{t(lang, "set.continuationBudget")}</span>
            <NumberField view={view} field="continuationBudget" lang={lang} onSave={onSave} />
            <p className="settings-note">{t(lang, "set.continuationBudgetNote")}</p>
            <OriginRow
              view={view}
              field="continuationBudget"
              lang={lang}
              onReset={() => onSave({ continuationBudget: null })}
            />
          </label>
        </div>
      </ReachBlock>
      {/* Card 356: the ask caps. Their own block because they are their own
        subject, not because their reach differs — all three are next-session,
        the same as maxTurns two blocks up. */}
      <ReachBlock lang={lang} fields={["questionsPerRun", "maxQuestionOptions", "maxQuestionChars"]}>
        <div className="settings-grid">
          {(["questionsPerRun", "maxQuestionOptions", "maxQuestionChars"] as const).map((field) => (
            <label
              key={field}
              className="settings-field"
              data-progress-state={armedState(count(view, field))}
              data-progress-field={field}
            >
              <span>{t(lang, `set.${field}`)}</span>
              <NumberField view={view} field={field} lang={lang} onSave={onSave} />
              <p className="settings-note">{t(lang, `set.${field}Note`)}</p>
              <OriginRow view={view} field={field} lang={lang} onReset={() => onSave({ [field]: null })} />
            </label>
          ))}
        </div>
      </ReachBlock>
    </>
  );
}
