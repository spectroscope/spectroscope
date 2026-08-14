// The workspace inside the Chat tab — card 219 made it a set of independent
// panels, card 228 (criterion 0) lays them out as a GRID of cards: two or
// three columns following the workspace width, each panel its own card with
// fold, expand and close, none of them inside a shared section. The panel
// MODEL is card 219's unchanged — independent show/hide, fold-without-
// unmount, persistence in spectroscope:layout, the viewport seam.
//
// Three rules carry the whole file:
// 1. Cards are keyed by panel id (`key={id}`), so opening or closing one
//    panel never remounts a sibling — that is what keeps a running PTY alive
//    when the roster is glanced at, and what keeps the browser hole's element
//    identity stable (card 175's lesson, generalized).
// 2. Collapse is display:none, never unmount. Unmounting is the deliberate
//    act of the close button.
// 3. The browser panel must TELL the shell about every change a
//    ResizeObserver cannot see: covered by a modal, folded, closed, moved by
//    a neighbour — or lying UNDER a sibling card gone fullscreen. No CSS can
//    cover or clip the native pane (card 201), so all of that folds into the
//    segment's `active` and the layout-commit nonce.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AgentInfo, PlanStep } from "../state/reducer";
import { openDockPanel, toggleDockCollapse, toggleDockPanel, useLayout } from "../state/layout";
import type { DockPanelId } from "../state/layout";
import { AgentsTab } from "./AgentsTab";
import { PlanTab } from "./PlanTab";
import { WorkPanel } from "./WorkPanel";
import type { SidecarAgent, SidecarIndex } from "../import/sidecarAgents";
import type { WorkItem } from "../state/work";
import type { RunEvent } from "../events";
import { SystemContextTab } from "./SystemContextTab";
import { WorkspaceTab } from "../workspace/WorkspaceTab";
import { TerminalPanel } from "../panels/TerminalPanel";
import { BrowserSegment } from "../browser/BrowserSegment";
import { DOCK_ORDER, dockLabelKey, dockModes } from "../panels/dockModel";
import type { WorkspaceInfo } from "../state/reducer";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function RightPanel({
  agents,
  plan,
  onClose,
  provider,
  model,
  thinking,
  workspace,
  onPickFolder,
  canPickFolder,
  fsRefreshSignal,
  work,
  workHighlight,
  sidecars,
  onOpenAgent,
  onFocusEvent,
  liveView,
  sessionId,
  covered = false,
}: {
  agents: AgentInfo[];
  plan: PlanStep[] | null;
  onClose: () => void;
  provider?: string;
  model?: string;
  thinking: boolean;
  workspace: WorkspaceInfo | null;
  /** Opens the native folder picker (server-side dialog) for THIS session. */
  onPickFolder?: () => void;
  /** False once the agent ran — the workspace is baked in then. */
  canPickFolder?: boolean;
  /** Bumped when the live run touched the disk — the Files panel's tree
   *  refetches (card 89). */
  fsRefreshSignal?: number;
  /** The chat-v2 work fold. Undefined in v1, where the panel is not offered. */
  work?: WorkItem[];
  /** Which work item the transcript's chip is pointing at. */
  workHighlight?: string | null;
  /** The agents beside the imported session (card 177). */
  sidecars?: SidecarIndex;
  /** Open one of them as a session of its own. */
  onOpenAgent?: (agent: SidecarAgent) => void;
  /** The seam Spectrum and FleetCanvas already use (App.tsx:1261-1279). */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
  liveView?: boolean;
  /** Whose browser fills the browser panel — the same shown session the other
   *  door posts (sessionBrowser.drift.test.ts counts both). */
  sessionId: string | null;
  /** A modal is open over this dock. The browser panel folds it into the
   *  segment's `active`, because a dialog cannot paint over the native pane —
   *  it has to be told to hide first. */
  covered?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const lang = useLang();
  const layout = useLayout();
  const modes = dockModes(layout);

  // Which card is expanded over the whole window. Card 219 built this for the
  // browser ("mit einer vollbild funktion"); card 228 gives every card the
  // control. Session state, deliberately unpersisted: a reload lands on the
  // grid, never trapped in an overlay.
  const [fullPanel, setFullPanel] = useState<DockPanelId | null>(null);
  useEffect(() => {
    if (fullPanel !== null && modes[fullPanel] !== "open") setFullPanel(null);
  }, [fullPanel, modes]);
  useEffect(() => {
    if (fullPanel === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFullPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullPanel]);

  // Picking an agent shows its context — reveal the context panel.
  const selectAgent = (id: string): void => {
    setSelectedId(id);
    openDockPanel("context");
  };

  // The layout-commit signal for the browser seam: any change that can move
  // the hole without resizing it re-runs the segment's report effect.
  const reportNonce = [DOCK_ORDER.map((id) => modes[id]).join(","), layout.rightPanelW, fullPanel ?? ""].join(
    "|",
  );

  const offered = DOCK_ORDER.filter((id) => id !== "work" || work !== undefined);
  const openIds = offered.filter((id) => modes[id] !== "closed");

  const counts: Partial<Record<DockPanelId, number>> = {
    work: work?.length,
    agents: agents.length,
    plan: plan?.length,
  };

  const bodyFor = (id: DockPanelId): ReactNode => {
    switch (id) {
      case "work":
        return (
          <WorkPanel
            items={work ?? []}
            liveView={liveView === true}
            highlight={workHighlight ?? null}
            onFocusEvent={onFocusEvent}
            sidecars={sidecars}
            onOpenAgent={onOpenAgent}
          />
        );
      case "agents":
        return <AgentsTab agents={agents} selectedId={selectedId} onSelect={selectAgent} />;
      case "plan":
        return <PlanTab plan={plan} />;
      case "context":
        return <SystemContextTab selected={selected} provider={provider} model={model} thinking={thinking} />;
      case "files":
        return (
          <WorkspaceTab
            workspace={workspace}
            onPickFolder={onPickFolder}
            canPickFolder={canPickFolder}
            refreshSignal={fsRefreshSignal}
          />
        );
      case "terminal":
        return <TerminalPanel sessionId={workspace?.sessionId} />;
      case "browser":
        return (
          <BrowserSegment
            active={
              modes.browser === "open" &&
              !covered &&
              // A sibling card gone fullscreen paints over this hole with
              // z-index alone — which the native pane ignores (card 201). The
              // shell is told to hide the pane instead.
              (fullPanel === null || fullPanel === "browser")
            }
            sessionId={sessionId}
            floorGuard={fullPanel !== "browser"}
            reportNonce={reportNonce}
          />
        );
    }
  };

  /** The panels whose body owns its layout (tree, PTY, hole) rather than
   *  scrolling as prose. */
  const fills = (id: DockPanelId): boolean => id === "files" || id === "terminal" || id === "browser";

  const cards: ReactNode[] = [];
  for (const id of openIds) {
    const collapsed = modes[id] === "collapsed";
    const full = fullPanel === id;
    cards.push(
      <section
        key={id}
        data-panel={id}
        className={`dock-panel${collapsed ? " dock-panel--collapsed" : ""}${full ? " dock-panel--full" : ""}`}
      >
        <header className="dock-panel-head">
          <button
            type="button"
            className="dock-panel-fold"
            aria-expanded={!collapsed}
            aria-label={t(lang, collapsed ? "dock.expand" : "dock.collapse")}
            onClick={() => toggleDockCollapse(id)}
          >
            <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          </button>
          <span className="dock-panel-name">{t(lang, dockLabelKey(id))}</span>
          {(counts[id] ?? 0) > 0 && <span className="tab-count tabular">{counts[id]}</span>}
          <button
            type="button"
            className="dock-full-btn"
            aria-pressed={full}
            aria-label={
              full
                ? t(lang, "dock.fullscreenExit")
                : t(lang, "dock.fullscreen", { p: t(lang, dockLabelKey(id)) })
            }
            title={
              full
                ? t(lang, "dock.fullscreenExit")
                : t(lang, "dock.fullscreen", { p: t(lang, dockLabelKey(id)) })
            }
            onClick={() => setFullPanel((f) => (f === id ? null : id))}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button dock-panel-x"
            aria-label={t(lang, "dock.closePanel")}
            onClick={() => toggleDockPanel(id)}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        <div
          className={`dock-panel-body${fills(id) ? " dock-panel-body--fill" : ""}`}
          style={collapsed ? { display: "none" } : undefined}
        >
          {bodyFor(id)}
        </div>
      </section>,
    );
  }

  return (
    <aside className="right-panel" aria-label="Panel">
      <div className="right-panel-head dock-head">
        <div className="dock-strip" role="toolbar" aria-label={t(lang, "dock.strip")}>
          {offered.map((id) => (
            <button
              key={id}
              type="button"
              className={modes[id] !== "closed" ? "dock-toggle dock-toggle--on" : "dock-toggle"}
              aria-pressed={modes[id] !== "closed"}
              onClick={() => toggleDockPanel(id)}
            >
              {t(lang, dockLabelKey(id))}
              {(counts[id] ?? 0) > 0 && <span className="tab-count tabular">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button rp-close"
          aria-label={t(lang, "rp.close")}
          onClick={onClose}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="dock-body dock-grid">
        {cards.length === 0 ? <p className="dock-empty ctx-empty">{t(lang, "dock.empty")}</p> : cards}
      </div>
    </aside>
  );
}
