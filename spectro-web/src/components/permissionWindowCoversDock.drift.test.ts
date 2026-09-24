// Merge seam of 2026-09-24, cards 219 and 382: the permission window covers
// the browser dock.
//
// Card 382 turned the permission ask into a window over the whole page, a
// modal backdrop the owner ordered to be impossible to miss. Card 219's
// `dockCovered` is the list of modals the dock's native browser pane has to
// hide for, because no dialog can paint over a native view. The window was not
// on that list, so an open dock could draw the page over the ask.
//
// The term is read from the window's own render guard in App.tsx, not typed
// here, the rule card 387 set for the leveling drawer: a term that differs
// from the guard either hides the pane while no window is drawn or leaves it up
// while one is.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url)).split("\n");
const source = app.join("\n");

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Every line of App.tsx that contains `needle`, by index. */
const sitesOf = (needle: string): number[] =>
  app.map((line, index) => (line.includes(needle) ? index : -1)).filter((index) => index >= 0);

/**
 * The JSX condition the line at `at` sits directly inside: the nearest line
 * above it that opens a conditional (`… && (` or `… ? (`) and is indented less.
 * The same walk as `guardsAround` in levelingModeList.drift.test.ts, first hit
 * only, with the opener's `{` and trailing `&& (` taken off.
 */
function guardOf(at: number): string | null {
  for (let above = at - 1; above >= 0; above--) {
    const line = app[above];
    if (!/(?:&&|\?)\s*\($/.test(line.trim())) continue;
    if (indentOf(line) >= indentOf(app[at])) continue;
    return flat(
      line
        .trim()
        .replace(/^\{/, "")
        .replace(/&&\s*\($/, ""),
    );
  }
  return null;
}

/** The `||` terms of `dockCovered`, outer parentheses dropped, as card 387 reads them. */
function dockCoveredTerms(): string[] {
  const start = source.indexOf("const dockCovered");
  expect(start, "dockCovered is gone").toBeGreaterThan(-1);
  const decl = source.slice(source.indexOf("=", start) + 1, source.indexOf(";", start));
  return decl.split("||").map((term) => flat(term).replace(/^\((.*)\)$/, "$1"));
}

describe("the permission window and the browser dock", () => {
  it("mounts the window once, under a guard that names the window surface and the head", () => {
    const sites = sitesOf("<PermissionDialog");
    expect(sites.length, "App.tsx should mount the permission window exactly once").toBe(1);
    const guard = guardOf(sites[0]);
    expect(guard, "the window lost its render guard").not.toBeNull();
    expect(guard).toContain('gateShown === "window"');
    expect(guard).toContain("gateHead !== null");
  });

  it("covers the dock with the window's own render guard, term for term", () => {
    const guard = guardOf(sitesOf("<PermissionDialog")[0]);
    expect(dockCoveredTerms()).toContain(guard);
  });

  it("reads the terms it compares against, not an empty list", () => {
    // Positive control for the reader: the modals card 219 listed are there.
    const terms = dockCoveredTerms();
    expect(terms).toContain("settingsOpen");
    expect(terms).toContain("spawnDialogOpen");
  });

  it("hands dockCovered to the dock, so the term reaches the native pane", () => {
    expect(sitesOf("covered={dockCovered}").length).toBe(1);
  });
});
