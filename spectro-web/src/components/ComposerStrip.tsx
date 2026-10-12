// Card 504: the strip under the composer. The goal line says what the session
// is for and how its last check went; the loop chip (card 268) says which turn
// the live run is in, when the loop wakes next and why, and carries Stop.
//
// No hooks: the chip is a pure reading of the state (state/goalLoop.ts), and
// the test walks the element tree for Stop's own handler. The strip takes no
// room while there is neither a goal nor a loop (card 268 criterion 4). It
// ships in light mode, where the chat and its composer are what loads.

import type { ClientMessage } from "../events";
import { t, type Lang } from "../i18n/i18n";
import {
  loopChipView,
  stopLoopFrame,
  type GoalInfo,
  type GoalVerdictView,
  type LoopInfo,
} from "../state/goalLoop";

const VERDICT_KEYS: Record<string, string> = {
  met: "goal.verdict.met",
  unmet: "goal.verdict.unmet",
  unknown: "goal.verdict.unknown",
  // The command check's own words (GoalVerdict.Outcome).
  failed: "goal.verdict.unmet",
  untested: "goal.verdict.untested",
  cleared: "goal.verdict.cleared",
};

export function ComposerStrip({
  lang,
  goal,
  verdict,
  loop,
  runTurn,
  sendClient,
}: {
  lang: Lang;
  goal: GoalInfo | null;
  verdict: GoalVerdictView | null;
  loop: LoopInfo | null;
  runTurn: number | null;
  sendClient: (msg: ClientMessage) => boolean;
}) {
  const chip = loopChipView(loop, runTurn);
  const hasGoal = goal !== null && goal.stated;
  if (!hasGoal && chip === null) return null;
  const verdictKey = verdict === null ? undefined : VERDICT_KEYS[verdict.outcome];
  return (
    <div className="composer-strip" role="status">
      {hasGoal && (
        <span className="goal-line" title={goal.check === "" ? undefined : goal.check}>
          <span className="goal-line-label">{t(lang, "goal.line")}</span>
          <span className="goal-line-outcome">{goal.outcome}</span>
          {verdictKey !== undefined && (
            <span className={`goal-line-verdict goal-line-verdict--${verdict?.outcome}`}>
              {t(lang, verdictKey)}
            </span>
          )}
        </span>
      )}
      {chip !== null && (
        <span className="loop-chip">
          <span className="loop-chip-label">{t(lang, "loop.chip")}</span>
          {chip.turn !== null && (
            <span className="loop-chip-turn">
              {t(lang, "loop.chip.turn", { n: chip.turn.n, of: chip.turn.of })}
            </span>
          )}
          <span className="loop-chip-next">
            {chip.next === null
              ? t(lang, "loop.chip.waiting")
              : t(lang, chip.held ? "loop.chip.held" : "loop.chip.next", { at: chip.next })}
          </span>
          {chip.reason !== null && <span className="loop-chip-reason">{chip.reason}</span>}
          <button
            type="button"
            className="loop-chip-stop"
            title={t(lang, "loop.chip.stopTitle")}
            onClick={() => sendClient(stopLoopFrame())}
          >
            {t(lang, "loop.chip.stop")}
          </button>
        </span>
      )}
    </div>
  );
}
