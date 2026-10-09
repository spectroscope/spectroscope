// The app header: sidebar toggle, eyebrow and title, the learn and light
// switch and the ⋮ menu (card 442). A run stops from the composer's own stop
// seat. Pure presentation: every piece of state stays in App and arrives as
// props.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { replayEyebrow } from "./replayEyebrow";
import { HeaderMenu } from "../panels/headerPanelControls";
import { ModeSwitch } from "./ModeSwitch";
import { WorkspaceChip } from "./WorkspaceChip";
import { CodeGraphHeaderStatus } from "../codegraph/CodeGraphHeaderStatus";
import type { WorkspaceInfo } from "../state/reducer";

/** Card 442: the only icon buttons the header may draw, in their order. The
 *  rest lives in the ⋮ menu; appHeaderIcons.test.tsx counts against this. */
export const HEADER_ICONS = ["sidebar", "panel", "menu"] as const;

export function AppHeader(props: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** null = the live view; a replay id switches the eyebrow (scenario vs archive). */
  replayId: string | null;
  /** True while the live view continues a stored session (resume). */
  resumed?: boolean;
  title: string;
  /** Generated images so far; the images row of the menu shows the count. */
  imageCount: number;
  /** The dock exists only on the chat tab; the menu lists its panels there. */
  showPanelToggle: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Whether the v2 reading offers the work panel, forwarded to the menu. */
  workPanelOffered?: boolean;
  doctorOpen: boolean;
  onToggleDoctor: () => void;
  /** Opens the ? keymap overlay (edu port). */
  onOpenKeymap: () => void;
  /** Card 462: the live session's working folder, null before any frame. */
  workspace?: WorkspaceInfo | null;
  /** Opens the system folder dialog (the chip's "Change folder"). */
  onPickFolder?: () => void;
  /** Whether the folder may change now (card 428: before the first message, not during a run). */
  canPickFolder?: boolean;
}) {
  const lang = useLang();

  return (
    <header className="header">
      <button
        type="button"
        className="icon-button"
        data-header-icon="sidebar"
        aria-label={props.sidebarOpen ? t(lang, "hdr.sidebarHide") : t(lang, "hdr.sidebarShow")}
        aria-expanded={props.sidebarOpen}
        onClick={props.onToggleSidebar}
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      </button>

      {props.replayId !== null && (
        <span className="eyebrow sand">{t(lang, replayEyebrow(props.replayId))}</span>
      )}
      {props.replayId === null && props.resumed === true && (
        <span className="eyebrow sand">{t(lang, "hdr.resumed")}</span>
      )}
      <h1 className="header-title" title={props.title}>
        {props.title}
      </h1>

      {/* Card 462: the working folder of the live session, with its menu. */}
      {props.workspace !== undefined && props.workspace !== null && props.onPickFolder !== undefined && (
        <WorkspaceChip
          workspace={props.workspace}
          onPickFolder={props.onPickFolder}
          canPick={props.canPickFolder === true}
        />
      )}

      {/* Card 472: the code graph build of this folder, or its ready chip. */}
      <CodeGraphHeaderStatus />

      {/* Card 430: learn or light, in every nav state. */}
      <ModeSwitch />

      {/* The side panel toggle, left of the menu (owner, 2026-09-29: "Der
          sollte draußen sein ... Links daneben"). The dock exists on the chat
          tab only, and so does its toggle. */}
      {props.showPanelToggle && (
        <button
          type="button"
          data-header-icon="panel"
          className={`icon-button${props.panelOpen ? " icon-button--on" : ""}`}
          aria-label={props.panelOpen ? t(lang, "hdr.panelHide") : t(lang, "hdr.panelShow")}
          title={props.panelOpen ? t(lang, "hdr.panelHide") : t(lang, "hdr.panelShow")}
          aria-expanded={props.panelOpen}
          onClick={props.onTogglePanel}
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M10 3v10" />
          </svg>
        </button>
      )}

      {/* Card 442: every panel, the keyboard shortcuts and spectro doctor are
          rows of this menu. */}
      <HeaderMenu
        showDock={props.showPanelToggle}
        workOffered={props.workPanelOffered === true}
        imageCount={props.imageCount}
        doctorOpen={props.doctorOpen}
        onToggleDoctor={props.onToggleDoctor}
        onOpenKeymap={props.onOpenKeymap}
      />
    </header>
  );
}
