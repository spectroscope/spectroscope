// Card 228, criterion 7 — the header's panel toggles, exactly the reference
// shape (Claude Code's header): one icon per panel with a pressed state, and
// a ⋮ overflow menu listing every panel with a check row.
//
// This is the SECOND door to the dock's state, never a copy: pressed states
// and check rows read the same `spectroscope:layout` store the dock strip
// reads, and presses go through the store's own verbs. Opening a panel from
// here also reveals the workspace (openRightPanel) — a press that changes
// state nobody can see is the dishonesty the dock's own buttons never had.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { openDockPanel, openRightPanel, toggleDockPanel, useLayout } from "../state/layout";
import type { DockPanelId } from "../state/layout";
import { DOCK_ORDER, dockLabelKey, dockModes } from "./dockModel";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The panels that earn their own header icon — the reference's set. The rest
 *  live behind the overflow menu, which lists ALL of them. */
export const HEADER_ICON_PANELS: readonly DockPanelId[] = ["files", "terminal", "browser"];

/** The three icon glyphs, in the header's 16px box. The browser pane glyph is
 *  the rail's own geometry (NavRow.tsx) — one thing, one picture. */
const GLYPHS: Partial<Record<DockPanelId, ReactNode>> = {
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
};

export function DockHeaderControls({
  workOffered,
  menuOpenForTest,
}: {
  /** Whether the v2 reading offers the work panel — same gate as the dock. */
  workOffered: boolean;
  /** Static markup cannot click; tests render the menu open through this. */
  menuOpenForTest?: boolean;
}) {
  const lang = useLang();
  const layout = useLayout();
  const modes = dockModes(layout);
  const [menuOpen, setMenuOpen] = useState(menuOpenForTest === true);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /** One press, either door: opening reveals the workspace too, closing
   *  leaves the workspace as it is (the strip behaves the same way). */
  const press = (id: DockPanelId): void => {
    if (modes[id] === "closed") {
      openDockPanel(id);
      openRightPanel();
    } else {
      toggleDockPanel(id);
    }
  };

  const offered = DOCK_ORDER.filter((id) => id !== "work" || workOffered);

  return (
    <>
      {HEADER_ICON_PANELS.map((id) => {
        const on = modes[id] !== "closed";
        return (
          <button
            key={id}
            type="button"
            className={`icon-button hdr-panel-icon${on ? " icon-button--on" : ""}`}
            aria-label={t(lang, dockLabelKey(id))}
            title={t(lang, dockLabelKey(id))}
            aria-pressed={on}
            onClick={() => press(id)}
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
              {GLYPHS[id]}
            </svg>
          </button>
        );
      })}
      <div className="wsg-anchor hdr-panels-anchor" ref={anchor}>
        <button
          type="button"
          className={`icon-button hdr-panel-more${menuOpen ? " icon-button--on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t(lang, "hdr.panelsMenu")}
          title={t(lang, "hdr.panelsMenu")}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="8" cy="3.4" r="1.15" fill="currentColor" />
            <circle cx="8" cy="8" r="1.15" fill="currentColor" />
            <circle cx="8" cy="12.6" r="1.15" fill="currentColor" />
          </svg>
        </button>
        {menuOpen && (
          <div className="wsg-pop hdr-panels-pop" role="menu" aria-label={t(lang, "hdr.panelsMenu")}>
            {offered.map((id) => {
              const on = modes[id] !== "closed";
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  data-menu-panel={id}
                  className="wsg-mode-row hdr-panels-row"
                  onClick={() => press(id)}
                >
                  <span className="hdr-panels-check" aria-hidden="true">
                    {on ? "✓" : ""}
                  </span>
                  {t(lang, dockLabelKey(id))}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
