// The one way anything outside React asks for the About panel.
//
// The desktop shell owns a native menu bar the web app cannot see, and its
// "About spectroscope" item has to reach the panel the footer already opens.
// The alternative was a second About written in Electron, which would be a
// second copy of a licence notice — the exact thing about.drift.test.ts exists
// to prevent. So the shell dispatches this event into the page it is already
// showing, and the panel that answers is the drift-pinned one.
//
// The event name therefore spans two projects, which makes it the kind of wire
// that dies quietly: rename it here and the menu item still exists, still
// clicks, and does nothing. aboutSignal.test.ts reads the shell's menu module
// off disk so that rename fails the gate instead of shipping.

/** The event the desktop shell dispatches on `window` to open the panel. */
export const ABOUT_REQUESTED = "spectroscope:about";

/** The slice of EventTarget this needs — so a test can drive it without a DOM. */
export type AboutEventTarget = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/**
 * Call `open` whenever something outside React asks for the About panel.
 *
 * @param open what to run on each request, typically a setState
 * @param target the source to listen on; defaults to `window` when there is one
 * @return the unsubscribe, shaped for a useEffect cleanup
 */
export function onAboutRequested(open: () => void, target?: AboutEventTarget): () => void {
  const source = target ?? (typeof window === "undefined" ? null : window);
  if (source === null) return () => {};
  source.addEventListener(ABOUT_REQUESTED, open);
  return () => source.removeEventListener(ABOUT_REQUESTED, open);
}
