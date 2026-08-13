// The one way the desktop menu bar reaches this app.
//
// The shell owns a native menu the web app cannot see, and it has no IPC: the
// window exposes no Node API on purpose. So a menu click arrives the way the
// About panel's already does — a CustomEvent dispatched into the page — except
// that ONE event carries an id instead of one event name per item. The id list
// below is mirrored from spectro-desktop/src/shellCommands.ts, duplicated for
// the reason aboutSignal.ts states: two projects, two build systems, no shared
// module. shellCommands.test.ts imports both lists and compares them, which is
// a stronger pin than About's substring read and is available because neither
// copy imports anything from electron.
//
// The listener attaches at MODULE SCOPE, and commands that arrive before the
// app subscribes are held. That is not decoration. The shell dispatches on
// did-finish-load and React mounts after that event, so a command sent to a
// window the menu just created lands before any useEffect has run. showAbout()
// has that race today and gets away with it; this channel does not have to.
// Same house pattern as sendQueue and voiceWire.

/** The event the desktop shell dispatches on `window`. */
export const SHELL_COMMAND = "spectroscope:command";

/** Every command the shell can send. Pinned equal to the shell's own list. */
export const SHELL_COMMAND_IDS = [
  "chat.new",
  "import.open",
  "starters.open",
  "scenarios.open",
  "stategraph.demo",
  "nav.sessions",
  "nav.fleets",
  "nav.stategraph",
  "tab.set",
  "doctor.open",
  "keymap.open",
  "images.toggle",
  "run.abort",
] as const;
export type ShellCommandId = (typeof SHELL_COMMAND_IDS)[number];

/**
 * What arrived.
 *
 * `id` is a plain string rather than a ShellCommandId: a dev run can pair a
 * newer shell with an older bundle, and an id this build has never heard of is
 * data to ignore, not a type error to pretend cannot happen.
 */
export type ShellCommand = { id: string; arg?: string };

/** The slice of EventTarget this needs — so a test can drive it without a DOM. */
export type CmdEventTarget = {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
};

let handler: ((c: ShellCommand) => void) | null = null;
const pending: ShellCommand[] = [];

/** Read the event's detail, refusing anything that is not a command. */
function readCommand(e: Event): ShellCommand | null {
  const detail: unknown = (e as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== "object") return null;
  const id: unknown = (detail as { id?: unknown }).id;
  if (typeof id !== "string" || id === "") return null;
  const arg: unknown = (detail as { arg?: unknown }).arg;
  return typeof arg === "string" ? { id, arg } : { id };
}

const listener = (e: Event): void => {
  const command = readCommand(e);
  if (command === null) return;
  if (handler === null) pending.push(command);
  else handler(command);
};

/**
 * Start holding commands from a target.
 *
 * Called once at module scope for `window`, and by tests for a fake target.
 *
 * @param target where the shell's events arrive
 * @return the unsubscribe
 */
export function listenForShellCommands(target: CmdEventTarget): () => void {
  target.addEventListener(SHELL_COMMAND, listener);
  return () => target.removeEventListener(SHELL_COMMAND, listener);
}

if (typeof window !== "undefined") listenForShellCommands(window);

/**
 * Handle menu commands, including any that arrived before this call.
 *
 * One handler at a time — the app subscribes once. A second call replaces the
 * first rather than fanning out, because two answers to one menu click is a
 * bug that would take a while to see.
 *
 * @param handle what to run per command
 * @param target an extra source to listen on, for tests
 * @return the unsubscribe, shaped for a useEffect cleanup
 */
export function onShellCommand(handle: (c: ShellCommand) => void, target?: CmdEventTarget): () => void {
  handler = handle;
  // Drained by shift rather than replayed, so a remount cannot re-run a
  // command the previous mount already answered.
  while (pending.length > 0) handle(pending.shift() as ShellCommand);
  const stop = target ? listenForShellCommands(target) : null;
  return () => {
    if (handler === handle) handler = null;
    if (stop) stop();
  };
}
