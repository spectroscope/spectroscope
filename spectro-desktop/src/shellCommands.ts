// The one channel the menus reach the page through.
//
// There is no IPC in this shell and there is not going to be one: the window
// deliberately exposes no Node API (contextIsolation on, nodeIntegration off,
// no preload), and adding a preload just to carry menu clicks would change the
// security posture of the whole renderer for the sake of a click.
//
// So the menu talks the way showAbout() already talks — a DOM CustomEvent
// dispatched through webContents.executeJavaScript. What is new here is that
// there is ONE event carrying an id, rather than one event name per menu item.
// A dozen event names would be a dozen wires to keep alive across two projects;
// one name plus a list is a single wire and a single drift test.
//
// The mirror lives in spectro-web/src/state/shellCommands.ts. Duplicated
// deliberately, for the reason aboutSignal.ts states: two projects, two build
// systems, no shared module. The copy is gated — shellCommands.test.ts imports
// BOTH lists and compares them, which it can do only because this file imports
// nothing from electron.

/** The event the page listens for on `window`. */
export const SHELL_COMMAND = "spectroscope:command";

/**
 * Every command a menu item may send.
 *
 * The list is the contract in both directions: the page's router switches over
 * it exhaustively, and menuModel.test.ts refuses a menu item naming anything
 * outside it. An id added here without a case in the router fails the router's
 * own suite by name.
 */
export const SHELL_COMMAND_IDS = [
  "chat.new",
  "import.open",
  "starters.open",
  "scenarios.open",
  "stategraph.demo",
  "nav.sessions",
  "nav.fleets",
  "nav.stategraph",
  "nav.browser",
  "tab.set",
  "doctor.open",
  "keymap.open",
  "images.toggle",
  "run.abort",
] as const;
export type ShellCommandId = (typeof SHELL_COMMAND_IDS)[number];

/**
 * The script a menu item runs in the page.
 *
 * Both values go through JSON.stringify, so no id and no argument — a demo
 * filename, most plausibly — can end the literal and start being code.
 *
 * @param id which command
 * @param arg the command's argument, for the two ids that take one
 * @return a self-contained expression, safe to hand to executeJavaScript
 */
export function shellCommandScript(id: ShellCommandId, arg?: string): string {
  const detail = arg === undefined ? { id } : { id, arg };
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(SHELL_COMMAND)},{detail:${JSON.stringify(detail)}}))`;
}
