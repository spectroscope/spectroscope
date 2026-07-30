// The application menu, kept apart from main.ts so its shape can be read
// without booting Electron — by a person, by `node -e`, and by the drift test
// in spectro-web that proves the About wire is still connected at both ends.

import type { MenuItemConstructorOptions } from "electron";

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
 * @return a self-contained expression, safe to hand to executeJavaScript
 */
export function openAboutScript(): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(ABOUT_REQUESTED)}))`;
}

/** What the menu needs from the shell around it. */
export type MenuActions = {
  /** The name to print in the menu, which is not the npm package name. */
  productName: string;
  /** Darwin gets an application menu; everything else gets a Help menu. */
  isMac: boolean;
  onAbout: () => void;
  onNewChat: () => void;
};

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
 * @param a the product name and the two things the menu can do
 * @return the template, ready for Menu.buildFromTemplate
 */
export function appMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  const about: MenuItemConstructorOptions = {
    label: `About ${a.productName}`,
    click: a.onAbout,
  };

  return [
    ...(a.isMac
      ? [
          {
            label: a.productName,
            submenu: [
              about,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const, label: `Hide ${a.productName}` },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const, label: `Quit ${a.productName}` },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New chat", accelerator: "CmdOrCtrl+N", click: a.onNewChat },
        { role: "quit", label: `Quit ${a.productName}` },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    // Windows and Linux have no application menu, and About belongs in Help
    // there. Without this the entry would exist on one platform out of three.
    ...(a.isMac ? [] : [{ label: "Help", submenu: [about] }]),
  ];
}
