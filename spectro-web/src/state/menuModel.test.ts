// The desktop menus, as data.
//
// Tested from here for the reason navigationGuard, portMemory and cacheRecovery
// are: the decision is a tree of labels and mechanisms, it must not need
// Electron to run, and spectro-desktop has no test runner of its own. The
// difference from aboutSignal.test.ts — which reads the shell's menu module as
// TEXT — is that menuModel.ts imports nothing from electron, so it can be
// imported for real and asserted on structurally.
//
// What these cases are for: a menu item is the cheapest thing in a desktop app
// to ship dead. It exists, it clicks, and nothing happens. So every leaf here
// is walked and asked what is behind it.

import { describe, expect, it } from "vitest";
import {
  SHELL_ACTIONS,
  appMenuModel,
  cronLabel,
  trayMenuModel,
  traySummary,
  trayTooltip,
  type MenuNode,
} from "../../../spectro-desktop/src/menuModel";
import { SHELL_COMMAND_IDS } from "../../../spectro-desktop/src/shellCommands";

const MAC = appMenuModel({ productName: "spectroscope", isMac: true });
const OTHER = appMenuModel({ productName: "spectroscope", isMac: false });

/** Every node in the tree, parents included, in reading order. */
function walk(nodes: readonly MenuNode[]): MenuNode[] {
  return nodes.flatMap((n) => (n.kind === "submenu" ? [n, ...walk(n.items)] : [n]));
}

/** The leaves — what a person can actually click. */
function leaves(nodes: readonly MenuNode[]): MenuNode[] {
  return walk(nodes).filter((n) => n.kind !== "submenu" && n.kind !== "separator");
}

function topLabels(nodes: readonly MenuNode[]): string[] {
  return nodes.map((n) => ("label" in n && n.label !== undefined ? n.label : `?${n.kind}`));
}

function accelerators(nodes: readonly MenuNode[]): string[] {
  return walk(nodes).flatMap((n) => ("accelerator" in n && n.accelerator ? [n.accelerator] : []));
}

describe("the application menu", () => {
  it("puts the product's own menus between View and Window", () => {
    expect(topLabels(MAC)).toEqual(["spectroscope", "File", "Edit", "View", "Run", "Window", "Help"]);
    // Off macOS there is no application menu; everything it held has to live
    // somewhere else, and Settings moves into File.
    expect(topLabels(OTHER)).toEqual(["File", "Edit", "View", "Run", "Window", "Help"]);
    const fileOff = OTHER.find((n) => n.kind === "submenu" && n.label === "File");
    expect(fileOff && fileOff.kind === "submenu" ? topLabels(fileOff.items) : []).toContain("Settings");
  });

  it("leaves Edit to the role so copy and paste keep working", () => {
    expect(MAC.find((n) => n.kind === "role" && n.role === "editMenu")).toBeDefined();
    // Hand-rolling the items is the failure: a hand-built Edit menu without
    // the roles kills the chords app-wide, DevTools and native fields with it.
    const hand = walk(MAC).filter(
      (n) => n.kind === "role" && ["cut", "copy", "paste", "selectAll", "undo", "redo"].includes(n.role),
    );
    expect(hand).toEqual([]);
    // And the container roles are used once each, never beside a duplicate.
    for (const role of ["editMenu", "windowMenu", "viewMenu"]) {
      expect(walk(MAC).filter((n) => n.kind === "role" && n.role === role).length).toBeLessThan(2);
    }
  });

  it("never binds the same accelerator twice", () => {
    // Electron does not warn about a duplicate; exactly one of the two items
    // fires and the other is dead for good.
    const all = accelerators(MAC);
    expect(all.length).toBeGreaterThan(0);
    expect([...new Set(all)]).toEqual(all);
    expect([...new Set(accelerators(OTHER))]).toEqual(accelerators(OTHER));
  });

  it("binds no chord the page already owns", () => {
    // Cmd+Left/Right are the app's guarded back/forward (App.tsx), Cmd+F is
    // SearchBox's find. A menu accelerator fires first and bypasses both.
    for (const owned of ["CmdOrCtrl+Left", "CmdOrCtrl+Right", "CmdOrCtrl+F"]) {
      expect(accelerators(MAC)).not.toContain(owned);
    }
    // No bare keys either: the Lab transport reads space, arrows, f and r
    // unmodified, and `?` opens the keymap. A modifierless accelerator would
    // take those from the whole app, composer included.
    for (const accel of accelerators(MAC)) expect(accel).toContain("+");
  });

  it("gives every non-role item a real mechanism", () => {
    const clickable = leaves(MAC).filter((n) => n.kind !== "role");
    expect(clickable.length).toBeGreaterThan(20);
    for (const node of clickable) {
      switch (node.kind) {
        case "command":
          expect(SHELL_COMMAND_IDS).toContain(node.command);
          break;
        case "hash":
          expect(node.hash.startsWith("#/")).toBe(true);
          break;
        case "url":
          expect(node.url.startsWith("https://")).toBe(true);
          break;
        case "shell":
          expect(SHELL_ACTIONS).toContain(node.action);
          break;
        default:
          throw new Error(`a leaf with no mechanism: ${JSON.stringify(node)}`);
      }
      expect("label" in node && node.label.length > 0).toBe(true);
    }
  });

  it("offers settings at the standard place and shortcut", () => {
    const settings = walk(MAC).find((n) => n.kind === "submenu" && n.label === "Settings");
    expect(settings?.kind).toBe("submenu");
    const all = settings && settings.kind === "submenu" ? settings.items[0] : null;
    expect(all).toMatchObject({ kind: "hash", hash: "#/settings", accelerator: "CmdOrCtrl+," });
  });

  it("quits from one place only on macOS", () => {
    const quits = walk(MAC).filter((n) => n.kind === "role" && n.role === "quit");
    expect(quits).toHaveLength(1);
    // File's last item closes the WINDOW on macOS — the tray keeps the app and
    // its cron schedule alive, so a File > Quit there would be a second, louder
    // quit sitting under Cmd+W's neighbour.
    const file = MAC.find((n) => n.kind === "submenu" && n.label === "File");
    const items = file && file.kind === "submenu" ? file.items : [];
    expect(items[items.length - 1]).toMatchObject({ kind: "role", role: "close" });
    // Off macOS there is no application menu, so File carries the quit instead.
    const fileOff = OTHER.find((n) => n.kind === "submenu" && n.label === "File");
    const offItems = fileOff && fileOff.kind === "submenu" ? fileOff.items : [];
    expect(offItems[offItems.length - 1]).toMatchObject({ kind: "role", role: "quit" });
  });

  it("uses only shell actions the model declares", () => {
    const used = new Set(
      [...leaves(MAC), ...leaves(trayMenuModel({ productName: "spectroscope", status: EMPTY }))].flatMap(
        (n) => (n.kind === "shell" ? [n.action] : []),
      ),
    );
    for (const action of used) expect(SHELL_ACTIONS).toContain(action);
    // And nothing is declared that nothing uses — a dead action is a handler
    // in main.ts nobody can reach.
    expect([...used].sort()).toEqual([...SHELL_ACTIONS].sort());
  });
});

const EMPTY = { port: 51234, serverUp: true, jobs: {} };

describe("the tray menu", () => {
  const tray = trayMenuModel({ productName: "spectroscope", status: EMPTY });

  it("carries nothing the menu bar does not", () => {
    // Menu bar extras can be hidden, so Apple's rule is that nothing may live
    // only in the tray. The one exemption is the row that reopens a closed
    // window: setContextMenu suppresses the tray's own click event, so it is
    // the tray's whole reason to exist. Quit counts as reached — the menu bar
    // has it as role:quit.
    const capability = (n: MenuNode): string | null => {
      if (n.kind === "command") return `command:${n.command}`;
      if (n.kind === "hash") return `hash:${n.hash}`;
      if (n.kind === "url") return `url:${n.url}`;
      if (n.kind === "shell") return n.action === "quit" ? "quit" : `shell:${n.action}`;
      if (n.kind === "role") return n.role === "quit" ? "quit" : `role:${n.role}`;
      return null;
    };
    const inMenuBar = new Set(leaves(MAC).map(capability));
    for (const row of leaves(tray)) {
      const cap = capability(row);
      if (cap === "shell:focusWindow") continue;
      expect(inMenuBar.has(cap)).toBe(true);
    }
  });

  it("stays short enough to read at a glance", () => {
    expect(leaves(tray)).toHaveLength(6);
  });

  it("says in the label when the server is not responding", () => {
    const down = trayMenuModel({
      productName: "spectroscope",
      status: { port: 51234, serverUp: false, jobs: {} },
    });
    const restart = leaves(down).find((n) => n.kind === "shell" && n.action === "restartServer");
    expect(restart && "label" in restart ? restart.label : "").toBe("Restart server… (not responding)");
    // macOS ignores enabled and visible on a top-level tray row, so the state
    // has nowhere to go but the label.
    const up = leaves(tray).find((n) => n.kind === "shell" && n.action === "restartServer");
    expect(up && "label" in up ? up.label : "").toBe("Restart server…");
    expect(trayTooltip("spectroscope", { port: 51234, serverUp: false, jobs: {} })).toContain(
      "not responding",
    );
    expect(trayTooltip("spectroscope", EMPTY)).toContain("127.0.0.1:51234");
  });

  it("counts the cron jobs it has actually seen", () => {
    expect(cronLabel({})).toBe("Cron status");
    expect(cronLabel({ nightly: "ok" })).toBe("Cron · 1 job");
    expect(cronLabel({ a: "ok", b: "ok", c: "running" })).toBe("Cron · 3 jobs, 1 running");
    expect(cronLabel({ a: "running", b: "running" })).toBe("Cron · 2 jobs, 2 running");
    const withJobs = trayMenuModel({
      productName: "spectroscope",
      status: { port: 1, serverUp: true, jobs: { a: "ok", b: "running" } },
    });
    const cron = leaves(withJobs).find((n) => n.kind === "shell" && n.action === "cronStatus");
    expect(cron && "label" in cron ? cron.label : "").toBe("Cron · 2 jobs, 1 running");
  });

  it("rebuilds only when something a reader could see has changed", () => {
    // Mutating a MenuItem's label shows nothing — the whole menu has to be
    // rebuilt. At a 30 s cadence that is free, but only behind this guard.
    const base = { port: 51234, serverUp: true, jobs: { a: "ok" } };
    expect(traySummary(base)).toBe(traySummary({ ...base, jobs: { a: "ok" } }));
    expect(traySummary(base)).not.toBe(traySummary({ ...base, jobs: { a: "running" } }));
    expect(traySummary(base)).not.toBe(traySummary({ ...base, serverUp: false }));
    expect(traySummary(base)).not.toBe(traySummary({ ...base, port: 51235 }));
  });
});
