// Card 586, task 9: App's side of a press in the run view. No test renders App,
// so this file parses App.tsx, takes its two handlers out of it and runs them
// with stand-ins for what they reach (the pattern of
// playbookAppWiring.drift.test.ts).
//
// What is pinned:
// - a press on an entry brings the chat back and asks it for the entry's
//   place: a child step's helper thread, else the chat step's prompt;
// - a press on a path opens the Files panel on it; a path under a dot folder
//   goes through the run's document route, any other through /api/file;
// - the compact panel and the wide view are handed the same two handlers.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { RunEntry, RunTrack } from "../state/runView";
import { runDocumentUrl } from "../workspace/preview";

const APP = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const FILE = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

function collect<T extends ts.Node>(test: (node: ts.Node) => node is T, root: ts.Node = FILE): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (test(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Runs App's own arrow for `const name` with the given names in scope. */
function appArrow<T>(name: string, scope: Record<string, unknown>): T {
  const decls = collect(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(decls, `const ${name} in App`).toHaveLength(1);
  const init = decls[0].initializer;
  if (init === undefined || !ts.isArrowFunction(init)) throw new Error(`${name} is not an arrow function`);
  const js = ts.transpile(`(${init.getText(FILE)})`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(scope), `"use strict"; return ${js}`)(...Object.values(scope)) as T;
}

/** The JSX attribute `name` on every `<tag>` in App, as source text. */
function attributes(tag: string, name: string): string[] {
  return collect(
    (node): node is ts.JsxAttribute =>
      ts.isJsxAttribute(node) &&
      node.name.getText(FILE) === name &&
      (ts.isJsxOpeningElement(node.parent.parent) || ts.isJsxSelfClosingElement(node.parent.parent)) &&
      node.parent.parent.tagName.getText(FILE) === tag,
  ).map((attr) => attr.initializer?.getText(FILE) ?? "");
}

const entry = (fields: Partial<RunEntry>): RunEntry =>
  ({ key: "abcdefabcdef:brainstorm:1", performer: "chat", agents: ["main"], ...fields }) as RunEntry;
const RUN = { runId: "abcdefabcdef" } as RunTrack;

describe("a press on a run's entry (card 586)", () => {
  function jump(e: RunEntry) {
    const calls: unknown[][] = [];
    const onJump = appArrow<(e: RunEntry) => void>("onJumpToRunEntry", {
      setRunWide: (on: boolean) => calls.push(["setRunWide", on]),
      requestChatFocus: (target: unknown) => calls.push(["requestChatFocus", target]),
    });
    onJump(e);
    return calls;
  }

  it("brings the chat back and asks for a chat step's prompt", () => {
    expect(jump(entry({}))).toEqual([
      ["setRunWide", false],
      ["requestChatFocus", { kind: "entry", key: "abcdefabcdef:brainstorm:1" }],
    ]);
  });

  it("asks for the helper's thread of a child step", () => {
    expect(jump(entry({ performer: "child", agents: ["worker-1", "worker-2"] }))[1]).toEqual([
      "requestChatFocus",
      { kind: "agent", agentId: "worker-1" },
    ]);
  });

  it("asks for the entry of a child step whose helper is not known yet", () => {
    expect(jump(entry({ performer: "child", agents: [] }))[1]).toEqual([
      "requestChatFocus",
      { kind: "entry", key: "abcdefabcdef:brainstorm:1" },
    ]);
  });
});

describe("a press on a run's path (card 586)", () => {
  function open(p: string, sessionId: string | null) {
    const calls: unknown[][] = [];
    const onOpen = appArrow<(run: RunTrack, p: string) => void>("onOpenRunPath", {
      filesWorkspace: sessionId === null ? null : { sessionId },
      setRunWide: (on: boolean) => calls.push(["setRunWide", on]),
      requestOpenFile: (...args: unknown[]) => calls.push(["requestOpenFile", ...args]),
      runDocumentUrl,
      openRightPanel: (...args: unknown[]) => calls.push(["openRightPanel", ...args]),
      openDockPanel: (...args: unknown[]) => calls.push(["openDockPanel", ...args]),
    });
    onOpen(RUN, p);
    return calls;
  }

  // Final fix round (review I2): wide hides the dock, so the press turns wide
  // off first, as a press on a card does. The request names the session whose
  // Files panel opens it.
  it("turns wide off, opens a dot-folder document through the run's document route, then the Files panel", () => {
    expect(open(".superpowers/specs/plan.md", "s-1")).toEqual([
      ["setRunWide", false],
      [
        "requestOpenFile",
        ".superpowers/specs/plan.md",
        runDocumentUrl("s-1", "abcdefabcdef", ".superpowers/specs/plan.md"),
        "s-1",
      ],
      ["openRightPanel"],
      ["openDockPanel", "files"],
    ]);
  });

  it("opens any other path through /api/file", () => {
    expect(open("docs/plan.md", "s-1")[1]).toEqual(["requestOpenFile", "docs/plan.md", undefined, "s-1"]);
  });

  it("opens a dot-folder path through /api/file when the panel has no session", () => {
    expect(open(".superpowers/plan.md", null)[1]).toEqual([
      "requestOpenFile",
      ".superpowers/plan.md",
      undefined,
      null,
    ]);
  });
});

describe("the panel and the wide view get the same handlers (card 586)", () => {
  it("the dock's run panel", () => {
    expect(attributes("RightPanel", "onJumpToRunEntry")).toEqual(["{onJumpToRunEntry}"]);
    expect(attributes("RightPanel", "onOpenRunPath")).toEqual(["{onOpenRunPath}"]);
  });

  it("the wide view", () => {
    expect(attributes("RunWideView", "onJump")).toEqual(["{onJumpToRunEntry}"]);
    expect(attributes("RunWideView", "onOpenPath")).toEqual(["{onOpenRunPath}"]);
  });

  it("the Files panel shows the folder the document opens from", () => {
    expect(attributes("RightPanel", "workspace")).toEqual(["{filesWorkspace}"]);
  });
});
