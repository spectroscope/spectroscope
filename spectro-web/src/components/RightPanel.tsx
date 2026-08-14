// The right-docked area inside the Chat tab — since card 219 a DOCK of
// independent panels rather than one tab box. The owner's own first-cut
// scoping: each surface stands on its own (terminal, files and the agent
// context used to share one box), each shows and hides independently and is
// collapsible, and the browser is one of them, with a fullscreen mode.
//
// Three rules carry the whole file:
// 1. Sections are keyed by panel id (`key={id}`), so opening or closing one
//    panel never remounts a sibling — that is what keeps a running PTY alive
//    when the roster is glanced at, and what keeps the browser hole's element
//    identity stable (card 175's lesson, generalized).
// 2. Collapse is display:none, never unmount. Unmounting is the deliberate
//    act of the close button.
// 3. The browser panel must TELL the shell about every change a
//    ResizeObserver cannot see: covered by a modal, folded, closed, or moved
//    by a neighbour — no CSS can cover or clip the native pane (card 201).

import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { AgentInfo, PlanStep } from "../state/reducer";
import {
  openDockPanel,
  setDockWeights,
  toggleDockCollapse,
  toggleDockPanel,
  useLayout,
} from "../state/layout";
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
import {
  DOCK_ORDER,
  PANEL_MIN_PX,
  dockLabelKey,
  dockModes,
  dividerKeyStep,
  pairWeightsForHeights,
  parseDockWeights,
  serializeDockWeights,
  weightOf,
} from "../panels/dockModel";
import type { DockWeights } from "../panels/dockModel";
import type { WorkspaceInfo } from "../state/reducer";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

/** Writes a pair of weights back into the store, rounded so the persisted
 *  string stays readable. */
function commitPair(current: string, above: DockPanelId, below: DockPanelId, wa: number, wb: number): void {
  const next: DockWeights = { ...parseDockWeights(current) };
  next[above] = Math.round(wa * 1000) / 1000;
  next[below] = Math.round(wb * 1000) / 1000;
  setDockWeights(serializeDockWeights(next));
}

/** The divider between two EXPANDED neighbours — the ws-divider idiom
 *  (pointer capture, arrow keys against a clamped share), promoted to the
 *  dock. It moves weight between its own pair only, so the rest of the stack
 *  stands still. */
function DockDivider({
  above,
  below,
  weightsRaw,
  sections,
  lang,
}: {
  above: DockPanelId;
  below: DockPanelId;
  weightsRaw: string;
  sections: { current: Map<DockPanelId, HTMLElement> };
  lang: Lang;
}) {
  const drag = useRef<{ y: number; wa: number; wb: number; ha: number; hb: number } | null>(null);
  const weights = parseDockWeights(weightsRaw);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const a = sections.current.get(above);
    const b = sections.current.get(below);
    if (a === undefined || b === undefined) return;
    drag.current = {
      y: e.clientY,
      wa: weightOf(weights, above),
      wb: weightOf(weights, below),
      ha: a.getBoundingClientRect().height,
      hb: b.getBoundingClientRect().height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null) return;
    const [wa, wb] = pairWeightsForHeights(d.wa, d.wb, d.ha, d.hb, e.clientY - d.y, PANEL_MIN_PX);
    commitPair(weightsRaw, above, below, wa, wb);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const [wa, wb] = dividerKeyStep(
      weightOf(weights, above),
      weightOf(weights, below),
      e.key === "ArrowDown" ? 1 : -1,
    );
    commitPair(weightsRaw, above, below, wa, wb);
  };
  return (
    <div
      className="dock-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t(lang, "dock.divider")}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={onKey}
    />
  );
}

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
   *  two doors post (sessionBrowser.drift.test.ts counts all three). */
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
  const weights = parseDockWeights(layout.dockWeights);
  const sections = useRef(new Map<DockPanelId, HTMLElement>());

  // The browser panel's fullscreen (owner: "mit einer vollbild funktion
  // (screenshot)") — session state, deliberately unpersisted: a reload lands
  // on the dock, never trapped in an overlay.
  const [browserFull, setBrowserFull] = useState(false);
  useEffect(() => {
    if (browserFull && modes.browser !== "open") setBrowserFull(false);
  }, [browserFull, modes.browser]);
  useEffect(() => {
    if (!browserFull) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setBrowserFull(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [browserFull]);

  // Picking an agent shows its context — reveal the context panel.
  const selectAgent = (id: string): void => {
    setSelectedId(id);
    openDockPanel("context");
  };

  // The layout-commit signal for the browser seam: any change that can move
  // the hole without resizing it re-runs the segment's report effect.
  const reportNonce = [
    DOCK_ORDER.map((id) => modes[id]).join(","),
    layout.dockWeights,
    layout.rightPanelW,
    browserFull,
  ].join("|");

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
            active={modes.browser === "open" && !covered}
            sessionId={sessionId}
            floorGuard={!browserFull}
            reportNonce={reportNonce}
          />
        );
    }
  };

  /** The panels whose body owns its layout (tree, PTY, hole) rather than
   *  scrolling as prose. */
  const fills = (id: DockPanelId): boolean => id === "files" || id === "terminal" || id === "browser";

  const rows: ReactNode[] = [];
  let lastExpanded: DockPanelId | null = null;
  for (const id of openIds) {
    const collapsed = modes[id] === "collapsed";
    if (!collapsed && lastExpanded !== null) {
      rows.push(
        <DockDivider
          key={`divider-${lastExpanded}-${id}`}
          above={lastExpanded}
          below={id}
          weightsRaw={layout.dockWeights}
          sections={sections}
          lang={lang}
        />,
      );
    }
    const full = id === "browser" && browserFull;
    rows.push(
      <section
        key={id}
        data-panel={id}
        className={`dock-panel${collapsed ? " dock-panel--collapsed" : ""}${full ? " dock-panel--full" : ""}`}
        style={collapsed ? undefined : { flexGrow: weightOf(weights, id) }}
        ref={(el) => {
          if (el === null) sections.current.delete(id);
          else sections.current.set(id, el);
        }}
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
          {id === "browser" && (
            <button
              type="button"
              className="dock-full-btn"
              aria-pressed={browserFull}
              aria-label={t(lang, browserFull ? "dock.fullscreenExit" : "dock.fullscreen")}
              title={t(lang, browserFull ? "dock.fullscreenExit" : "dock.fullscreen")}
              onClick={() => setBrowserFull((f) => !f)}
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
          )}
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
    if (!collapsed) lastExpanded = id;
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
      <div className="dock-body">
        {rows.length === 0 ? <p className="dock-empty ctx-empty">{t(lang, "dock.empty")}</p> : rows}
      </div>
    </aside>
  );
}
