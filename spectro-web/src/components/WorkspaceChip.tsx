// Card 462 (owner, 2026-09-29): the header names the working folder of the
// live session, like Claude Code's folder chip, and its menu offers the four
// things one does with it: show it in Finder, copy its path, choose another,
// open a terminal there. Card 472 adds "Build code graph" below them.
//
// Finder and Terminal are the server's job (POST /api/workspace/reveal and
// /terminal). The page sends the session id, never a path: the server opens
// the folder it resolved for that session, and before the first message there
// is no session, so those two rows wait until then.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ReactNode } from "react";
import type { WorkspaceInfo } from "../state/reducer";
import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { chooserFolder, chooserTitle } from "../workspace/chooserMode";
import { nextMenuIndex } from "../panels/headerPanelControls";
import { openCodeGraphSheet } from "../codegraph/codeGraphStore";

/** The menu's rows, in Claude Code's order. */
export const WORKSPACE_CHIP_ACTIONS = ["reveal", "copy", "change", "terminal"] as const;
export type WorkspaceChipAction = (typeof WORKSPACE_CHIP_ACTIONS)[number];

/**
 * Which rows can act on this announcement, and the reason a row cannot: copy
 * needs a path; Finder and Terminal need macOS (the server opens them there
 * only) and a session the server knows the folder by; a new folder can be
 * chosen where the chooser row may (card 428: before the first message, and
 * not while a run is going).
 *
 * @param opts.canPick whether the folder may change now (App's canPickWorkspace)
 * @param opts.mac     whether the server runs on macOS (the same machine)
 * @returns one entry per row, in the menu's order
 */
export function chipActions(
  ws: WorkspaceInfo,
  opts: { canPick: boolean; mac: boolean },
): { id: WorkspaceChipAction; enabled: boolean; reason?: string }[] {
  const path = chooserTitle(ws) !== null;
  const session = path && typeof ws.sessionId === "string" && ws.sessionId !== "";
  const opener = (): { enabled: boolean; reason?: string } =>
    !opts.mac
      ? { enabled: false, reason: "wchip.macOnly" }
      : folderGone(ws)
        ? { enabled: false, reason: "wchip.notFound" }
        : session
          ? { enabled: true }
          : { enabled: false, reason: "wchip.needsSession" };
  const rows: Record<WorkspaceChipAction, { enabled: boolean; reason?: string }> = {
    reveal: opener(),
    copy: path ? { enabled: true } : { enabled: false, reason: "wchip.none" },
    change: opts.canPick ? { enabled: true } : { enabled: false, reason: "wchip.changeLocked" },
    terminal: opener(),
  };
  return WORKSPACE_CHIP_ACTIONS.map((id) => ({ id, ...rows[id] }));
}

/**
 * Card 498: the session is known to the server and its folder is not on disk,
 * which is what the wake of a stored session whose folder was deleted answers.
 * Before a session exists a missing folder is only a folder the first run will
 * create, so that case does not count.
 */
export function folderGone(ws: WorkspaceInfo): boolean {
  return typeof ws.sessionId === "string" && ws.sessionId !== "" && ws.exists === false;
}

/**
 * Card 472: "Build code graph" below the four actions. The server builds the
 * folder it resolved for the session, so the row waits for a session like
 * Finder and Terminal do, on every platform, and stays shut for a folder that
 * is gone (card 498).
 */
export function codeGraphRowEnabled(ws: WorkspaceInfo): boolean {
  return (
    chooserTitle(ws) !== null && typeof ws.sessionId === "string" && ws.sessionId !== "" && !folderGone(ws)
  );
}

/** Why Finder or Terminal did not open, in words rather than a status code. */
export function failureText(lang: Lang, status: number): string {
  if (status === 0) return t(lang, "wchip.unreachable");
  if (status === 501) return t(lang, "wchip.macOnly");
  if (status === 404) return t(lang, "wchip.notFound");
  return t(lang, "wchip.failed", { status: String(status) });
}

/** Whether this browser runs on macOS; the server shares the machine (local fence). */
function onAMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}

/** The chip's text: the folder's own name, or that there is none yet. */
export function chipLabel(lang: Lang, ws: WorkspaceInfo): string {
  return chooserFolder(ws) ?? t(lang, "wchip.none");
}

/**
 * Asks the server to open the session's folder in Finder or in Terminal.
 *
 * @returns the HTTP status, 204 when it opened, 0 when the server is unreachable
 */
export async function postWorkspaceAction(
  kind: "reveal" | "terminal",
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  try {
    const res = await fetchFn(`/api/workspace/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * How far to move the menu to the left so it ends inside the window: by what
 * would run past the right edge, and never past the left margin.
 *
 * @param anchorLeft the chip's left edge in the viewport
 * @param popWidth   the menu's width
 * @param viewport   the window's width
 * @param margin     the gap to keep at both edges
 * @returns a shift of zero or less, in px
 */
export function menuShift(anchorLeft: number, popWidth: number, viewport: number, margin = 8): number {
  const over = viewport - margin - (anchorLeft + popWidth);
  return Math.max(margin - anchorLeft, Math.min(0, over));
}

/** Every row the arrows walk: the four actions and the code graph row, enabled ones only. */
const ROWS = "[data-ws-action]:not(:disabled), [data-ws-extra]:not(:disabled)";

/** The glyphs, in a 16px box. */
const GLYPHS: Record<WorkspaceChipAction | "folder" | "codegraph", ReactNode> = {
  codegraph: (
    <>
      <circle cx="3.5" cy="4" r="1.5" />
      <circle cx="12.5" cy="5" r="1.5" />
      <circle cx="7" cy="12" r="1.5" />
      <path d="M5 4.3l6 .5M4.3 5.3l1.9 5.3M11.6 6.3l-3.6 4.6" />
    </>
  ),
  folder: (
    <path d="M2 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z" />
  ),
  reveal: (
    <>
      <path d="M2 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z" />
      <circle cx="8" cy="9" r="1.6" />
    </>
  ),
  copy: (
    <>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.4" />
      <path d="M11 5V3.6c0-.6-.5-1.1-1.1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v6.3c0 .6.5 1.1 1.1 1.1H5" />
    </>
  ),
  change: (
    <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13.5 5.7M13.5 2.5v3.2h-3.2M13.5 8a5.5 5.5 0 0 1-9.4 3.9L2.5 10.3M2.5 13.5v-3.2h3.2" />
  ),
  terminal: (
    <>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.4" />
      <path d="M4.4 6l2.2 2-2.2 2M8.4 10.4h3.2" />
    </>
  ),
};

function Glyph({ id, className }: { id: WorkspaceChipAction | "folder" | "codegraph"; className: string }) {
  return (
    <svg
      className={className}
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
  );
}

export function WorkspaceChip(props: {
  /** The workspace_info announcement of the live session. */
  workspace: WorkspaceInfo;
  /** Opens the system folder dialog and sends the choice (App.pickWorkspace). */
  onPickFolder: () => void;
  /** Whether the folder may change now (card 428's rule, App.canPickWorkspace). */
  canPick: boolean;
  /** macOS or not; read from the browser when left out. */
  mac?: boolean;
  /** Static markup cannot click; tests render the menu open through this. */
  menuOpenForTest?: boolean;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(props.menuOpenForTest === true);
  const [note, setNote] = useState<string | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const path = chooserTitle(props.workspace);

  // The chip sits beside the title, so its menu can reach past the right edge
  // of a narrow window; it moves left by what it would lose.
  useLayoutEffect(() => {
    if (!open || anchor.current === null || pop.current === null) return;
    const left = anchor.current.getBoundingClientRect().left;
    setShift(menuShift(left, pop.current.offsetWidth, window.innerWidth));
  }, [open]);

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
    // The first row that can act takes the focus, so the arrows work at once.
    pop.current?.querySelector<HTMLButtonElement>("[data-ws-action]:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const actions = chipActions(props.workspace, { canPick: props.canPick, mac: props.mac ?? onAMac() });

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(ROWS)];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(at < 0 ? 0 : at, e.key, rows.length);
    if (next !== at && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      rows[next]?.focus();
    }
  };

  const act = async (id: WorkspaceChipAction): Promise<void> => {
    setNote(null);
    if (id === "change") {
      setOpen(false);
      props.onPickFolder();
      return;
    }
    if (id === "copy") {
      if (path === null) return;
      try {
        await navigator.clipboard.writeText(path);
        setNote(t(lang, "wchip.copied"));
      } catch {
        setNote(t(lang, "wchip.clipboard"));
      }
      return;
    }
    const sessionId = props.workspace.sessionId;
    if (sessionId === undefined) return;
    const status = await postWorkspaceAction(id, sessionId);
    if (status === 204) setOpen(false);
    else setNote(failureText(lang, status));
  };

  return (
    <div className="wsg-anchor ws-chip-anchor" ref={anchor}>
      <button
        ref={button}
        type="button"
        className="ws-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          path === null
            ? t(lang, "wchip.none")
            : folderGone(props.workspace)
              ? `${t(lang, "wchip.title", { path })}. ${t(lang, "wchip.notFound")}`
              : t(lang, "wchip.title", { path })
        }
        onClick={() => {
          setNote(null);
          setOpen((was) => !was);
        }}
      >
        <Glyph id="folder" className="ws-chip-icon" />
        <span className="ws-chip-name">{chipLabel(lang, props.workspace)}</span>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="provider-caret">
          <path
            d="M3 4.5 L6 7.5 L9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="wsg-pop ws-chip-pop"
          ref={pop}
          style={shift !== 0 ? { left: `${shift}px` } : undefined}
        >
          {path !== null && <span className="ws-chip-path mono">{path}</span>}
          <div role="menu" aria-label={t(lang, "wchip.menu")} onKeyDown={onMenuKey}>
            {actions.map(({ id, enabled, reason }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                data-ws-action={id}
                className="hdr-menu-row"
                disabled={!enabled}
                title={reason === undefined ? undefined : t(lang, reason)}
                onClick={() => void act(id)}
              >
                <Glyph id={id} className="hdr-menu-icon" />
                <span className="hdr-menu-label">{t(lang, `wchip.${id}`)}</span>
              </button>
            ))}
            <div className="hdr-menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              data-ws-extra="codegraph"
              className="hdr-menu-row"
              disabled={!codeGraphRowEnabled(props.workspace)}
              title={
                codeGraphRowEnabled(props.workspace)
                  ? undefined
                  : t(lang, folderGone(props.workspace) ? "wchip.notFound" : "wchip.needsSession")
              }
              onClick={() => {
                setOpen(false);
                openCodeGraphSheet("build");
              }}
            >
              <Glyph id="codegraph" className="hdr-menu-icon" />
              <span className="hdr-menu-label">{t(lang, "wchip.codegraph")}</span>
            </button>
          </div>
          {actions.some((a) => a.reason === "wchip.needsSession") && (
            <span className="ws-chip-note">{t(lang, "wchip.needsSession")}</span>
          )}
          {folderGone(props.workspace) && <span className="ws-chip-note">{t(lang, "wchip.notFound")}</span>}
          <span className="ws-chip-note" role="status">
            {note ?? ""}
          </span>
        </div>
      )}
    </div>
  );
}
