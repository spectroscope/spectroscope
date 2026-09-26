// Card 445, review finding 1: a rename field the operator leaves untouched
// sends nothing, even when a suggested title lands on the row while the field
// is open. The list notes what the field opened with when Rename is picked and
// compares the typed text with that note, never with the row as it is when the
// field closes. No DOM in this suite (house rule), so the wiring is read off
// disk, the idiom of openingWiring.drift.test.ts; the pure halves are pinned in
// rowMenuItems.test.ts and sessionRowMenuMarkup.test.tsx.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const sidebar = stripComments(read("./Sidebar.tsx", import.meta.url));

/** The body of `const name = ...` in Sidebar, up to its closing `};` line. */
function fn(name: string): string {
  const at = sidebar.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`Sidebar declares no ${name}`);
  return sidebar.slice(at, sidebar.indexOf("\n  };\n", at));
}

describe("the rename field is measured against what it opened with", () => {
  it("keeps that note as state from the moment Rename is picked", () => {
    expect(sidebar).toMatch(/const \[renaming, setRenaming\] = useState<RenameOpening \| null>\(null\);/);
    expect(fn("pickFromMenu")).toContain("setRenaming(renameOpening(row, lang));");
  });

  it("compares the typed text with the note, not with the row at close", () => {
    const finish = fn("finishRename");
    expect(finish).toContain("renameRequest({ typed, shown: opened.shown, hasTitle: opened.hasTitle })");
    expect(finish).not.toContain("sessionDisplayTitle(");
    expect(finish).not.toContain("renameOpening(");
  });

  it("opens the field on the row being renamed with the text of the note", () => {
    expect(sidebar).toMatch(
      /renameFrom=\{renaming !== null && renaming\.id === s\.id \? renaming\.shown : undefined\}/,
    );
    expect(sidebar).toMatch(
      /onRename=\{\(typed, by\) => \{\s*if \(renaming !== null\) finishRename\(s, renaming, typed, by\);\s*\}\}/,
    );
  });
});
