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
import { readFileSync } from "node:fs";
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

/** The lab writes that `describeTool` draws as the generic card, each with its
 *  reason. `MultiEdit` has no case there (C15 of the card 604 plan: the files
 *  fold handles it itself). `apply_patch` has one: its card is the patch text
 *  as written, and the files its headers name ride on the view's `patch`
 *  (card 605, task 10). */
const DRAWN_GENERIC: Record<string, string> = {
  MultiEdit: "no case",
  apply_patch: "the patch as written",
};

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
      if (name in DRAWN_GENERIC) {
        // The exception keeps its premise in view: once describeTool draws the
        // name with a write shape, this goes red and the exception has to go.
        expect(viewKindOf(name), `${name} is no longer drawn generic`).toBe("generic");
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
    // 5 + 3 + 2 reads, 2 + 3 + 3 writes less MultiEdit and apply_patch, 5 shell
    // verbs on 2026-11-10 (card 605 added the Copilot CLI's view, create, edit,
    // bash, powershell, apply_patch, the IDE export's rg, and Claude Code's
    // Grep and VS Code's run_in_terminal).
    expect(reads).toBeGreaterThanOrEqual(10);
    expect(writes).toBeGreaterThanOrEqual(6);
    expect(shells).toBeGreaterThanOrEqual(5);
  });

  it("apply_patch is drawn generic and still names its files to the fold", () => {
    // The premise of its exception above: the view carries the files.
    const view = describeTool(
      "apply_patch",
      "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch",
      "",
      false,
    );
    expect(view.kind === "generic" ? view.patch : null).toEqual([
      { path: "a.txt", change: "add", movedTo: null },
    ]);
  });
});

/** The kinds the lab has a station for: a file read, a write, an edit, a command. */
const STATION_KINDS = [...READ_KINDS, ...WRITE_KINDS, "command"];

/**
 * The names describeTool draws with a station kind that the lab leaves dark
 * on purpose, each with its reason. A name here must not be in a lab set.
 */
const LAB_LEAVES_OUT: Record<string, string> = {
  // A background wait: its command is the condition it waits for (card 604
  // plan, C15), and the belt draws it as a launch.
  Monitor: "launch",
  // VS Code agent mode names its file `filePath` or searches by `query` and
  // `includePattern`; the lab has no VS Code set, and one means new sets and
  // readers in the map, the footprint and the run view.
  create_file: "vscode",
  replace_string_in_file: "vscode",
  grep_search: "vscode",
  file_search: "vscode",
};

/** Every `case "…":` label of describeTool, read out of its source. */
function caseLabels(): string[] {
  const src = readFileSync(new URL("../components/toolViews.ts", import.meta.url), "utf8");
  const at = src.indexOf("export function describeTool(");
  const end = src.indexOf("\n}", at);
  expect(at, "describeTool is not in toolViews.ts").toBeGreaterThan(-1);
  return [...src.slice(at, end).matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]);
}

describe("every name the tool views draw as disk or shell work has a lab entry (card 605)", () => {
  it("everyStationKindNameIsInALabSetOrLeftOutOnPurpose", () => {
    const lab = new Set([
      ...NATIVE_DISK_READ,
      ...NATIVE_DISK_WRITE,
      ...CC_DISK_READ,
      ...CC_DISK_WRITE,
      ...COPILOT_DISK_READ,
      ...COPILOT_DISK_WRITE,
      ...SHELL_TOOLS,
    ]);
    const labels = caseLabels();
    let checked = 0;
    for (const name of labels) {
      if (!STATION_KINDS.includes(viewKindOf(name))) continue;
      expect(
        lab.has(name) || name in LAB_LEAVES_OUT,
        `describeTool draws ${name} as ${viewKindOf(name)}; the lab has no set for it and no reason to leave it out`,
      ).toBe(true);
      checked++;
    }
    // A floor: 26 names of a station kind among describeTool's labels on 2026-11-10.
    expect(checked).toBeGreaterThanOrEqual(26);

    // The list cannot go stale: each name is a label of a station kind and in no lab set.
    for (const name of Object.keys(LAB_LEAVES_OUT)) {
      expect(labels, `${name} is no longer a label of describeTool`).toContain(name);
      expect(STATION_KINDS, `${name} is no longer drawn with a station kind`).toContain(viewKindOf(name));
      expect(lab.has(name), `${name} is in a lab set and left out at once`).toBe(false);
    }
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
