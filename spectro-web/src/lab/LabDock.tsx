// Card 301: the lab's dock, now holding three panels behind a tab strip.
//
// TABS, NOT SECTIONS — the choice this card was asked to make, and the reason.
// Card 300 left the dock UNMOUNTED while collapsed so that a panel nobody
// opened would not fold the whole applied prefix on every step. Three sections
// stacked in one scroller would hand that cost straight back and triple it: the
// context peak, the message lanes and the file footprint would all re-fold on
// every step while a reader looks at exactly one of them. Tabs keep the
// property card 300 paid for — one fold at a time, and none at all while the
// dock is shut, because LabView still mounts nothing until it is opened.
//
// The title in the rail follows the tab, so a collapsed dock still says which
// panel it will open.

import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { ContextPeak } from "./ContextPeak";
import { FileFootprint } from "./FileFootprint";
import { HandoverLane } from "./HandoverLane";
import { DOCK_TABS, type DockTab } from "./labDockTabs";

/** The panel title for one tab — also what the collapsed rail is labelled. */
export function dockTitleKey(tab: DockTab): string {
  return tab === "ctx" ? "lab.ctx.title" : tab === "msg" ? "lab.msg.title" : "lab.files.title";
}

function ariaKey(tab: DockTab): string {
  return tab === "ctx" ? "lab.ctx.aria" : tab === "msg" ? "lab.msg.aria" : "lab.files.aria";
}

export function LabDock(props: {
  tab: DockTab;
  onPickTab: (next: DockTab) => void;
  applied: RunEvent[];
  workspaceRoot?: string | null;
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const { tab, onPickTab, applied, workspaceRoot, onFocusEvent } = props;

  return (
    <aside className="lab-ctx" aria-label={t(lang, ariaKey(tab))}>
      <div className="lab-ctx-head">
        <div className="lab-dock-tabs" role="tablist" aria-label={t(lang, "lab.dock.aria")}>
          {DOCK_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`lab-dock-tab${id === tab ? " is-on" : ""}`}
              aria-selected={id === tab}
              onClick={() => onPickTab(id)}
            >
              {t(lang, `lab.dock.tab.${id}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="lab-ctx-scroll">
        {/* Exactly one of these is ever built. */}
        {tab === "ctx" && <ContextPeak applied={applied} embedded />}
        {tab === "msg" && <HandoverLane applied={applied} onFocusEvent={onFocusEvent} />}
        {tab === "files" && (
          <FileFootprint applied={applied} workspaceRoot={workspaceRoot} onFocusEvent={onFocusEvent} />
        )}
      </div>
    </aside>
  );
}
