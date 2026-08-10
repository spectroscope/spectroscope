// Where the desktop window is allowed to go (card 150).
//
// `setWindowOpenHandler` already covers `window.open` and `target=_blank`, and
// sends http(s) targets to the real browser. It does NOT cover a same-window
// navigation: `location.href = …`, or a plain link with no target. Nothing in
// this app can reach that today — there is no HTML injection sink, markdown
// hrefs are sanitized at parse time, React 19 blocks `javascript:` besides, and
// the shell has no preload script at all — so this is a seatbelt rather than a
// patched hole. It is here because four lines remove a whole class of future
// regression, in a window that has no address bar to notice one by.
//
// Pure and Electron-free on purpose, so it can be tested from spectro-web the
// way `portMemory` and `cacheRecovery` already are. spectro-desktop has no test
// runner, and `gate.yml` has no job for it either.

/**
 * Whether the window may navigate itself to this URL.
 *
 * @param home the origin the window was loaded from — the loopback server on
 *             the port this launch picked (card 168). Null before it has loaded,
 *             which reads as "allow nothing": a guard that waves things through
 *             until it knows better is decoration.
 * @param target the URL the page is trying to reach
 * @return true only for the page's own origin
 */
export function allowsNavigation(home: string | null, target: string): boolean {
  if (home === null || home === "") return false;
  let here: URL;
  let there: URL;
  try {
    here = new URL(home);
    there = new URL(target);
  } catch {
    // An unreadable URL is refused rather than waved through. The safe side of
    // "I cannot tell" is no.
    return false;
  }
  // `origin` compares scheme, host AND port as one value, which is what closes
  // the two mistakes a hand-rolled check makes: another server on another port
  // is another application, and a host that merely STARTS the same way
  // (127.0.0.1.evil.com) is a different host entirely.
  return there.origin === here.origin;
}
