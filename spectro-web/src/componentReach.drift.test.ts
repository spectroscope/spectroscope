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
import { read } from "./testkit/source";

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

// A component can be mounted and still be handed nothing. The reducer patched
// what the tool RETURNED onto the card (card 167), describeTool read it, both
// renderers drew it — and the two call sites in between passed four arguments
// and dropped the fifth, so 43,204 records reached a card that never asked. The
// same class of hole as an unmounted component, one level down: the prop.
//
// There is no DOM in this suite, so this reads the seam off disk, the way
// about.drift.test.ts reads the shell module: the assertion is that the argument
// is THERE, and export/toolDetail.test.ts proves what comes out the other end.
describe("what the tool returned reaches the card that draws it", () => {
  const card = read("./components/ToolCard.tsx", import.meta.url);
  const bodyView = read("./components/ToolViewBody.tsx", import.meta.url);
  const html = read("./export/html.ts", import.meta.url);

  it("hands the card's detail down to the body", () => {
    expect(element(card, "ToolViewBody")).toContain("detail=");
  });

  it("hands the card's file outcome down too (card 269)", () => {
    // The same hole one card later: the reducer patches the word onto the card,
    // describeTool reads it, both renderers draw it — and a mount that passes
    // every prop but this one leaves the operator reading "Wrote" while the
    // model is being told the file never moved.
    expect(element(card, "ToolViewBody")).toContain("fileChange=");
  });

  it("hands the run's own state file down as well (card 322)", () => {
    // The third of exactly this class. The importer resolves which state file
    // belongs to which launch, the reducer patches it on, describeTool reads
    // the script out of it and the body draws it — and a mount that passes
    // every prop but this one leaves the reader looking at an empty SCRIPT
    // region over a run whose file holds the whole program.
    expect(element(card, "ToolViewBody")).toContain("runState=");
  });

  it("hands it on to describeTool, which has taken it all along", () => {
    // Read to the MATCHING paren, not to the first one: the call outgrew a
    // single line when card 269 gave it a sixth argument, and the old slice
    // (`indexOf("describeTool(props.")`) then found nothing and asserted
    // against the empty string — a guard that fails loudly is the good case,
    // but a slice that silently reads "" is the bad one, so the premise is
    // replaced rather than loosened.
    const call = argsOf(bodyView, "describeTool(");
    expect(call).toContain("props.detail");
    expect(call).toContain("props.fileChange");
    expect(call).toContain("props.runState");
  });

  it("hands it to the export too, so a saved file says what the screen says", () => {
    const call = argsOf(html, "const view = describeTool(");
    expect(call).toContain("card.detail");
    expect(call).toContain("card.fileChange");
    expect(call).toContain("card.runState");
  });
});

/**
 * The argument list of the first real call to `open` in `src`, however it wraps.
 *
 * Empty lists are skipped, because the module's own header names the function in
 * prose as `describeTool()` — and a scan that stopped there would assert against
 * an empty string and pass whatever the call site actually does.
 *
 * @param src  the module's source text
 * @param open the call's opening text, up to and including its "("
 * @return everything between that paren and the one that closes it
 */
function argsOf(src: string, open: string): string {
  for (let at = src.indexOf(open); at >= 0; at = src.indexOf(open, at + 1)) {
    let depth = 0;
    for (let i = at + open.length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        const args = src.slice(at + open.length, i);
        if (args.trim() !== "") return args;
        break;
      }
    }
  }
  throw new Error(`no call to ${open} with arguments in this module`);
}

describe("the fleet roster is mounted where its own comment says it belongs", () => {
  const view = read("./spectrum/SpectrumView.tsx", import.meta.url);
  const app = read("./App.tsx", import.meta.url);

  it("mounts it once, above the Spectrum lanes", () => {
    expect(mounts(view, "FleetRoster")).toBe(1);
  });

  it("is handed the roster the entered fleet folded, so capabilities reach a screen", () => {
    expect(element(app, "SpectrumView")).toContain("fleet=");
    expect(element(view, "FleetRoster")).toContain("roster=");
    expect(element(view, "FleetRoster")).toContain("epochBySender=");
  });
});
