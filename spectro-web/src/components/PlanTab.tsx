// The "Plan" tab of the right-docked panel: the main agent's current TODO list
// (UiState.plan), rendered read-only. Latest-wins snapshot fed by the additive
// `plan` event / the permission-free update_plan tool. Reuses the agent-card CSS
// vocabulary (dot + badge) so it reskins across all brand designs. The wire
// status values stay English; the chrome labels localize.

import type { PlanStep } from "../state/reducer";
import { dict, t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** Chrome label for a wire status; unknown statuses pass through unchanged
 *  (forward compatibility — the wire stays English either way). */
export function statusLabel(status: string, lang: Lang = "en"): string {
  return dict[`plan.${status}`] !== undefined ? t(lang, `plan.${status}`) : status;
}

export function PlanTab({ plan }: { plan: PlanStep[] | null }) {
  const lang = useLang();
  if (plan === null || plan.length === 0) {
    return <p className="agents-empty">{t(lang, "plan.empty")}</p>;
  }

  return (
    <ul className="agents-list" aria-label="Plan">
      {plan.map((step, i) => (
        <li key={i}>
          <div className={`agent-card agent-card--${step.status}`}>
            <span className="agent-card-head">
              <span className={`agent-dot agent-dot--${step.status}`} aria-hidden="true" />
              <span className={`agent-badge agent-badge--${step.status}`}>{statusLabel(step.status, lang)}</span>
            </span>
            <span className="agent-card-task">{step.text}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
