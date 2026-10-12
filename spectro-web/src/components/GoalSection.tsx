// Card 504, criterion 1: the Goal entry of the composer's settings menu.
// It sends card 267's set_goal with an outcome and a check command, and reads
// goal_info back; Clear sends an empty goal. The goal is stated by the
// operator here and by no tool of the model. Both frames leave through
// sendSession, the session's own socket, so a stored session on screen is
// continued first (hub and spoke fix round).

import { useEffect, useState } from "react";
import type { ClientMessage } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { clearGoalFrame, goalFrame, type GoalInfo } from "../state/goalLoop";

export function GoalSection({
  lang,
  goal,
  sendSession,
}: {
  lang: Lang;
  goal: GoalInfo | null;
  sendSession: (msg: ClientMessage) => boolean;
}) {
  const [outcome, setOutcome] = useState(goal?.stated ? goal.outcome : "");
  const [check, setCheck] = useState(goal?.stated ? goal.check : "");
  // The server's answer is the truth: a goal stated or cleared elsewhere (the
  // REPL, the file, a cleared goal after an error) reseeds the fields.
  useEffect(() => {
    setOutcome(goal?.stated ? goal.outcome : "");
    setCheck(goal?.stated ? goal.check : "");
  }, [goal?.stated, goal?.outcome, goal?.check]);
  const stated = goal !== null && goal.stated;
  return (
    <div className="wsg-section goal-section">
      <div className="wsg-section-head">
        <span>{t(lang, "goal.title")}</span>
      </div>
      <p className="wsg-hint">{t(lang, stated ? "goal.stated" : "goal.none")}</p>
      <label className="goal-field">
        <span>{t(lang, "goal.outcome")}</span>
        <input
          type="text"
          className="wsg-rule-input"
          value={outcome}
          placeholder={t(lang, "goal.outcome.placeholder")}
          onChange={(e) => setOutcome(e.target.value)}
        />
      </label>
      <label className="goal-field">
        <span>{t(lang, "goal.check")}</span>
        <input
          type="text"
          className="wsg-rule-input"
          value={check}
          placeholder={t(lang, "goal.check.placeholder")}
          onChange={(e) => setCheck(e.target.value)}
        />
      </label>
      <div className="goal-actions">
        <button
          type="button"
          className="ghost wsg-local-add-btn"
          disabled={outcome.trim() === ""}
          onClick={() => sendSession(goalFrame(outcome, check))}
        >
          {t(lang, "goal.set")}
        </button>
        <button
          type="button"
          className="ghost wsg-local-add-btn"
          disabled={!stated}
          onClick={() => sendSession(clearGoalFrame())}
        >
          {t(lang, "goal.clear")}
        </button>
      </div>
      {stated && goal.file !== "" && <p className="settings-note mono">{goal.file}</p>}
    </div>
  );
}
