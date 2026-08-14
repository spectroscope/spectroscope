// The workspace inside the Chat tab — card 219 made it a set of independent
// panels, card 228 laid them out as a width-following grid, and card 236
// replaces that with COLUMNS the layout store owns: one or two panels per
// column, a width weight per column, a height split per column, dividers on
// both axes. The window size scales the pixels and never re-seats a panel —
// the 228 grid's auto-fit re-flow (the owner's "das Layout springt", measured
// 2026-08-14) is the defect this file no longer contains. The panel MODEL is
// card 219's unchanged — independent show/hide, fold-without-unmount,
// persistence in spectroscope:layout, the viewport seam.
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

import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { AgentInfo, PlanStep } from "../state/reducer";
import {
  openDockPanel,
  setDockColumnShare,
  setDockColumnSplit,
  toggleDockCollapse,
  toggleDockPanel,
  useLayout,
} from "../state/layout";
import type { DockPanelId } from "../state/layout";
import { parseColumns } from "../panels/columnModel";
import { PANEL_MIN_PX } from "../panels/dockModel";
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

/**
 * One divider of the arrangement (card 236) — the promoted ws-divider idiom
 * (WorkspaceTab.tsx): pointer capture so the drag survives outrunning the 8px
 * strip, arrow keys as the keyboard path, and the caller clamps against the
 * PANEL_MIN_PX floor before a ratio is stored. Vertical dividers sit between
 * columns and trade width; horizontal ones sit inside a column and trade
 * height.
 */
function ArrangementDivider({
  orientation,
  label,
  onApply,
  onStep,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  /** A pointer position, applied: the caller measures the two neighbours off
   *  the divider element itself and stores the clamped ratio. */
  onApply: (el: HTMLElement, clientX: number, clientY: number) => void;
  /** One keyboard step, ±1 — the caller turns it into a ratio nudge. */
  onStep: (dir: -1 | 1) => void;
}): React.JSX.Element {
  const dragging = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragging.current) onApply(e.currentTarget, e.clientX, e.clientY);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const dir =
      orientation === "vertical"
        ? e.key === "ArrowLeft"
          ? -1
          : e.key === "ArrowRight"
            ? 1
            : 0
        : e.key === "ArrowUp"
          ? -1
          : e.key === "ArrowDown"
            ? 1
            : 0;
    if (dir === 0) return;
    e.preventDefault();
    onStep(dir);
  };
  return (
    <div
      className={`dock-divider ${orientation === "vertical" ? "dock-divider--col" : "dock-divider--row"}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
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
  // the hole without resizing it re-runs the segment's report effect. Card
  // 236 folds the ARRANGEMENT string in, so a divider drag on either axis and
  // every open/close/migration re-posts the rectangle (cards 219/226/228).
  const reportNonce = [
    DOCK_ORDER.map((id) => modes[id]).join(","),
    layout.dockColumns,
    layout.rightPanelW,
    fullPanel ?? "",
  ].join("|");

  const offered = DOCK_ORDER.filter((id) => id !== "work" || work !== undefined);

  // The arrangement (card 236), projected onto what THIS reading offers: the
  // v1 chat has no work panel, so a stored seat for it renders nothing here —
  // the seat itself stays stored for the v2 reading. Mode is re-checked
  // defensively; the store keeps the two fields in agreement.
  const columns = parseColumns(layout.dockColumns, DOCK_ORDER)
    .map((c, storeIndex) => ({
      ...c,
      // The index in the STORE's arrangement — the divider verbs address
      // store columns, and the projection may have dropped one.
      storeIndex,
      panels: c.panels.filter(
        (id): id is DockPanelId =>
          offered.includes(id as DockPanelId) && modes[id as DockPanelId] !== "closed",
      ),
    }))
    .filter((c) => c.panels.length > 0);

  // Stable identity for the column WRAPPERS, so a column vanishing to the
  // left never remounts the columns to its right (a remounted terminal is a
  // killed PTY — card 219's rule). Panels never migrate between columns, so
  // "shares a panel" identifies a column across renders; the map is pruned to
  // seated panels so a reopened panel starts fresh instead of resurrecting a
  // dead column's key. Ref mutation during render is idempotent on purpose
  // (same input, same keys) — a StrictMode double render assigns identically.
  const colKeyByPanel = useRef(new Map<string, string>());
  const nextColKey = useRef(1);
  const seated = new Set(columns.flatMap((c) => c.panels as string[]));
  for (const id of [...colKeyByPanel.current.keys()]) {
    if (!seated.has(id)) colKeyByPanel.current.delete(id);
  }
  const columnKeys = columns.map((c) => {
    let key: string | undefined;
    for (const id of c.panels) {
      key = colKeyByPanel.current.get(id);
      if (key !== undefined) break;
    }
    if (key === undefined) key = `c${nextColKey.current++}`;
    for (const id of c.panels) colKeyByPanel.current.set(id, key);
    return key;
  });

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

  // Ratios are stored to 4 decimals (columnModel's round4); the complements
  // rendered here go through the same rounding so the two grows always sum
  // to a clean 1 in the markup.
  const grow = (n: number): number => Math.round(n * 10000) / 10000;
  /** One keyboard step of the divider idiom — 4% like the Files divider. */
  const RATIO_STEP = 0.04;

  // The drag appliers measure the two NEIGHBOURS off the divider element
  // itself (previous/next sibling), clamp against the PANEL_MIN_PX floor in
  // the pixel domain, and store only the resulting ratio — the model never
  // reads a pixel.
  const applyColumnShare = (el: HTMLElement, clientX: number, leftStoreIndex: number): void => {
    const left = el.previousElementSibling;
    const right = el.nextElementSibling;
    if (left === null || right === null) return;
    const lr = left.getBoundingClientRect();
    const rr = right.getBoundingClientRect();
    const total = lr.width + rr.width;
    if (total < 2 * PANEL_MIN_PX) return;
    const px = Math.min(Math.max(clientX - lr.left, PANEL_MIN_PX), total - PANEL_MIN_PX);
    setDockColumnShare(leftStoreIndex, px / total);
  };
  const applyColumnSplit = (el: HTMLElement, clientY: number, storeIndex: number): void => {
    const top = el.previousElementSibling;
    const bottom = el.nextElementSibling;
    if (top === null || bottom === null) return;
    const tr = top.getBoundingClientRect();
    const br = bottom.getBoundingClientRect();
    const total = tr.height + br.height;
    if (total < 2 * PANEL_MIN_PX) return;
    const px = Math.min(Math.max(clientY - tr.top, PANEL_MIN_PX), total - PANEL_MIN_PX);
    setDockColumnSplit(storeIndex, px / total);
  };

  const renderCard = (id: DockPanelId, style?: CSSProperties): ReactNode => {
    const collapsed = modes[id] === "collapsed";
    const full = fullPanel === id;
    return (
      <section
        key={id}
        data-panel={id}
        style={style}
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
      </section>
    );
  };

  // The columns, projected: the store's arrangement decides WHERE a card
  // sits, flex weights decide how wide and how tall — nothing here reads the
  // window. Dividers sit between store-ADJACENT columns and between the two
  // open panels of a column; a column pair with a hidden seat between them
  // (a stored work column in the v1 reading) gets no divider — the degenerate
  // state heals when the v2 reading returns, and a divider that would re-cut
  // a pair around an invisible column would move a width nobody can see.
  const arranged: ReactNode[] = [];
  columns.forEach((c, ci) => {
    if (ci > 0 && c.storeIndex === columns[ci - 1].storeIndex + 1) {
      const leftStore = columns[ci - 1].storeIndex;
      const leftWeight = columns[ci - 1].weight;
      arranged.push(
        <ArrangementDivider
          key={`d-${columnKeys[ci - 1]}-${columnKeys[ci]}`}
          orientation="vertical"
          label={t(lang, "dock.dividerW")}
          onApply={(el, x) => applyColumnShare(el, x, leftStore)}
          onStep={(dir) =>
            setDockColumnShare(leftStore, leftWeight / (leftWeight + c.weight) + dir * RATIO_STEP)
          }
        />,
      );
    }
    const topId = c.panels[0];
    const bottomId = c.panels[1];
    const bothOpen = bottomId !== undefined && modes[topId] === "open" && modes[bottomId] === "open";
    arranged.push(
      <div key={columnKeys[ci]} className="dock-col" data-col={ci} style={{ flexGrow: c.weight }}>
        {renderCard(topId, bothOpen ? { flexGrow: c.split } : undefined)}
        {bothOpen && (
          <ArrangementDivider
            orientation="horizontal"
            label={t(lang, "dock.divider")}
            onApply={(el, _x, y) => applyColumnSplit(el, y, c.storeIndex)}
            onStep={(dir) => setDockColumnSplit(c.storeIndex, c.split + dir * RATIO_STEP)}
          />
        )}
        {bottomId !== undefined &&
          renderCard(bottomId, bothOpen ? { flexGrow: grow(1 - c.split) } : undefined)}
      </div>,
    );
  });

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
      <div className="dock-body dock-columns">
        {columns.length === 0 ? <p className="dock-empty ctx-empty">{t(lang, "dock.empty")}</p> : arranged}
      </div>
    </aside>
  );
}
