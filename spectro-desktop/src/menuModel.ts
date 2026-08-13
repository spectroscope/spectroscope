// The desktop menus, as data.
//
// This module imports nothing — not even a type from electron — and that is its
// whole point. menu.ts cannot be imported by a test in spectro-web, because it
// takes MenuItemConstructorOptions from a package spectro-web does not depend
// on, which is exactly why aboutSignal.test.ts reads it as TEXT instead. A text
// assertion is the weakest gate in this repo. So the menu's SHAPE lives here,
// where menuModel.test.ts can import it for real and walk every leaf, and
// menu.ts is left holding only the translation into Electron's template.
//
// It joins navigationGuard.ts, portMemory.ts and cacheRecovery.ts as an
// electron-free module in spectro-desktop tested from spectro-web's vitest.
// That suite runs on every commit under web-gate; spectro-desktop has no test
// runner of its own and this design is how it avoids needing one.
//
// The menus are ENGLISH ONLY. The shell has no i18n mechanism — no dictionary,
// no locale lookup, every label in menu.ts and main.ts a hardcoded literal —
// and inventing one here would be a second, unpinned translation layer beside
// the app's own. Most of these strings already exist as {de,en} pairs in
// spectro-web's i18n dictionary, so a German menu is transcription rather than
// translation; what is missing is the wiring, and that is its own card.

import { SHELL_COMMAND_IDS, type ShellCommandId } from "./shellCommands";

/**
 * One entry in a menu.
 *
 * The five leaf kinds are the five mechanisms this shell actually has, and the
 * split is deliberate: a leaf's kind says how it reaches its capability, so a
 * test can ask every leaf what is behind it and an item with nothing behind it
 * has nowhere to hide.
 *
 * - `role` hands the item to Electron (and to AppKit) — copy, paste, zoom, quit
 * - `command` sends a ShellCommandId into the page over the command channel
 * - `hash` moves the window to an address the page's router parses
 * - `url` opens an external link in the user's real browser
 * - `shell` runs something in the main process, which is the only side that
 *   knows the server port, the child JVM and the cron poller
 */
export type MenuNode =
  | { kind: "separator" }
  | { kind: "role"; role: string; label?: string }
  | { kind: "command"; label: string; accelerator?: string; command: ShellCommandId; arg?: string }
  | { kind: "hash"; label: string; accelerator?: string; hash: string }
  | { kind: "shell"; label: string; accelerator?: string; action: ShellAction }
  | { kind: "url"; label: string; url: string }
  | { kind: "submenu"; label: string; role?: string; items: MenuNode[] };

/**
 * Everything the main process can be asked to do from a menu.
 *
 * main.ts declares `Record<ShellAction, () => void>`, so an action added here
 * without a handler there fails `npm run build` in spectro-desktop — which the
 * linux-kit workflow runs. That is the mechanical form of "an item with no real
 * capability behind it does not ship".
 */
export const SHELL_ACTIONS = [
  "about",
  "cronStatus",
  "restartServer",
  "openInBrowser",
  "copyServerAddress",
  "revealDataFolder",
  "focusWindow",
  "quit",
] as const;
export type ShellAction = (typeof SHELL_ACTIONS)[number];

/** The published repository. Mirrored from spectro-web's ABOUT.repo and pinned
 *  by menuWires.drift.test.ts — two build systems, no shared module. */
export const REPO = "https://github.com/spectroscope/spectroscope";

/**
 * The only documentation address that could be verified to render.
 *
 * docs/USER-GUIDE.html exists in the repository but is not in extraResources,
 * so the packaged app cannot open it locally, and GitHub serves .html as
 * source. If a real docs site appears this is the one line that moves.
 */
const DOCS_URL = `${REPO}/blob/main/docs/README.md`;

/** What the shell knows about itself that a tray row could honestly show. */
export interface TrayStatus {
  /** The port the server was reached on — OS-assigned, remembered per launch. */
  port: number;
  /** Whether the last /api/jobs/state fetch resolved AT ALL. Measured, not guessed. */
  serverUp: boolean;
  /** The last seen cron job states, id -> status. */
  jobs: Record<string, string>;
}

/**
 * The settings sections, in the order route.ts lists them.
 *
 * The labels are the settings panel's own headings, taken verbatim from the
 * app's dictionary (set.secDesign, set.secLanguage, …, leveling.settings.title,
 * set.machine) so the menu and the place it lands agree. The hashes are pinned
 * to SETTINGS_SECTIONS by menuWires.drift.test.ts: a section added to route.ts
 * without a row here turns the gate red, which is how a new section gets its
 * menu item instead of being forgotten.
 */
const SETTINGS_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["design", "Design"],
  ["language", "Language"],
  ["session", "Session defaults"],
  ["leveling", "Tutorial"],
  ["observability", "Observability"],
  ["fleet", "Fleet"],
  ["stt", "Speech to text"],
  ["workspace", "Default workspace"],
  ["logging", "Operator logging"],
  ["machine", "Machine"],
];

/**
 * The bundled state-graph runs, in the order the pane offers them.
 *
 * Source and label are pinned to SCENARIOS by menuWires.drift.test.ts, so a
 * renamed artifact cannot leave a menu row that loads nothing and a retitled
 * scenario cannot leave the menu calling it something else.
 */
const DEMO_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["crag-payload.graph.jsonl", "Reference run · the measured template"],
  ["simple-rag.graph.jsonl", "Simple RAG · linear pipeline"],
  ["crag.graph.jsonl", "CRAG · corrective loop"],
  ["react-tools.graph.jsonl", "ReAct tools · two turns, one thread"],
  ["failing-run.graph.jsonl", "Failing run · an honest node_error"],
];

/** The six view tabs. The first of each pair IS the route.ts literal. */
const TAB_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["chat", "Chat"],
  ["spectrum", "Spectrum"],
  ["graph", "Graph"],
  ["trace", "Trace"],
  ["text", "Text"],
  ["lab", "Lab"],
];

const SEP: MenuNode = { kind: "separator" };

function settingsSubmenu(): MenuNode {
  return {
    kind: "submenu",
    label: "Settings",
    items: [
      { kind: "hash", label: "All settings…", accelerator: "CmdOrCtrl+,", hash: "#/settings" },
      SEP,
      ...SETTINGS_ROWS.map(
        ([section, label]): MenuNode => ({ kind: "hash", label, hash: `#/settings/${section}` }),
      ),
    ],
  };
}

function demoSubmenu(): MenuNode {
  return {
    kind: "submenu",
    label: "Load a demo",
    items: [
      // One row, not fourteen: a scenario id is explicitly not an address
      // (route.ts, isReplayOnlyId), and the dialog is the picker that ships.
      { kind: "command", label: "Agent scenarios…", command: "scenarios.open" },
      SEP,
      ...DEMO_ROWS.map(
        ([source, label]): MenuNode => ({
          kind: "command",
          label,
          command: "stategraph.demo",
          arg: source,
        }),
      ),
    ],
  };
}

/**
 * Build the application menu.
 *
 * Every label that names the product spells it out rather than taking the
 * default from `app.name`, which is the npm package name — see menu.ts for why
 * app.setName is not the fix.
 *
 * @param o the product name, and whether this is macOS
 * @return the menu as a tree, ready for toTemplate
 */
export function appMenuModel(o: { productName: string; isMac: boolean }): MenuNode[] {
  const about: MenuNode = { kind: "shell", label: `About ${o.productName}`, action: "about" };

  const file: MenuNode = {
    kind: "submenu",
    label: "File",
    items: [
      // Was a webContents.reload(): a page reload is not the app's own new
      // chat, which drops the socket, resets the Lab's dam and re-addresses.
      { kind: "command", label: "New chat", accelerator: "CmdOrCtrl+N", command: "chat.new" },
      SEP,
      {
        kind: "command",
        label: "Import transcript…",
        accelerator: "CmdOrCtrl+O",
        command: "import.open",
      },
      { kind: "command", label: "New project from starter…", command: "starters.open" },
      SEP,
      demoSubmenu(),
      SEP,
      // ~/.spectro is the data home the server itself uses, and the shell
      // spawns the JVM with the same user.home, so the two cannot disagree.
      { kind: "shell", label: "Show session folder", action: "revealDataFolder" },
      SEP,
      // Off macOS there is no application menu, so Settings and the quit both
      // have to live here instead.
      ...(o.isMac ? [] : [settingsSubmenu(), SEP]),
      o.isMac
        ? { kind: "role" as const, role: "close", label: "Close window" }
        : { kind: "role" as const, role: "quit", label: `Quit ${o.productName}` },
    ],
  };

  const view: MenuNode = {
    kind: "submenu",
    label: "View",
    // Hand-listed rather than {role:"viewMenu"}: using the container AND
    // naming items produces duplicate accelerators, and Electron does not warn.
    items: [
      { kind: "command", label: "Sessions", accelerator: "CmdOrCtrl+1", command: "nav.sessions" },
      { kind: "command", label: "Fleets", accelerator: "CmdOrCtrl+2", command: "nav.fleets" },
      {
        kind: "command",
        label: "State graph",
        accelerator: "CmdOrCtrl+3",
        command: "nav.stategraph",
      },
      SEP,
      // Commands, not hashes: `#/spectrum` means LIVE plus spectrum and would
      // yank a reader out of a stored session. changeTab flips the tab and
      // re-addresses in place. A leveling-locked tab draws its own locked
      // panel, so none of these six is inert.
      ...TAB_ROWS.map(
        ([tab, label]): MenuNode => ({ kind: "command", label, command: "tab.set", arg: tab }),
      ),
      SEP,
      { kind: "command", label: "Images", command: "images.toggle" },
      SEP,
      { kind: "role", role: "reload" },
      { kind: "role", role: "forceReload" },
      { kind: "role", role: "toggleDevTools" },
      SEP,
      { kind: "role", role: "resetZoom" },
      { kind: "role", role: "zoomIn" },
      { kind: "role", role: "zoomOut" },
      SEP,
      { kind: "role", role: "togglefullscreen" },
    ],
  };

  const run: MenuNode = {
    kind: "submenu",
    label: "Run",
    items: [
      // Always enabled, like a browser's Stop: the shell cannot read renderer
      // state, and abort() is a no-op on a socket with nothing running.
      { kind: "command", label: "Stop run", accelerator: "CmdOrCtrl+.", command: "run.abort" },
      SEP,
      { kind: "command", label: "Doctor", command: "doctor.open" },
      // Lifted from the tray, so nothing lives only in a menu bar extra.
      { kind: "shell", label: "Cron status", action: "cronStatus" },
      SEP,
      { kind: "shell", label: "Open in browser", action: "openInBrowser" },
      // The port is OS-assigned and the window draws no address bar, so
      // without this a user cannot discover his own server address at all.
      { kind: "shell", label: "Copy server address", action: "copyServerAddress" },
      SEP,
      { kind: "shell", label: "Restart server…", action: "restartServer" },
    ],
  };

  const help: MenuNode = {
    kind: "submenu",
    label: "Help",
    // The role matters: macOS attaches its Help search to the menu it knows.
    role: "help",
    items: [
      { kind: "command", label: "Keyboard shortcuts", command: "keymap.open" },
      SEP,
      { kind: "url", label: "Documentation", url: DOCS_URL },
      { kind: "url", label: "Report an issue", url: `${REPO}/issues` },
      // Windows and Linux have no application menu, and About belongs in Help
      // there. Without this the entry exists on one platform out of three.
      ...(o.isMac ? [] : [SEP, about]),
    ],
  };

  return [
    ...(o.isMac
      ? [
          {
            kind: "submenu" as const,
            label: o.productName,
            items: [
              about,
              SEP,
              settingsSubmenu(),
              SEP,
              { kind: "role" as const, role: "services" },
              SEP,
              { kind: "role" as const, role: "hide", label: `Hide ${o.productName}` },
              { kind: "role" as const, role: "hideOthers" },
              { kind: "role" as const, role: "unhide" },
              SEP,
              { kind: "role" as const, role: "quit", label: `Quit ${o.productName}` },
            ],
          },
        ]
      : []),
    file,
    // Untouched, and NOT hand-rolled: replacing the role with hand-written
    // items kills Cmd+C/Cmd+V app-wide, DevTools and native fields included.
    // Cmd+F is deliberately absent — editMenu does not carry Find, which is
    // precisely what leaves the chord with SearchBox's own platform split.
    { kind: "role", role: "editMenu", label: "Edit" },
    view,
    run,
    // One line for Minimize, Zoom, Bring All to Front and the window list.
    // Apple marks this menu required and the shell ships none today.
    { kind: "role", role: "windowMenu", label: "Window" },
    help,
  ];
}

/**
 * The label for the tray's cron row, counting what the poller has seen.
 *
 * The count goes in the LABEL because macOS ignores `enabled` and `visible` on
 * a top-level tray row: greying out is not available at this level, so state
 * has nowhere else to go.
 *
 * @param jobs the last /api/jobs/state, id -> status
 * @return "Cron status" when nothing has run yet, otherwise a count
 */
export function cronLabel(jobs: Record<string, string>): string {
  const states = Object.values(jobs);
  if (states.length === 0) return "Cron status";
  const running = states.filter((s) => s === "running").length;
  const plural = states.length === 1 ? "job" : "jobs";
  const tail = running === 0 ? "" : `, ${running} running`;
  return `Cron · ${states.length} ${plural}${tail}`;
}

/**
 * Build the tray menu.
 *
 * Short and action-shaped, and every row also exists in the menu bar — a user
 * can hide menu bar extras, so nothing may live only here. The one exception is
 * the row that reopens a closed window: on macOS setContextMenu suppresses the
 * tray's own click event, so it is the only way back.
 *
 * @param o the product name, and what the shell honestly knows right now
 * @return the tray menu as a tree, ready for toTemplate
 */
export function trayMenuModel(o: { productName: string; status: TrayStatus }): MenuNode[] {
  return [
    { kind: "shell", label: `Open ${o.productName}`, action: "focusWindow" },
    { kind: "command", label: "New chat", command: "chat.new" },
    { kind: "separator" },
    { kind: "shell", label: cronLabel(o.status.jobs), action: "cronStatus" },
    { kind: "hash", label: "Settings", hash: "#/settings" },
    { kind: "separator" },
    {
      kind: "shell",
      label: o.status.serverUp ? "Restart server…" : "Restart server… (not responding)",
      action: "restartServer",
    },
    { kind: "separator" },
    { kind: "shell", label: `Quit ${o.productName}`, action: "quit" },
  ];
}

/**
 * The tray's tooltip: the address the window does not draw, and the count.
 *
 * @param productName the name to lead with
 * @param s what the shell knows
 * @return one line
 */
export function trayTooltip(productName: string, s: TrayStatus): string {
  if (!s.serverUp) return `${productName} · server not responding`;
  const states = Object.values(s.jobs);
  const jobs = states.length === 0 ? "no cron jobs yet" : `${states.length} cron ${states.length === 1 ? "job" : "jobs"}`;
  return `${productName} · 127.0.0.1:${s.port} · ${jobs}`;
}

/**
 * A change detector for the tray.
 *
 * Mutating a MenuItem's label shows nothing — the whole menu has to be rebuilt
 * and setContextMenu called again. At the poller's 30 s cadence that is free,
 * but only behind a guard, so the poller compares this string against the last
 * one and rebuilds when it differs.
 *
 * @param s what the shell knows
 * @return a string that changes exactly when something visible does
 */
export function traySummary(s: TrayStatus): string {
  return JSON.stringify([s.port, s.serverUp, cronLabel(s.jobs)]);
}

/** Re-exported so a caller does not need both modules to validate an id. */
export { SHELL_COMMAND_IDS };
