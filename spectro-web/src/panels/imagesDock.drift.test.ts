// Card 443, criterion 2: the old images area is gone, read off disk.
//
// The gallery used to be a column of its own beside the dock, mounted from
// App.tsx and fed by an `imagesOpen` state there. After the card the only
// mount of ImagePanel is the dock's images panel, and the header toggle and
// the View menu's Images row reach the images through the dock's store.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../testkit/source";
import { menuRows } from "./headerPanelControls";

const SRC = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (full: string): string => path.relative(SRC, full).split(path.sep).join("/");
const app = stripComments(readFileSync(path.join(SRC, "App.tsx"), "utf8"));
const menu = stripComments(readFileSync(path.join(SRC, "panels", "headerPanelControls.tsx"), "utf8"));
/** Every source file, read once for both walks below. */
const SOURCES: readonly { rel: string; text: string }[] = sourceFiles(SRC).map((f) => ({
  rel: rel(f),
  text: readFileSync(f, "utf8"),
}));

describe("no images area outside the dock (card 443, criterion 2)", () => {
  it("ImagePanel is mounted exactly once, inside the dock", () => {
    const mounts = SOURCES.flatMap(({ rel: file, text }) => {
      if (!text.includes("<ImagePanel")) return [];
      const n = stripComments(text).split("<ImagePanel").length - 1;
      return Array.from({ length: n }, () => file);
    });
    expect(mounts).toEqual(["components/RightPanel.tsx"]);
  });

  it("no source renders the old area's aside", () => {
    const offenders = SOURCES.filter(({ text }) => /className="image-panel"/.test(text)).map(
      ({ rel: file }) => file,
    );
    expect(offenders).toEqual([]);
    // The dock's images body is there instead.
    expect(readFileSync(path.join(SRC, "components", "ImagePanel.tsx"), "utf8")).toContain(
      'className="image-dock"',
    );
  });

  it("App keeps no images state and no resize handler of its own", () => {
    expect(app).not.toMatch(/useState[^;]*\/\/ gallery panel/);
    expect(app).not.toMatch(/\bsetImagesOpen\b/);
    expect(app).not.toMatch(/\bresizeImages\b/);
    // Card 442: the header has no images button of its own any more; the
    // images row of its menu is checked off the dock's store like every panel.
    expect(app).not.toMatch(/imagesOpen=/);
    expect(menu).toContain("dockModes(layout)");
    expect(menu).not.toMatch(/imagesOpen/);
  });

  it("the header menu's Images row and the View menu's Images row both go through the dock", () => {
    // Card 442: the header menu presses a panel row through pressDockPanel,
    // and images is a panel row there, not a case of its own.
    expect(menuRows({ showDock: true, workOffered: false })).toContainEqual({ id: "images", kind: "panel" });
    expect(menu).toMatch(/row\.kind === "panel"\) pressDockPanel\(row\.id\)/);
    expect(app).toMatch(/toggleImages:\s*toggleImagesPanel/);
  });

  it("a newly arrived picture reveals the dock panel", () => {
    expect(app).toMatch(/imageCount > before\) revealImagesPanel\(\)/);
  });
});
