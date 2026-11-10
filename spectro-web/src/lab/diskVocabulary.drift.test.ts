// Card 604: the lab's disk vocabulary and the tool card's classifier say the
// same thing about every name.
//
// The lab folds tool calls through its own name sets (labScene.ts): a name in a
// read set lights the disk as a read, a name in a write set as a write, a shell
// name goes to the cmd station. The tool card, the trace and the belt read the
// same calls through `describeTool` (components/toolViews.ts). Two
// classifications of one vocabulary drift apart silently: the map would light
// a write for a call the card draws as a file read, and no test would notice.
// This file holds them together, name by name, in both directions of growth: a
// name added to a lab set has to land on a kind of the same direction.
//
// The second half guards the set itself. Before card 604 the run view kept a
// private copy of the native write names next to the lab's imported one, which
// is the shape the shell vocabulary was rid of in card 301.

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { srcFiles, srcText } from "../testkit/tree";
import { viewKindOf } from "./flowmap/belt";
import { describeTool } from "../components/toolViews";
import {
  CC_DISK_READ,
  CC_DISK_WRITE,
  COPILOT_DISK_READ,
  COPILOT_DISK_WRITE,
  NATIVE_DISK_READ,
  NATIVE_DISK_WRITE,
  SHELL_COMMAND_KEY,
  SHELL_TOOLS,
} from "./labScene";

const READ_KINDS = ["file", "listing", "matches"];
const WRITE_KINDS = ["write", "edit"];

/** `MultiEdit` is routed by the lab and has no case in `describeTool`, so its
 *  kind is the fallback. C15 of the card 604 plan: the files fold handles it
 *  itself. */
const NO_CASE_IN_TOOL_VIEWS = "MultiEdit";

describe("the lab's disk names read as the same kind in the tool views (card 604)", () => {
  it("everyLabDiskNameReadsAsTheSameKindInToolViews", () => {
    let reads = 0;
    for (const name of [...NATIVE_DISK_READ, ...CC_DISK_READ, ...COPILOT_DISK_READ]) {
      expect(READ_KINDS, `${name} is a lab read, describeTool says ${viewKindOf(name)}`).toContain(
        viewKindOf(name),
      );
      reads++;
    }

    let writes = 0;
    for (const name of [...NATIVE_DISK_WRITE, ...CC_DISK_WRITE, ...COPILOT_DISK_WRITE]) {
      if (name === NO_CASE_IN_TOOL_VIEWS) {
        // The exception keeps its premise in view: once describeTool learns
        // the name, this goes red and the exception has to go.
        expect(viewKindOf(name), `${name} now has a case in describeTool`).toBe("generic");
        continue;
      }
      expect(WRITE_KINDS, `${name} is a lab write, describeTool says ${viewKindOf(name)}`).toContain(
        viewKindOf(name),
      );
      writes++;
    }

    let shells = 0;
    for (const name of SHELL_TOOLS) {
      expect(viewKindOf(name), `${name} is a lab shell verb`).toBe("command");
      // The lab reads the command out of SHELL_COMMAND_KEY; the card has to find it there too.
      const call = describeTool(name, { [SHELL_COMMAND_KEY]: "ls" }, undefined, false);
      expect(call.kind === "command" ? call.command : null, `${name} carries its command elsewhere`).toBe(
        "ls",
      );
      shells++;
    }

    // Floors, so an emptied set cannot turn the loops into a scan over nothing:
    // 5 + 2 + 1 reads, 2 + 3 + 2 writes less MultiEdit, 4 shell verbs on
    // 2026-11-10 (card 605 added the Copilot CLI's view, create, edit, bash, powershell).
    expect(reads).toBeGreaterThanOrEqual(8);
    expect(writes).toBeGreaterThanOrEqual(6);
    expect(shells).toBeGreaterThanOrEqual(4);
  });
});

/** src/, absolute. */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const HOME = "lab/labScene.ts";

/** Every `new Set([...])` literal in a text, the generic form included. */
const setLiterals = (text: string): string[] =>
  [...text.matchAll(/new Set(?:<[^>]*>)?\(\s*\[([^\]]*)\]/g)].map((m) => m[1]);

const isWriteSet = (literal: string): boolean =>
  literal.includes('"write_file"') && literal.includes('"edit_file"');

describe("the native write set is declared once (card 604)", () => {
  it("noSecondCopyOfTheWriteSet", () => {
    const code = srcFiles()
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => [relative(SRC, file), srcText(file)] as const);

    const copies = code
      .filter(([path]) => path !== HOME)
      .filter(([, text]) => setLiterals(text).some(isWriteSet))
      .map(([path]) => path);
    expect(copies, "a second Set literal of the native write names").toEqual([]);

    // The premise: the one declaration is there and is found by this search.
    // Without it the check above is green over a search that matches nothing.
    const home = code.find(([path]) => path === HOME);
    expect(home, `${HOME} is not in the walk`).toBeDefined();
    expect(setLiterals(home![1]).filter(isWriteSet), `${HOME} declares the write set`).toHaveLength(1);
  });
});
