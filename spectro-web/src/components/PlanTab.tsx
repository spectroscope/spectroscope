// The "Plan" tab of the right-docked panel: the plan of the agent the picker
// shows, rendered read-only. Latest-wins snapshot per writer, fed by the
// additive `plan` event / the permission-free update_plan tool. Reuses the
// agent-card CSS vocabulary (dot + badge) so it reskins across all brand
// designs. The wire status values stay English; the chrome labels localize.
//
// Card 586: while the session has a run (UiState.runs), the tab shows the run
// (RunPanel) and, under it, a plan the model wrote as "Plan of the model". The
// plan the playbook runner writes is left out there: the run shows its steps.
//
// Card 593: the root's plan is its own writer's slot (UiState.plans), so a
// playbook run's rows and the main agent's plan no longer overwrite each
// other. A picker heads the model's plan (the run panel belongs to a run, the
// picker to an agent); a helper keeps no plan and the panel says so.

import type { AgentInfo, PlanStep } from "../state/reducer";
import type { RunEntry, RunTrack } from "../state/runView";
import type { ShownAgent } from "../state/shownAgent";
import { PLAYBOOK_AGENT } from "../state/planVerdict";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { statusLabel } from "./todoList";
import { RunPanel } from "./RunPanel";
import { AgentPicker } from "./AgentPicker";

// The status vocabulary moved to todoList.ts when the trace grew a second list
// with the same three wire statuses (card 141). One definition, two readers;
// re-exported here because this is where it was published from.
export { statusLabel };

const noop = (): void => {};

/** The rows the panel shows for the root: its own plan, else, with no run on screen, a playbook's rows as before card 593. */
export function rootPlanRows(
  plans: Record<string, PlanStep[]>,
  rootId: string,
  hasRuns: boolean,
): PlanStep[] | null {
  return plans[rootId] ?? (hasRuns ? null : (plans[PLAYBOOK_AGENT] ?? null));
}

export function PlanTab({
  plans,
  shown,
  agents,
  onPickAgent,
  runs = [],
  live = false,
  sessionId = null,
  wide = false,
  onToggleWide = noop,
  onJump = noop,
  onOpenPath = noop,
}: {
  /** Card 593: the latest plan of each writer (UiState.plans). */
  plans: Record<string, PlanStep[]>;
  /** Card 593: the agent the agent views show, and the roster and pick of its picker. */
  shown: ShownAgent;
  agents: readonly AgentInfo[];
  onPickAgent: (id: string | null) => void;
  /** Card 586: the runs of the session, oldest first. */
  runs?: RunTrack[];
  live?: boolean;
  /** The shown session: a run picked in one session does not carry over to the next. */
  sessionId?: string | null;
  wide?: boolean;
  onToggleWide?: () => void;
  onJump?: (entry: RunEntry) => void;
  onOpenPath?: (run: RunTrack, path: string) => void;
}) {
  const lang = useLang();
  const hasRuns = runs.length > 0;
  const picker = <AgentPicker agents={agents} shown={shown} onPick={onPickAgent} />;
  const rows = shown.isRoot ? rootPlanRows(plans, shown.rootId, hasRuns) : null;
  const empty = rows === null || rows.length === 0;
  if (hasRuns) {
    return (
      <div className="run-plan">
        <RunPanel
          key={sessionId ?? ""}
          runs={runs}
          live={live}
          wide={wide}
          onToggleWide={onToggleWide}
          onJump={onJump}
          onOpenPath={onOpenPath}
        />
        {picker}
        {!shown.isRoot ? (
          <p className="agents-empty">{t(lang, "plan.helperNone", { id: shown.id })}</p>
        ) : (
          !empty && (
            <>
              <h3 className="run-model-plan">{t(lang, "run.panel.modelPlan")}</h3>
              <PlanList plan={rows} lang={lang} />
            </>
          )
        )}
      </div>
    );
  }
  return (
    <>
      {picker}
      {!shown.isRoot ? (
        <p className="agents-empty">{t(lang, "plan.helperNone", { id: shown.id })}</p>
      ) : empty ? (
        <p className="agents-empty">{t(lang, "plan.empty")}</p>
      ) : (
        <PlanList plan={rows} lang={lang} />
      )}
    </>
  );
}

function PlanList({ plan, lang }: { plan: PlanStep[]; lang: Lang }) {
  return (
    <ul className="agents-list" aria-label="Plan">
      {plan.map((step, i) => (
        <li key={i}>
          <div className={`agent-card agent-card--${step.status}`}>
            <span className="agent-card-head">
              <span className={`agent-dot agent-dot--${step.status}`} aria-hidden="true" />
              <span className={`agent-badge agent-badge--${step.status}`}>
                {statusLabel(step.status, lang)}
              </span>
            </span>
            <span className="agent-card-task">{step.text}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
