// Card 421, review round of 2026-09-25: the App.tsx half of the fix.
//
// storedFolder.test.tsx renders RightPanel with a storedCwd and sees the
// folder. What hands RightPanel that value is App.tsx: it computes the folder
// of the replay on screen with storedCwdOf and passes it on its one RightPanel
// mount. No spectro-web test renders App, so without this file both lines
// could go, in a merge or by hand, with every test green.
//
// This file parses App.tsx. It finds the RightPanel mount, reads the
// identifier its storedCwd prop is given, takes that constant's initializer
// and evaluates it with the real storedCwdOf, a stand-in useMemo that records
// its dependencies, and a replay. Any other name the initializer reads is
// missing from that scope and throws.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { storedCwdOf } from "./storedFolder";

const APP_PATH = path.join(__dirname, "..", "App.tsx");
const APP = readFileSync(APP_PATH, "utf8");
const FILE = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

/** Every node in App.tsx that satisfies the test. */
function collect<T extends ts.Node>(test: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (test(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  return found;
}

/** The opening or self-closing tags of every <RightPanel> element in App.tsx. */
function rightPanelMounts(): (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] {
  return collect(
    (node): node is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(FILE) === "RightPanel",
  );
}

/** The expression text a JSX attribute is given, or null when the mount does not pass it. */
function propExpression(mount: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string | null {
  for (const attr of mount.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText(FILE) === name) {
      const init = attr.initializer;
      if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined) {
        return init.expression.getText(FILE);
      }
      return init === undefined ? "true" : init.getText(FILE);
    }
  }
  return null;
}

/** The initializer text of each `const <name>` in App.tsx. */
function initializersOf(name: string): string[] {
  return collect(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined,
  ).map((decl) => (decl.initializer as ts.Expression).getText(FILE));
}

/** The module each named import of App.tsx comes from, keyed by the local name. */
function importSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const decl of collect(ts.isImportDeclaration)) {
    const bindings = decl.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const from = (decl.moduleSpecifier as ts.StringLiteral).text;
    for (const spec of bindings.elements) {
      sources.set(spec.name.text, `${from}#${(spec.propertyName ?? spec.name).text}`);
    }
  }
  return sources;
}

type Replay = { id: string; events: readonly RunEvent[] } | null;

/**
 * App's expression for the value the mount hands on, as a function of the
 * replay. The stand-in useMemo runs its callback at once and keeps the
 * dependency list it was given.
 */
function appStoredCwd(expression: string): (replay: Replay) => { value: unknown; deps: unknown[] | null } {
  const js = ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React });
  return (replay) => {
    let deps: unknown[] | null = null;
    const useMemo = (fn: () => unknown, given: unknown[]): unknown => {
      deps = given;
      return fn();
    };
    const value = new Function("useMemo", "storedCwdOf", "replay", `return ${js}`)(
      useMemo,
      storedCwdOf,
      replay,
    );
    return { value, deps };
  };
}

const runStart = (workspace: string): RunEvent =>
  ({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "hi",
    workspace,
    ts: 1,
  }) as unknown as RunEvent;

describe("App.tsx hands a stored session's folder to the dock", () => {
  it("mounts RightPanel exactly once", () => {
    expect(rightPanelMounts()).toHaveLength(1);
  });

  it("imports storedCwdOf from the workspace module, under its own name", () => {
    expect(importSources().get("storedCwdOf")).toBe("./workspace/storedFolder#storedCwdOf");
  });

  it("passes storedCwd on that mount, as a constant App declares once", () => {
    const [mount] = rightPanelMounts();
    const given = propExpression(mount, "storedCwd");
    expect(given).not.toBeNull();
    expect(given).toMatch(/^[A-Za-z_$][\w$]*$/);
    expect(initializersOf(given as string)).toHaveLength(1);
  });

  it("gives it the folder the replay on screen recorded, recomputed when the replay changes", () => {
    const [mount] = rightPanelMounts();
    const [expression] = initializersOf(propExpression(mount, "storedCwd") as string);
    const compute = appStoredCwd(expression);

    const first: Replay = { id: "20260925-101500-abcd", events: [runStart("/work/ran-here")] };
    const second: Replay = { id: "20260925-111500-bcde", events: [runStart("/work/other")] };
    expect(compute(first).value).toBe("/work/ran-here");
    expect(compute(second).value).toBe("/work/other");
    // A memo that does not list the replay would keep the first folder.
    const deps = compute(first).deps;
    if (deps !== null) expect(deps).toContain(first);
  });

  it("gives it nothing for the live view and for an import", () => {
    const [mount] = rightPanelMounts();
    const [expression] = initializersOf(propExpression(mount, "storedCwd") as string);
    const compute = appStoredCwd(expression);
    expect(compute(null).value).toBeNull();
    expect(compute({ id: "import:claude:x.jsonl", events: [runStart("/work/elsewhere")] }).value).toBeNull();
  });
});
