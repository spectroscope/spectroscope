// The right-docked panel inside the Chat tab — the Claude-Code right-sidebar
// pattern. Its own tab bar hosts "Agenten" (the session-wide roster) and
// "System-Kontext" (what goes to the LLM per agent). Designed to grow (Vorschau,
// Files, …). Collapsible + resizable via layout.ts + the shared Resizer (wired
// in App); selecting an agent in the Agenten tab drives the System-Kontext tab.

import { useState } from "react";
import type { AgentInfo, PlanStep } from "../state/reducer";
import type { RightTab } from "../state/layout";
import { AgentsTab } from "./AgentsTab";
import { PlanTab } from "./PlanTab";
import { SystemContextTab } from "./SystemContextTab";
import { WorkspaceTab } from "../workspace/WorkspaceTab";
import type { WorkspaceInfo } from "../state/reducer";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function RightPanel({
  agents,
  plan,
  activeTab,
  onTab,
  onClose,
  provider,
  model,
  thinking,
  workspace,
  onPickFolder,
  canPickFolder,
}: {
  agents: AgentInfo[];
  plan: PlanStep[] | null;
  activeTab: RightTab;
  onTab: (tab: RightTab) => void;
  onClose: () => void;
  provider?: string;
  model?: string;
  thinking: boolean;
  workspace: WorkspaceInfo | null;
  /** Opens the native folder picker (server-side dialog) for THIS session. */
  onPickFolder?: () => void;
  /** False once the agent ran — the workspace is baked in then. */
  canPickFolder?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const lang = useLang();

  // Picking an agent shows its context — jump to the System-Kontext tab.
  const selectAgent = (id: string): void => {
    setSelectedId(id);
    onTab("context");
  };

  const tabBtn = (tab: RightTab, label: string, count?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      className={activeTab === tab ? "rp-tab rp-tab--active" : "rp-tab"}
      onClick={() => onTab(tab)}
    >
      {label}
      {count !== undefined && count > 0 && <span className="tab-count tabular">{count}</span>}
    </button>
  );

  return (
    <aside className="right-panel" aria-label="Panel">
      <div className="right-panel-head">
        <div className="rp-tabs" role="tablist" aria-label="Panel-Tabs">
          {tabBtn("agents", t(lang, "rp.agents"), agents.length)}
          {tabBtn("plan", t(lang, "rp.plan"), plan?.length)}
          {tabBtn("context", t(lang, "rp.context"))}
          {tabBtn("files", t(lang, "rp.files"))}
        </div>
        <button type="button" className="icon-button rp-close" aria-label={t(lang, "rp.close")} onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="right-panel-body">
        {activeTab === "agents" ? (
          <AgentsTab agents={agents} selectedId={selectedId} onSelect={selectAgent} />
        ) : activeTab === "plan" ? (
          <PlanTab plan={plan} />
        ) : activeTab === "files" ? (
          <WorkspaceTab
            workspace={workspace}
            onPickFolder={onPickFolder}
            canPickFolder={canPickFolder}
          />
        ) : (
          <SystemContextTab selected={selected} provider={provider} model={model} thinking={thinking} />
        )}
      </div>
    </aside>
  );
}
