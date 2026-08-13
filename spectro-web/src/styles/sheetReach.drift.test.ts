// Every stylesheet in this folder is actually loaded. Read off disk.
//
// Found while card 195 was adding one rule to settings.css: that file is
// imported by nothing. app.css lists its siblings one @import per line and
// settings.css is not among them, so every rule unique to it has been shipping
// to no browser — the fleet switches' confirm box, and the whole of card 199's
// allowlist list, added the same day this test was written. The "runs code"
// warning on the permissions page had no colour, because the one rule that
// gives it one lives in a file the bundle never sees.
//
// This is the bus.css lesson in a second shape. There the tokens were phantoms
// and phantomTokens.drift.test.ts now catches that; here the whole SHEET is the
// phantom, and nothing looked wrong in either case: tsc, eslint, prettier and
// vite all pass, the class names in the TSX are perfectly real, and the page
// renders — just flat. A stylesheet is only as attached as its @import.
//
// The rule is deliberately narrow: a file under src/styles must be reachable
// from the style entry point. HOW it is reached does not matter — an @import in
// app.css or in another sheet both count — because a sheet pulled in by its
// neighbour is loaded just as surely as one pulled in at the top.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES = fileURLToPath(new URL(".", import.meta.url));
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** @return every .css file name directly under src/styles */
function sheets(): string[] {
  return readdirSync(STYLES).filter((f) => f.endsWith(".css"));
}

/** @return every file under `dir` and its subfolders that can carry an import */
function importers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...importers(path));
    else if (/\.(css|tsx?)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(path);
  }
  return out;
}

describe("no stylesheet is written and left unloaded", () => {
  it("reaches every sheet under src/styles from the tree that ships", () => {
    // Both spellings count: `@import "./styles/x.css"` from app.css, and a
    // component's own `import "../styles/x.css"`. Either one puts the rules in
    // the bundle, which is the only question being asked.
    const tree = importers(SRC)
      .filter((path) => !path.startsWith(STYLES) || path.endsWith(".css"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const orphans = sheets().filter((name) => {
      // A sheet naming itself does not count as reached — the check has to look
      // for the reference from OUTSIDE, the same rule componentReach uses.
      const own = readFileSync(join(STYLES, name), "utf8");
      const elsewhere = tree.split(own).join("");
      return !elsewhere.includes(name);
    });
    expect(orphans, "stylesheets nothing imports").toEqual([]);
  });
});
