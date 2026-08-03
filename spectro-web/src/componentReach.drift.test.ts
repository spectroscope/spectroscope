// Every component this tree builds is attached to something. Read off disk.
//
// FleetRoster was finished work with zero callers: exported, styled in
// fleet.css, translated into both languages, and mounted nowhere. It is the only
// reader of a node's advertised capabilities, so every hub node's tool list was
// folded off the wire on every roster frame and reached no screen at all. It
// survived because nothing in the gate ever asked the question.
//
// This asks it for all of them at once, so the next component built and left
// unattached fails here instead of shipping as weight nobody can see.
//
// The rule is deliberately generous about HOW a component is reached: React Flow
// takes its node types through a map rather than through JSX, so a name that
// another module merely mentions counts as reached. What does not count is a
// name that appears only in the file that defines it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** @return every file under `dir`, recursively */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** The shipped tree: source only, so a test mounting something proves nothing. */
const sources = new Map<string, string>(
  walk(SRC)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .map((f) => [f.slice(SRC.length), readFileSync(f, "utf8")]),
);

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

/** @return the JSX element `<Name ... />` as text, from its first mount */
function element(src: string, name: string): string {
  const from = src.indexOf(`<${name}`);
  if (from < 0) return "";
  return src.slice(from, src.indexOf("/>", from));
}

describe("no component is built and left unattached", () => {
  it("mounts or imports every component the tree exports", () => {
    const orphans: string[] = [];
    let counted = 0;
    for (const [file, text] of sources) {
      if (!file.endsWith(".tsx")) continue;
      for (const match of text.matchAll(/^export (?:default )?function ([A-Z][a-z]\w*)/gm)) {
        const name = match[1];
        counted++;
        let reached = false;
        for (const [other, otherText] of sources) {
          if (otherText.includes(`<${name}`)) reached = true;
          if (other !== file && new RegExp(`\\b${name}\\b`).test(otherText)) reached = true;
        }
        if (!reached) orphans.push(`${file}: ${name}`);
      }
    }
    // The count is a witness that the scan actually found components: a regex
    // that quietly stopped matching would otherwise report a clean tree.
    expect(counted).toBeGreaterThan(80);
    expect(orphans).toEqual([]);
  });
});

describe("the fleet roster is mounted where its own comment says it belongs", () => {
  const view = read("./spectrum/SpectrumView.tsx");
  const app = read("./App.tsx");

  it("mounts it once, above the Spectrum lanes", () => {
    expect(mounts(view, "FleetRoster")).toBe(1);
  });

  it("is handed the roster the entered fleet folded, so capabilities reach a screen", () => {
    expect(element(app, "SpectrumView")).toContain("fleet=");
    expect(element(view, "FleetRoster")).toContain("roster=");
    expect(element(view, "FleetRoster")).toContain("epochBySender=");
  });
});
