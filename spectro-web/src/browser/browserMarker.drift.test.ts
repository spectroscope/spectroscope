// The desktop marker exists twice, so it is pinned twice.
//
// The shell stamps a string on its own window's user agent; the page reads that
// string to know whether the native pane can be over it at all. Two projects,
// two build systems, no shared module — the same situation shellCommands.ts and
// aboutSignal.ts are in, and the same answer: duplicate deliberately, then let
// a test refuse the drift.
//
// What a drift costs: the shell keeps stamping, the page stops recognising, and
// the browser segment tells the operator he has no browser while the pane is
// sitting right there in his window. Silent in every other check.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_MARKER, isDesktopShell } from "./viewport";

const main = readFileSync(
  path.join(__dirname, "..", "..", "..", "spectro-desktop", "src", "main.ts"),
  "utf8",
);

describe("the desktop marker", () => {
  it("is the same string in the shell as in the page", () => {
    expect(main).toContain(`const DESKTOP_MARKER = "${DESKTOP_MARKER}"`);
  });

  it("is actually stamped onto the app window, not merely declared", () => {
    // A constant nobody applies would pass the equality check above and still
    // leave every window unmarked.
    expect(main).toMatch(/setUserAgent\(`\$\{w\.webContents\.getUserAgent\(\)\} \$\{DESKTOP_MARKER\}/);
  });

  it("is stamped before the window loads its URL", () => {
    // setUserAgent after loadURL would leave the first load — the only load a
    // reader ever sees — carrying the unmarked agent.
    expect(main.indexOf("setUserAgent(")).toBeLessThan(main.indexOf("void w.loadURL(home"));
    expect(main.indexOf("setUserAgent(")).toBeGreaterThan(-1);
  });

  it("recognises the agent the shell actually produces", () => {
    const produced = `Mozilla/5.0 (Macintosh) Chrome/150 Electron/43.3.0 Safari/537.36 ${DESKTOP_MARKER}0.8.0`;
    expect(isDesktopShell(produced)).toBe(true);
  });
});
