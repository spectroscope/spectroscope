// Where the browser pane goes, decided here so it can be tested without a DOM.
//
// The visible browser (card 201) is a native WebContentsView the desktop shell
// lays OVER this window. React cannot draw into it and cannot lay it out; what
// React can do is reserve a rectangle and say where that rectangle is. So the
// segment renders a hole, measures it, and posts the rectangle to the server,
// which forwards it down the control channel the shell already holds.
//
// The alternative wire — a preload script and ipcRenderer — is the surface the
// desktop shell deliberately does not have (navigationGuard.ts calls the absence
// a security property). One POST on a resize is the cheaper price.

/** A rectangle in window CSS pixels, which is what the shell positions in. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** What the server says about the browser right now. */
export interface BrowserStatus {
  attached: boolean;
  url: string | null;
}

/** How far a rectangle must move before it is worth another POST. */
const MOVED_PX = 1;

/**
 * Whether this rectangle is worth sending.
 *
 * A resize fires a rectangle per animation frame; a scroll inside the app fires
 * one per frame too. Posting all of them would put a request on every frame for
 * a pane that did not move, so only real movement travels — plus every change of
 * visibility, which is never merely cosmetic: it is the difference between the
 * operator seeing the page and seeing the app behind it.
 */
export function shouldReport(next: PaneRect, last: PaneRect | null): boolean {
  if (last === null) return true;
  if (last.visible !== next.visible) return true;
  return (
    Math.abs(last.x - next.x) >= MOVED_PX ||
    Math.abs(last.y - next.y) >= MOVED_PX ||
    Math.abs(last.width - next.width) >= MOVED_PX ||
    Math.abs(last.height - next.height) >= MOVED_PX
  );
}

/** Rounds a measured DOMRect into the integer pixels the shell positions in. */
export function toPaneRect(
  box: { left: number; top: number; width: number; height: number },
  visible: boolean,
): PaneRect {
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
    visible,
  };
}

/**
 * What the segment should say to the reader.
 *
 * Three states, and the middle one is the ratified trade from card 200 said out
 * loud instead of only in a document: a reader running `spectro web` and
 * pointing their own browser here gets no pane, and a rectangle that stayed
 * empty would read as a bug rather than as a decision.
 */
export type PanelState = "loading" | "no-shell" | "attached";

/**
 * Whether THIS page is the desktop shell's own window.
 *
 * The pane is a native overlay laid over one specific window, so "a shell is
 * attached" and "the pane is over the rectangle I just measured" are different
 * facts. A reader with the desktop app open, who then points their own browser
 * at the same server, is told the first and shown the second: a green dot over
 * an empty frame. Measured live on 2026-08-13, on this build.
 *
 * The check is a marker the shell STAMPS on its own window's user agent
 * (spectro-desktop/src/main.ts), which is the one thing a renderer can learn
 * about its host without a preload script. Reading "Electron/" instead was the
 * obvious version and it is wrong: the browser this card was verified in is
 * itself an Electron app and claimed to be the shell. Only a string this
 * product writes identifies this product.
 *
 * <p>It errs toward "no": a stripped or rewritten user agent reads as an
 * ordinary browser and gets the honest panel, which is the safe direction — the
 * cost of a false no is a panel that under-promises, the cost of a false yes is
 * a second reader dragging the operator's pane around.
 *
 * @param userAgent the navigator's own string
 */
export function isDesktopShell(userAgent: string): boolean {
  return userAgent.includes(DESKTOP_MARKER);
}

/**
 * The marker the desktop shell appends to its window's user agent. Mirrored in
 * spectro-desktop/src/main.ts; browserMarker.drift.test.ts holds the two equal.
 */
export const DESKTOP_MARKER = "spectroscope-desktop/";

/**
 * Reads the panel state off the server's answer AND off where this page is.
 *
 * @param status  what /api/browser/status returned, or null before it answers
 * @param inShell whether this page is the desktop shell's own window
 */
export function panelState(status: BrowserStatus | null, inShell: boolean): PanelState {
  if (status === null) return "loading";
  return status.attached && inShell ? "attached" : "no-shell";
}

/** The i18n key for the sentence under the panel's heading, per state. */
export function panelNoteKey(state: PanelState): string {
  switch (state) {
    case "attached":
      return "browser.attachedNote";
    case "no-shell":
      return "browser.noShellNote";
    default:
      return "browser.loadingNote";
  }
}
