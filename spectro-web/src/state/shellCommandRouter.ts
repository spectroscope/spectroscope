// What a menu command does to the app.
//
// Kept out of App.tsx so it can be asserted on: App gets ONE effect that hands
// every command to this function with the callbacks it already owns, and the
// mapping from id to consequence lives here where a test can walk all of it.
// shellCommandRouter.test.ts calls every id in SHELL_COMMAND_IDS and fails by
// name on any that moves nothing — which is the only way to catch a menu item
// that clicks and does nothing, since the shell cannot read renderer state and
// therefore cannot grey anything out.

import { VIEW_TABS, type ViewTab } from "./route";
import { SHELL_COMMAND_IDS, type ShellCommand, type ShellCommandId } from "./shellCommands";

/** Everything a menu command may reach. All of it already exists in App.tsx. */
export interface ShellDeps {
  newChat(): void;
  openImport(): void;
  openStarters(): void;
  openScenarios(): void;
  /** Load a bundled state-graph run by its artifact filename. */
  loadStateGraphDemo(source: string): void;
  setNav(n: "sessions" | "fleets" | "stategraph"): void;
  /** Whether the leveling ladder still has the fleets surface closed. */
  fleetsLocked: boolean;
  openLevelPanel(): void;
  changeTab(t: ViewTab): void;
  openDoctor(): void;
  openKeymap(): void;
  toggleImages(): void;
  abort(): void;
}

function isShellCommandId(id: string): id is ShellCommandId {
  return (SHELL_COMMAND_IDS as readonly string[]).includes(id);
}

function isViewTab(t: string): t is ViewTab {
  return (VIEW_TABS as readonly string[]).includes(t);
}

/**
 * Run one command from the desktop menu.
 *
 * Total: an id this build does not know is silence. The packaged app ships
 * shell and page together so they cannot disagree, but a dev run can pair a
 * new shell with an old bundle, and a crash there would be worse than a
 * no-op — the same failure aboutSignal.ts describes for its own wire.
 *
 * @param c what the shell sent
 * @param d the app's own callbacks
 */
export function runShellCommand(c: ShellCommand, d: ShellDeps): void {
  if (!isShellCommandId(c.id)) return;
  switch (c.id) {
    case "chat.new":
      d.newChat();
      return;
    case "import.open":
      d.openImport();
      return;
    case "starters.open":
      d.openStarters();
      return;
    case "scenarios.open":
      d.openScenarios();
      return;
    case "stategraph.demo":
      // A row with no source behind it must not switch the segment to an empty
      // pane and call that a load.
      if (!c.arg) return;
      d.loadStateGraphDemo(c.arg);
      // The state graph segment is deliberately not addressable, so loading a
      // run without showing the segment draws it where nobody can see it.
      // Closing that gap is what a command channel is for.
      d.setNav("stategraph");
      return;
    case "nav.sessions":
      d.setNav("sessions");
      return;
    case "nav.fleets":
      // The sidebar's fleets button silently no-ops while the surface is
      // locked. A menu item must not: it opens the ladder and teaches what is
      // missing instead of swallowing the click.
      if (d.fleetsLocked) d.openLevelPanel();
      else d.setNav("fleets");
      return;
    case "nav.stategraph":
      d.setNav("stategraph");
      return;
    case "tab.set":
      if (c.arg === undefined || !isViewTab(c.arg)) return;
      // The six view tabs are only on screen in the sessions segment — the
      // state graph takes the whole surface and the fleet lobby draws no tab
      // row — so picking one from the menu has to come back first. Entering a
      // fleet is a different axis and the menu does not address it: inside an
      // entered fleet the bar on screen is the fleet's own.
      d.setNav("sessions");
      d.changeTab(c.arg);
      return;
    case "doctor.open":
      d.openDoctor();
      return;
    case "keymap.open":
      d.openKeymap();
      return;
    case "images.toggle":
      d.toggleImages();
      return;
    case "run.abort":
      d.abort();
      return;
    default: {
      // An id added to the list without a case here fails the compile.
      const unreached: never = c.id;
      return unreached;
    }
  }
}
