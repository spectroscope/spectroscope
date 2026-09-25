// Card 431, criteria 6, 9 and 10: which folds App runs in slices, how the count
// reaches the sign without rendering the chat, and that a superseded fold's
// state never lands. Read off disk (no DOM in this suite, house rule); the fold
// itself is pinned by behaviour in state/archiveFold.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const surface = stripComments(read("./OpeningSurface.tsx", import.meta.url));

function fn(name: string): string {
  const at = app.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`App declares no ${name}`);
  return app.slice(at, app.indexOf("\n  };\n", at));
}

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every .ts and .tsx file under `dir` that is not a test, walked from the file
 *  system: no git needed, and a file not yet committed is read like any other. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

/** The sliced fold as every open runs it: the open's own ticket, the count to the sign.
 *  Card 435: the session open and the import fold without trace rows
 *  (foldArchiveDeferredSliced), the resume with them (foldArchiveSliced).
 *  Card 430: the resume folds through foldResume, which picks one of the two
 *  by the mode and hands the options on (pinned below). */
const SLICED =
  /const (\w+) = await (?:foldArchiveSliced\(events, |foldArchiveDeferredSliced\(events, |foldResume\(events, mode, )\{\s*isCurrent: \(\) => navNonce\.isCurrent\(ticket\),\s*onProgress: \(done, total\) => openProgress\.report\(ticket, done, total\),?\s*\}\)/;

/** What each open does when the fold hands back null (criterion 10: its state never lands). */
const ON_NULL: Record<string, RegExp> = {
  openSession: /^;\s*if \(folded === null\) return;/,
  resumeSession: /^;\s*if \(folded === null\) return;/,
  // The import also turns a failed fold into null, and lowers its own sign then.
  openImport:
    /^\.catch\(\(e: unknown\) => \{[^}]*reportBrowserError\("import", e\);\s*return null;\s*\}\);\s*if \(folded === null\) \{\s*if \(navNonce\.isCurrent\(ticket\)\) setOpening\(null\);\s*return;\s*\}/,
};

describe("every open that folds a recorded session folds it in slices (criterion 6)", () => {
  for (const name of ["openSession", "resumeSession", "openImport"]) {
    it(`${name} folds in slices, stops when superseded and lowers the sign after`, () => {
      const body = fn(name);
      const m = body.match(SLICED);
      expect(m, name).not.toBeNull();
      expect(body).not.toMatch(/\bfoldArchive(?:Deferred)?\(/);
      const after = body.slice((m?.index ?? 0) + (m?.[0].length ?? 0));
      expect(after).toMatch(ON_NULL[name]);
      const rest = after.replace(ON_NULL[name], "");
      expect(rest.indexOf("setOpening(null);")).toBeGreaterThan(-1);
      expect(rest.slice(0, rest.indexOf("setOpening(null);"))).not.toContain("await");
      expect(rest).not.toContain("await ");
    });
  }

  it("the resume's fold, foldResume, is one of the two sliced folds with the options handed on", () => {
    const work = stripComments(read("../state/modeWork.ts", import.meta.url));
    const body = work.slice(work.indexOf("export async function foldResume"));
    const own = body.slice(0, body.indexOf("\n}\n"));
    expect(own).toContain("return foldArchiveSliced(events, options);");
    expect(own).toContain("await foldArchiveDeferredSliced(events, options);");
    expect(own).not.toMatch(/\bfoldArchive(?:Deferred)?\(/);
  });

  it("openImport raises the sign and closes its dialog before it folds", () => {
    const body = fn("openImport");
    const fold = body.indexOf("await foldArchiveDeferredSliced(");
    const raise = body.indexOf("setOpening({ ticket, sessionId, title: label });");
    expect(raise).toBeGreaterThan(body.indexOf("const ticket = navNonce.issue();"));
    expect(raise).toBeLessThan(fold);
    expect(body.indexOf("setImportOpen(false);")).toBeGreaterThan(-1);
    expect(body.indexOf("setImportOpen(false);")).toBeLessThan(fold);
    expect(body.split("setImportOpen(false);").length - 1).toBe(1);
  });

  it("keeps the one-shot fold for the scenario path alone, whose size scenarioFoldSize.test.ts guards", () => {
    // Comments are blanked first, so prose that names the fold is no caller.
    // Card 435: the scenario's one-shot fold is foldArchiveDeferred (no trace
    // rows); foldArchive, the one-shot fold with rows, has no caller left.
    // A definition is not a call.
    const callers = sourceFiles(SRC).flatMap((file) =>
      stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .map((line, i) => `${relative(SRC, file)}:${i + 1}:${line}`)
        .filter((line) => /(?<!function )\bfoldArchive(?:Deferred)?\(/.test(line)),
    );
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatch(/^App\.tsx:\d+:\s+const folded = foldArchiveDeferred\(events\);$/);
    expect(fn("openScenario")).toContain("const folded = foldArchiveDeferred(events);");
  });
});

describe("the count reaches the sign and nothing else (criterion 9)", () => {
  it("the surface listens to the progress store", () => {
    expect(surface).toMatch(/useSyncExternalStore\(progress\.subscribe, progress\.read, progress\.read\)/);
  });

  it("App hands the store to the surface and never listens to it", () => {
    // One slot since card 435: the open's store while an open's sign shows.
    expect(app).toMatch(
      /<OpeningSurface\s+lang=\{lang\}\s+opening=\{sign\}\s+progress=\{opening !== null \? openProgress : traceProgress\}\s*\/>/,
    );
    expect(app).not.toMatch(/useSyncExternalStore\(\s*openProgress/);
    expect(app).not.toMatch(/openProgress\.subscribe/);
    // Every use of the store in App is a report or the prop above.
    const uses = [...app.matchAll(/openProgress\.?(\w*)/g)].map((m) => m[1]);
    expect(new Set(uses)).toEqual(new Set(["", "report"]));
  });
});
