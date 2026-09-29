// Card 402, criterion 7: every place under src that can open the dock, listed.
//
// The dock shows while the layout store's rightPanelOpen is true, and a panel
// shows in it while its mode is not "closed". Only the store's own exported
// functions write either field. The first test finds which of them can open
// something by running them: every exported function except the hooks (use*)
// and the test helpers (__*) is called on a freshly loaded store whose dock is
// hidden with every panel closed, once with the return memory off and once
// with it on, with no argument, with true and with each panel id. A function
// is an opener when one of those calls made the dock visible or took a closed
// panel out of "closed". Unfolding a collapsed panel is not counted: that
// panel was already showing.
//
// The second test walks every non-test .ts and .tsx file under src and lists
// each call to an opener and each place that hands one on by name
// (onClose={toggleRightPanel}), with the file and the enclosing hook or
// function. Imports under another name are followed. A new opener in the store,
// a new call or a new reference turns one of the two red and has to be added
// here on purpose. The walk does not see an opener reached through a computed
// key or a spread of the module.

import path from "node:path";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { srcFiles, srcText } from "../testkit/tree";
import { DOCK_ORDER } from "./dockModel";
import { DEFAULT_LAYOUT } from "../state/layout";

const SRC = path.join(__dirname, "..");
const LAYOUT_KEY = "spectroscope:layout";

type LayoutModule = typeof import("../state/layout");

/** The layout fields that hold a panel's mode, read from the store's default. */
const PANEL_FIELDS = Object.entries(DEFAULT_LAYOUT)
  .filter(([, value]) => value === "open" || value === "collapsed" || value === "closed")
  .map(([field]) => field);

/** A freshly loaded store: dock hidden, every panel closed, the return memory as given. */
async function freshStore(dockReturn: boolean): Promise<LayoutModule> {
  const closed = Object.fromEntries(PANEL_FIELDS.map((field) => [field, "closed"]));
  const blob = JSON.stringify({ ...closed, dockColumns: "", dockReturn });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === LAYOUT_KEY ? blob : null),
    setItem: () => undefined,
  });
  vi.resetModules();
  return import("../state/layout");
}

/** The fields of a layout that name a panel mode and hold "closed". */
function closedPanels(state: object): string[] {
  return Object.entries(state)
    .filter(([, value]) => value === "closed")
    .map(([field]) => field);
}

/** Every exported function of the store that opened the dock or a panel on one of the probe calls. */
async function probeOpeners(): Promise<string[]> {
  const shape = await freshStore(false);
  const names = Object.entries(shape)
    .filter(
      ([name, value]) => typeof value === "function" && !/^use[A-Z]/.test(name) && !name.startsWith("__"),
    )
    .map(([name]) => name);
  const argLists: unknown[][] = [[], [true], ...DOCK_ORDER.map((id) => [id])];
  // Card 444: setDockTabs(true, id) opens `id` when tabs turn on. A verb that
  // declares two parameters is also called with (true, id); the one-parameter
  // verbs are not, which keeps the probe's module reloads where they were.
  const twoArgLists: unknown[][] = DOCK_ORDER.map((id) => [true, id]);
  const openers = new Set<string>();
  for (const dockReturn of [false, true]) {
    for (const name of names) {
      const fn = shape[name as keyof LayoutModule] as (...a: unknown[]) => unknown;
      for (const args of fn.length >= 2 ? [...argLists, ...twoArgLists] : argLists) {
        const store = await freshStore(dockReturn);
        const before = store.getLayout();
        // The probe starts where it says it does, or it measures nothing.
        expect(before.rightPanelOpen).toBe(false);
        expect(before.dockReturn).toBe(dockReturn);
        expect(closedPanels(before)).toEqual(PANEL_FIELDS);
        try {
          (store[name as keyof LayoutModule] as (...a: unknown[]) => unknown)(...args);
        } catch {
          // A function that rejects the argument opened nothing with it.
        }
        const after = store.getLayout();
        const opened = closedPanels(before).some((field) => closedPanels(after).indexOf(field) < 0);
        if (after.rightPanelOpen || opened) openers.add(name);
      }
    }
  }
  return [...openers].sort();
}

/** Every non-test .ts and .tsx file under src, walked from the file system. */
function sourceFiles(dir: string): string[] {
  return srcFiles(dir).filter((full) => {
    const name = path.basename(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
  });
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** The nearest enclosing name: a hook with its dependencies, a JSX handler, a function or a const. */
function context(node: ts.Node, file: ts.SourceFile): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isCallExpression(at)) {
      const name = calleeName(at);
      if (name === "useEffect" || name === "useLayoutEffect" || name === "useCallback") {
        const deps = at.arguments[1];
        return `${name}${deps !== undefined ? deps.getText(file) : ""}`;
      }
    }
    if (ts.isJsxAttribute(at)) return at.name.getText(file);
    if (ts.isFunctionDeclaration(at) && at.name !== undefined) return at.name.text;
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isPropertyAssignment(at) || ts.isMethodDeclaration(at)) return at.name.getText(file);
  }
  return "(module)";
}

/** An identifier that declares or imports a name rather than using it. */
function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent)) &&
      parent.name === id)
  );
}

/** One line per call or reference: file, enclosing context, opener, and "by reference" when it is not called. */
function openerSites(openers: ReadonlySet<string>): string[] {
  const sites: string[] = [];
  for (const full of sourceFiles(SRC)) {
    const text = srcText(full);
    const kind = full.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true, kind);
    const rel = path.relative(SRC, full).split(path.sep).join("/");
    // A local name for an opener: itself, or what an import renamed it to.
    const local = new Map<string, string>([...openers].map((name) => [name, name]));
    const aliases = (node: ts.Node): void => {
      if (ts.isImportSpecifier(node) && node.propertyName !== undefined) {
        const imported = node.propertyName.getText(file);
        if (openers.has(imported)) local.set(node.name.text, imported);
      }
      ts.forEachChild(node, aliases);
    };
    aliases(file);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && local.has(node.text) && !isDeclarationName(node)) {
        const name = local.get(node.text) as string;
        const used =
          ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        const called = ts.isCallExpression(used.parent) && used.parent.expression === used;
        sites.push(`${rel} ${context(used, file)} ${name}${called ? "" : " by reference"}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites.sort();
}

let OPENERS: ReadonlySet<string> = new Set();

beforeAll(async () => {
  OPENERS = new Set(await probeOpeners());
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the calls that open the dock (card 402)", () => {
  it("the store's openers, found by running every exported function, are these six", () => {
    expect([...OPENERS]).toEqual([
      // Shows the dock when the return memory says open (card 242).
      "applyDockReturn",
      "openDockPanel",
      "openRightPanel",
      // Card 444: turning tabs on keeps one panel open, opening it if needed.
      "setDockTabs",
      // Opens a closed panel and closes an open one.
      "toggleDockPanel",
      // Shows a hidden dock and hides a shown one.
      "toggleRightPanel",
    ]);
  });

  it("are called or handed on exactly here, and a new one has to be added here on purpose", () => {
    expect(openerSites(OPENERS)).toEqual(
      [
        // Automatic: the flip into the v2 chat view, only on an explicit settings change.
        "App.tsx useEffect[chatView] openDockPanel",
        "App.tsx useEffect[chatView] openRightPanel",
        // Automatic: entering a stored session or an import brings back the
        // dock the user left open (card 242).
        "App.tsx openImport applyDockReturn",
        "App.tsx openSession applyDockReturn",
        // Automatic: the agent's own browser_action, at most once per run (card 241).
        "state/browserReveal.ts revealBrowserPanel openDockPanel",
        "state/browserReveal.ts revealBrowserPanel openRightPanel",
        // A click on a work item inside the chat.
        "App.tsx onOpenWork openDockPanel",
        "App.tsx onOpenWork openRightPanel",
        // Handed on by name: the header's dock toggle (onTogglePanel), the
        // resizer beside the dock (onToggle) and the dock's close (onClose).
        "App.tsx onClose toggleRightPanel by reference",
        "App.tsx onToggle toggleRightPanel by reference",
        "App.tsx onTogglePanel toggleRightPanel by reference",
        // A click on an agent row reveals its context panel.
        "components/RightPanel.tsx selectAgent openDockPanel",
        // The dock's own panel strip and each panel's close button.
        "components/RightPanel.tsx onClick toggleDockPanel",
        "components/RightPanel.tsx onClick toggleDockPanel",
        // Card 443: the header's images toggle and View > Images (toggleImagesPanel),
        // and a picture that arrives while the operator watches (revealImagesPanel).
        "state/imagesPanel.ts revealImagesPanel openDockPanel",
        "state/imagesPanel.ts revealImagesPanel openRightPanel",
        "state/imagesPanel.ts toggleImagesPanel openDockPanel",
        "state/imagesPanel.ts toggleImagesPanel openRightPanel",
        "state/imagesPanel.ts toggleImagesPanel toggleDockPanel",
        // The header's panel icons: a closed panel opens with the dock, an open one closes.
        // Card 444 named the press so the tabs test can drive the same door.
        "panels/headerPanelControls.tsx pressDockPanel openDockPanel",
        "panels/headerPanelControls.tsx pressDockPanel openRightPanel",
        "panels/headerPanelControls.tsx pressDockPanel toggleDockPanel",
        // Card 444: the strip in tabs mode selects; the dock's switch keeps one panel.
        "components/RightPanel.tsx onClick openDockPanel",
        "components/RightPanel.tsx onChange setDockTabs",
        "components/RightPanel.tsx onChange setDockTabs",
      ].sort(),
    );
  });

  it("walks the whole tree: the layout store's own definitions are there to be found", () => {
    // The definitions are not calls, so they are not listed above; finding the
    // file proves the walk reaches src/state and parses it.
    const files = sourceFiles(SRC).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(files).toContain("state/layout.ts");
    expect(files).toContain("App.tsx");
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });
});
