// Card 442 (owner, 2026-09-25 and 2026-09-29): the header's ⋮ menu holds
// what the header used to show as icons. One row per panel, and behind a
// separator the keyboard shortcuts and spectro doctor; every row with its icon
// and its name. The side panel toggle stays outside, left of the menu.
//
// Card 228's rule still holds: the panel rows are the SECOND door to the
// dock's state, never a copy. Checks read the same `spectroscope:layout`
// store the dock strip reads, and presses go through the store's own verbs.
// Opening a panel from here also reveals the workspace (openRightPanel).

import { Fragment, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { getLayout, openDockPanel, openRightPanel, toggleDockPanel, useLayout } from "../state/layout";
import type { DockPanelId } from "../state/layout";
import { DOCK_ORDER, dockLabelKey, dockModes } from "./dockModel";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The tools behind the separator, in their order. */
export const HEADER_MENU_TOOLS = ["keymap", "doctor"] as const;
type ToolId = (typeof HEADER_MENU_TOOLS)[number];

/** One row of the menu. */
export type MenuRow = { id: DockPanelId; kind: "panel" } | { id: ToolId; kind: "tool" };

/**
 * The rows of the menu, in order: every offered panel when the dock exists
 * (the chat tab), then the tools.
 *
 * @param opts.showDock    whether the dock exists in the current view
 * @param opts.workOffered whether the v2 reading offers the work panel
 * @returns the rows the markup draws
 */
export function menuRows(opts: { showDock: boolean; workOffered: boolean }): MenuRow[] {
  const rows: MenuRow[] = [];
  if (opts.showDock) {
    for (const id of DOCK_ORDER) {
      if (id !== "work" || opts.workOffered) rows.push({ id, kind: "panel" });
    }
  }
  for (const id of HEADER_MENU_TOOLS) rows.push({ id, kind: "tool" });
  return rows;
}

/**
 * Where the focus goes for a key in a menu of `count` rows. Arrows wrap,
 * Home and End jump; any other key keeps the row.
 */
export function nextMenuIndex(current: number, key: string, count: number): number {
  if (count === 0) return current;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return current;
}

/** The glyphs, in a 16px box. Files, terminal and browser are the ones the
 *  header wore; the browser is the rail's own geometry (NavRow.tsx). */
const GLYPHS: Record<MenuRow["id"], ReactNode> = {
  work: <path d="M3 4.5l1.2 1.2L6.5 3.4M3 9.5l1.2 1.2 2.3-2.3M8.5 5h4.5M8.5 10h4.5" />,
  agents: (
    <>
      <circle cx="5" cy="5.5" r="1.8" />
      <circle cx="11" cy="5.5" r="1.8" />
      <path d="M1.8 12.5c.4-2 1.6-3 3.2-3s2.8 1 3.2 3M7.8 12.5c.4-2 1.6-3 3.2-3s2.8 1 3.2 3" />
    </>
  ),
  plan: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5" />,
  context: (
    <>
      <path d="M8 2.5l5.5 2.8L8 8.1 2.5 5.3z" />
      <path d="M2.5 8.2L8 11l5.5-2.8M2.5 11L8 13.8l5.5-2.8" />
    </>
  ),
  files: (
    <path d="M2 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z" />
  ),
  terminal: (
    <>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.4" />
      <path d="M4.4 6l2.2 2-2.2 2M8.4 10.4h3.2" />
    </>
  ),
  browser: (
    <>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.4" />
      <path d="M1.8 6.2h12.4" />
      <circle cx="4" cy="4.6" r="0.5" fill="currentColor" stroke="none" />
    </>
  ),
  images: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <path d="M2 11l3.5-3 2.5 2 3-2.5 3 2.5" />
    </>
  ),
  keymap: (
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1.6" />
      <path d="M4 6.5h0M6.5 6.5h0M9 6.5h0M11.5 6.5h0M5 9.5h6" />
    </>
  ),
  doctor: (
    <>
      <circle cx="5" cy="8" r="2.2" />
      <path d="M10 4.5v7M12.5 6v4M15 7v2" />
    </>
  ),
};

/** The name of a row, from the panel vocabulary or the menu's own keys. */
function rowLabelKey(row: MenuRow): string {
  if (row.kind === "panel") return dockLabelKey(row.id);
  return `hdr.menu.${row.id}`;
}

/** One press, either door: opening reveals the workspace too, closing
 *  leaves the workspace as it is (the strip behaves the same way). The open
 *  REMEMBERS (card 242): a menu row is the user's explicit ask, so the dock
 *  returns on the next entered session, unlike the agent's cue. In tabs mode
 *  (card 444) the store's toggle shows or hides the dock for the shown panel
 *  instead of closing it. */
export function pressDockPanel(id: DockPanelId): void {
  if (dockModes(getLayout())[id] === "closed") {
    openDockPanel(id);
    openRightPanel(true);
  } else {
    toggleDockPanel(id);
  }
}

export function HeaderMenu(props: {
  /** Whether the dock exists in the current view (the chat tab). */
  showDock: boolean;
  /** Whether the v2 reading offers the work panel, the same gate as the dock. */
  workOffered: boolean;
  /** Generated images so far, shown on the images row. */
  imageCount: number;
  doctorOpen: boolean;
  onToggleDoctor: () => void;
  onOpenKeymap: () => void;
  /** Static markup cannot click; tests render the menu open through this. */
  menuOpenForTest?: boolean;
}) {
  const lang = useLang();
  const layout = useLayout();
  const modes = dockModes(layout);
  const [open, setOpen] = useState(props.menuOpenForTest === true);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    // The first row takes the focus, so the arrows work at once.
    pop.current?.querySelector<HTMLButtonElement>("[data-menu-row]")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rows = menuRows({ showDock: props.showDock, workOffered: props.workOffered });

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...(pop.current?.querySelectorAll<HTMLButtonElement>("[data-menu-row]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(at < 0 ? 0 : at, e.key, items.length);
    if (next !== at && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  const press = (row: MenuRow): void => {
    if (row.kind === "panel") pressDockPanel(row.id);
    else if (row.id === "keymap") {
      close(false);
      props.onOpenKeymap();
    } else {
      close(false);
      props.onToggleDoctor();
    }
  };

  const checked = (row: MenuRow): boolean | undefined => {
    if (row.kind === "panel") return modes[row.id] !== "closed";
    if (row.id === "doctor") return props.doctorOpen;
    return undefined;
  };

  return (
    <div className="wsg-anchor hdr-menu-anchor" ref={anchor}>
      <button
        ref={button}
        type="button"
        data-header-icon="menu"
        className={`icon-button hdr-menu-button${open ? " icon-button--on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(lang, "hdr.panelsMenu")}
        title={t(lang, "hdr.panelsMenu")}
        onClick={() => setOpen((was) => !was)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="3.4" r="1.15" fill="currentColor" />
          <circle cx="8" cy="8" r="1.15" fill="currentColor" />
          <circle cx="8" cy="12.6" r="1.15" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          className="wsg-pop hdr-menu-pop"
          role="menu"
          aria-label={t(lang, "hdr.panelsMenu")}
          ref={pop}
          onKeyDown={onMenuKey}
        >
          {rows.map((row, i) => {
            const on = checked(row);
            const firstTool = row.kind === "tool" && (i === 0 || rows[i - 1].kind !== "tool");
            return (
              <Fragment key={row.id}>
                {firstTool && i > 0 && <div className="hdr-menu-sep" role="separator" />}
                <button
                  type="button"
                  role={on === undefined ? "menuitem" : "menuitemcheckbox"}
                  data-menu-row={row.id}
                  aria-checked={on}
                  className="hdr-menu-row"
                  onClick={() => press(row)}
                >
                  <svg
                    className="hdr-menu-icon"
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
                    {GLYPHS[row.id]}
                  </svg>
                  <span className="hdr-menu-label">{t(lang, rowLabelKey(row))}</span>
                  {row.id === "images" && props.imageCount > 0 && (
                    <span className="hdr-menu-count tabular">{props.imageCount}</span>
                  )}
                  <span className="hdr-menu-check" aria-hidden="true">
                    {on === true ? "✓" : ""}
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
