// The application menu, kept apart from main.ts so its shape can be read
// without booting Electron — by a person, by `node -e`, and by the drift test
// in spectro-web that proves the About wire is still connected at both ends.
//
// The SHAPE itself has moved on to menuModel.ts, which imports nothing at all.
// This file is what is left: the translation from that tree into Electron's
// template, one switch over the node kinds. The split exists because this
// module takes a type from `electron`, a package spectro-web does not depend
// on, so a test over there can only read it as text — and text assertions are
// the weakest gate in this repo.

import type { MenuItemConstructorOptions } from "electron";
import { appMenuModel, type MenuNode, type ShellAction } from "./menuModel";
import type { ShellCommandId } from "./shellCommands";

/**
 * The event the page listens for, mirrored from spectro-web's aboutSignal.ts.
 *
 * Duplicated deliberately: these are two projects with two build systems and
 * no shared module, so the string is copied and the copy is gated. The gate
 * lives on the other side (`aboutSignal.test.ts`) because that is the side
 * that runs on every commit.
 */
export const ABOUT_REQUESTED = "spectroscope:about";

/**
 * The script the About menu item runs in the page.
 *
 * The menu item shows the app's OWN About panel rather than the native macOS
 * one. That panel states the dual licence, and its every sentence is pinned to
 * LICENSE and LICENSE-ASSETS.md by a test. A native panel would mean a second
 * copy of the terms, maintained nowhere, and the licence notice is the one
 * piece of copy in this project that may not drift.
 *
 * About keeps its own event rather than joining the command channel: the wire
 * is gate-pinned on the page side and re-cutting it would buy symmetry and
 * nothing else. The consequence is that About alone still races React's mount
 * the way it has since v0.4 — noted, not solved.
 *
 * @return a self-contained expression, safe to hand to executeJavaScript
 */
export function openAboutScript(): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(ABOUT_REQUESTED)}))`;
}

/** The four things a menu item can ask the shell to do. */
export interface Handlers {
  /** Send a command into the page over the command channel. */
  onCommand: (id: ShellCommandId, arg?: string) => void;
  /** Move the window to an address the page's router parses. */
  onHash: (hash: string) => void;
  /** Open an external link in the browser the user already has. */
  onUrl: (url: string) => void;
  /** Run something only the main process can run. */
  onShell: (action: ShellAction) => void;
}

/** What the menu needs from the shell around it. */
export type MenuActions = {
  /** The name to print in the menu, which is not the npm package name. */
  productName: string;
  /** Darwin gets an application menu; everything else gets its items elsewhere. */
  isMac: boolean;
} & Handlers;

/**
 * Compile a menu model into Electron's template.
 *
 * The only interesting decision here is that a `role` node's label is emitted
 * when the model gives one. Electron would otherwise supply a LOCALISED label
 * for the container roles, and a menu bar reading "File · Bearbeiten · View"
 * is worse than one that is uniformly English — which the rest of this menu
 * already is, having no i18n mechanism at all.
 *
 * @param nodes the menu as data
 * @param h what to run for each kind of leaf
 * @return the template, ready for Menu.buildFromTemplate
 */
export function toTemplate(nodes: readonly MenuNode[], h: Handlers): MenuItemConstructorOptions[] {
  return nodes.map((node): MenuItemConstructorOptions => {
    switch (node.kind) {
      case "separator":
        return { type: "separator" };
      case "role":
        // The model carries role names as plain strings so it can stay free of
        // electron; this is the one place that has to say they are roles.
        return {
          role: node.role as MenuItemConstructorOptions["role"],
          ...(node.label === undefined ? {} : { label: node.label }),
        };
      case "command":
        return {
          label: node.label,
          ...(node.accelerator === undefined ? {} : { accelerator: node.accelerator }),
          click: () => h.onCommand(node.command, node.arg),
        };
      case "hash":
        return {
          label: node.label,
          ...(node.accelerator === undefined ? {} : { accelerator: node.accelerator }),
          click: () => h.onHash(node.hash),
        };
      case "url":
        return { label: node.label, click: () => h.onUrl(node.url) };
      case "shell":
        return {
          label: node.label,
          ...(node.accelerator === undefined ? {} : { accelerator: node.accelerator }),
          click: () => h.onShell(node.action),
        };
      case "submenu":
        return {
          label: node.label,
          ...(node.role === undefined
            ? {}
            : { role: node.role as MenuItemConstructorOptions["role"] }),
          submenu: toTemplate(node.items, h),
        };
    }
  });
}

/**
 * Build the application menu.
 *
 * Every label that names the product spells it out instead of taking the
 * default from `app.name`. The default is the package name, "spectro-desktop",
 * which is what "About spectro-desktop" in the menu was showing. The obvious
 * fix — `app.setName("spectroscope")` — also moves `app.getPath("userData")`,
 * and the renderer's localStorage lives under it: the design choice, the
 * language, the disclosure level. Renaming the app would silently reset all of
 * them on the next launch, so the labels are set and the identity is left
 * alone.
 *
 * @param a the product name, the platform, and the four handlers
 * @return the template, ready for Menu.buildFromTemplate
 */
export function appMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  return toTemplate(appMenuModel({ productName: a.productName, isMac: a.isMac }), a);
}
