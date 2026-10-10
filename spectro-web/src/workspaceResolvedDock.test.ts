// Card 402: a resolved workspace opens no panel.
//
// The owner, 2026-09-24: sending the first message in a new workspace threw the
// right dock open on Agents and Files, and "das Panel soll nicht aufgehen". The
// opener was an effect in App.tsx keyed on the resolved workspace path.
//
// The suite runs in plain Node, where no component effect ever runs. This file
// parses App.tsx and selects every useEffect whose body calls a layout store
// function and whose dependencies or body read the session's workspace as
// live.workspace, view.workspace or wokenSlot?.state.workspace. It feeds
// workspace_info frames through the real reducer, evaluates each dependency
// against the reduced state, and runs a selected effect's body on mount and
// whenever a dependency changed, the rule React follows. The layout store is
// the real one.
//
// Card 498 added the third name. A click into the message box of a stored
// session wakes it on the server, and the answer is the same resolved
// workspace_info with a sessionId that card 402's opener keyed on, reduced by
// the same reducer into the woken record's state. App.tsx reads it as
// wokenSlot?.state.workspace for the header chip. An effect keyed on it could
// throw the dock open on a focus click, so the filter knows the name and the
// harness feeds the wake's frames as well.
//
// Since card 402 that selection on App.tsx is empty, and a test below pins it.
// The three timeline cases on App.tsx therefore run no effect today: they are a
// structural pin that turns red once a selected effect moves the dock. The
// positives that keep the selection honest are the old effect as a fixture,
// the old effect put back into the real App.tsx, the same opener keyed on a
// wake, and a check that App.tsx reads the session's workspace only through
// live, view and wokenSlot?.state, the three names the filter knows.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import * as layout from "./state/layout";
import { initialState, reduceAll, type UiState } from "./state/reducer";

const APP = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

/** Every function the layout store exports, read from the module. */
const LAYOUT_FNS: Record<string, unknown> = Object.fromEntries(
  Object.entries(layout).filter(([, value]) => typeof value === "function"),
);

/** Text that reads the session's workspace announcement: the live view's, or a wake's answer (card 498). */
const READS_WORKSPACE = /\b(live|view)\.workspace\b|\bwokenSlot\??\.state\.workspace\b/;

interface ParsedEffect {
  body: string;
  deps: string[];
  /** Each dependency as an expression over `live`: an identifier resolves to its const initializer. */
  depExprs: string[];
  layoutCalls: string[];
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Every useEffect and useLayoutEffect in a source file, with the layout functions its body calls. */
function parseEffects(source: string): ParsedEffect[] {
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const consts: { name: string; pos: number; init: string }[] = [];
  const effects: ParsedEffect[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      consts.push({ name: node.name.text, pos: node.getStart(file), init: node.initializer.getText(file) });
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const [fn, depsNode] = node.arguments;
      if ((name === "useEffect" || name === "useLayoutEffect") && fn !== undefined) {
        const layoutCalls: string[] = [];
        const scan = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const called = calleeName(n);
            if (called !== null && called in LAYOUT_FNS) layoutCalls.push(called);
          }
          ts.forEachChild(n, scan);
        };
        scan(fn);
        const deps =
          depsNode !== undefined && ts.isArrayLiteralExpression(depsNode)
            ? depsNode.elements.map((e) => e.getText(file))
            : [];
        const at = node.getStart(file);
        const depExprs = deps.map((dep) => {
          const decl = consts.filter((c) => c.name === dep && c.pos < at).pop();
          return decl !== undefined ? decl.init : dep;
        });
        effects.push({
          body: fn.getText(file),
          deps,
          depExprs,
          layoutCalls,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return effects;
}

/** The effects that can move the dock when the workspace announcement changes. */
function workspaceLayoutEffects(source: string): ParsedEffect[] {
  return parseEffects(source).filter(
    (fx) =>
      fx.layoutCalls.length > 0 &&
      (fx.depExprs.some((expr) => READS_WORKSPACE.test(expr)) || READS_WORKSPACE.test(fx.body)),
  );
}

/** The text of every object App.tsx reads `.workspace` from or destructures `workspace` out of. */
function workspaceOwners(source: string): string[] {
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const owners = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "workspace") {
      owners.add(node.expression.getText(file));
    }
    if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(file) === "workspace") {
      const holder = node.parent.parent;
      owners.add(
        ts.isVariableDeclaration(holder) && holder.initializer !== undefined
          ? holder.initializer.getText(file)
          : "(a destructured parameter)",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...owners].sort();
}

/** App.tsx's wokenSlot: the record a wake opened, or none while nothing is woken. */
const wokenSlotOf = (woken: UiState | undefined): { state: UiState } | undefined =>
  woken === undefined ? undefined : { state: woken };

function evaluate(expr: string, live: UiState, woken: UiState | undefined): unknown {
  const js = ts.transpile(expr, { target: ts.ScriptTarget.ES2022 });
  return new Function("live", "view", "wokenSlot", `return ${js}`)(live, live, wokenSlotOf(woken));
}

function run(fx: ParsedEffect, values: unknown[], live: UiState, woken: UiState | undefined): void {
  const scope: Record<string, unknown> = { ...LAYOUT_FNS, live, view: live, wokenSlot: wokenSlotOf(woken) };
  fx.deps.forEach((dep, i) => {
    if (/^[A-Za-z_$][\w$]*$/.test(dep)) scope[dep] = values[i];
  });
  const js = ts.transpile(`(${fx.body})`, { target: ts.ScriptTarget.ES2022 });
  const effect = new Function(...Object.keys(scope), `return ${js}`)(...Object.values(scope)) as () => void;
  effect();
}

/** Mounts the effects once; each call renders with a new live state and the woken record's state, the way App re-renders. */
function mount(effects: ParsedEffect[]): (live: UiState, woken?: UiState) => void {
  const seen = new Map<ParsedEffect, unknown[]>();
  return (live, woken) => {
    for (const fx of effects) {
      const values = fx.depExprs.map((expr) => evaluate(expr, live, woken));
      const before = seen.get(fx);
      if (before !== undefined && values.every((v, i) => Object.is(v, before[i]))) continue;
      seen.set(fx, values);
      run(fx, values, live, woken);
    }
  };
}

const frame = (fields: Record<string, unknown>): RunEvent =>
  ({ type: "workspace_info", ts: 1, ...fields }) as unknown as RunEvent;

// The connect-time frame (sendProspectiveWorkspace): what a run started now would use.
const connect = frame({ resolved: false, mode: "random", configured: false });
// The resolved frame sendWorkspaceInfo sends once runPrompt has built the agent.
const resolved = (sessionId: string, folder: string): RunEvent =>
  frame({ resolved: true, mode: "random", configured: false, exists: true, sessionId, path: folder });
// A wake's answer for a stored session whose recorded folder is gone (card 498).
const gone = (sessionId: string, folder: string): RunEvent =>
  frame({
    resolved: false,
    mode: "recorded",
    configured: false,
    exists: false,
    sessionId,
    unavailable: folder,
  });

/** The two fields the owner's screenshot shows changing. */
const dock = (): { rightPanelOpen: boolean; dockFiles: string } => {
  const s = layout.__getState();
  return { rightPanelOpen: s.rightPanelOpen, dockFiles: s.dockFiles };
};
const CLOSED = { rightPanelOpen: false, dockFiles: "closed" };

/** What an operator does to put the dock back: close the Files panel, then the dock. */
function closeByHand(): void {
  if (layout.__getState().dockFiles !== "closed") layout.toggleDockPanel("files");
  if (layout.__getState().rightPanelOpen) layout.toggleRightPanel();
}

beforeEach(() => layout.__resetForTests());

describe("the harness sees App.tsx's effects and can run one that opens the dock", () => {
  // The effect as it stood from 4580702 (2026-08-14) until card 402.
  const OLD_EFFECT = `
      const wsPath = live.workspace?.resolved === true ? (live.workspace.path ?? null) : null;
      useEffect(() => {
        if (wsPath !== null) {
          openRightPanel();
          openDockPanel("files");
        }
      }, [wsPath]);
`;
  const OLD_OPENER = `function App() {${OLD_EFFECT}}`;
  // The same opener keyed on a wake's answer, the reader card 498 added.
  const WAKE_EFFECT = `
      const wokenPath = wokenSlot?.state.workspace?.resolved === true ? (wokenSlot.state.workspace.path ?? null) : null;
      useEffect(() => {
        if (wokenPath !== null) {
          openRightPanel();
          openDockPanel("files");
        }
      }, [wokenPath]);
`;

  it("finds the old opener and, run on the reducer's transition, it opens Agents and Files", () => {
    const effects = workspaceLayoutEffects(OLD_OPENER);
    expect(effects.map((fx) => fx.deps)).toEqual([["wsPath"]]);
    const render = mount(effects);
    let live = initialState;
    render(live);
    live = reduceAll(live, [connect]);
    render(live);
    expect(dock()).toEqual(CLOSED);
    live = reduceAll(live, [resolved("s-402", "/tmp/spectroscope-ws/s-402")]);
    render(live);
    expect(dock()).toEqual({ rightPanelOpen: true, dockFiles: "open" });
    // Agents was a member all along, so it appears beside Files: the pair in the screenshot.
    expect(layout.__getState().dockAgents).toBe("open");
  });

  it("parses App.tsx: it finds its effects and the ones that call the layout store", () => {
    const effects = parseEffects(APP);
    expect(effects.length).toBeGreaterThan(20);
    expect(effects.filter((fx) => fx.layoutCalls.length > 0).length).toBeGreaterThan(0);
  });

  it("run on the real App.tsx with the old effect put back, it selects that effect and it opens the dock", () => {
    // The old effect goes back where card 402 removed it, the way bite B1 did.
    const anchor = APP.indexOf("  // A resolved workspace opens no panel (card 402");
    expect(anchor).toBeGreaterThan(0);
    const restored = APP.slice(0, anchor) + OLD_EFFECT + APP.slice(anchor);
    const effects = workspaceLayoutEffects(restored);
    expect(effects.map((fx) => fx.deps)).toEqual([["wsPath"]]);
    const render = mount(effects);
    let live = reduceAll(initialState, [connect]);
    render(live);
    expect(dock()).toEqual(CLOSED);
    live = reduceAll(live, [resolved("s-402", "/tmp/spectroscope-ws/s-402")]);
    render(live);
    expect(dock()).toEqual({ rightPanelOpen: true, dockFiles: "open" });
  });

  it("finds an opener keyed on a wake and, run on the wake's answer, it opens Agents and Files", () => {
    const effects = workspaceLayoutEffects(`function App() {${WAKE_EFFECT}}`);
    expect(effects.map((fx) => fx.deps)).toEqual([["wokenPath"]]);
    const render = mount(effects);
    const live = reduceAll(initialState, [connect]);
    render(live);
    let woken = reduceAll(initialState, [connect]);
    render(live, woken);
    expect(dock()).toEqual(CLOSED);
    woken = reduceAll(woken, [resolved("s-498", "/work/stored")]);
    render(live, woken);
    expect(dock()).toEqual({ rightPanelOpen: true, dockFiles: "open" });
  });

  it("run on the real App.tsx with the wake opener put in, it selects that effect and it opens the dock", () => {
    const anchor = APP.indexOf("  // A resolved workspace opens no panel (card 402");
    expect(anchor).toBeGreaterThan(0);
    const effects = workspaceLayoutEffects(APP.slice(0, anchor) + WAKE_EFFECT + APP.slice(anchor));
    expect(effects.map((fx) => fx.deps)).toEqual([["wokenPath"]]);
    const render = mount(effects);
    const live = reduceAll(initialState, [connect]);
    render(live, reduceAll(initialState, [connect]));
    expect(dock()).toEqual(CLOSED);
    render(live, reduceAll(initialState, [connect, resolved("s-498", "/work/stored")]));
    expect(dock()).toEqual({ rightPanelOpen: true, dockFiles: "open" });
  });

  it("App.tsx reads the session's workspace only through live, view and a wake's record, the names the filter knows", () => {
    // A fourth name for the session state would hide a workspace-keyed effect
    // from the selection, and every case below would pass on nothing.
    const owners = workspaceOwners(APP);
    expect(owners.filter((owner) => READS_WORKSPACE.test(`${owner}.workspace`))).toEqual([
      "live",
      "view",
      "wokenSlot?.state",
    ]);
    // run is openImport's ImportedRunSummary: the folder an imported run
    // recorded, not the session's announcement.
    expect(owners).toEqual(["live", "run", "view", "wokenSlot?.state"]);
  });
});

describe("a resolved workspace leaves the dock closed (card 402)", () => {
  it("selects no effect in App.tsx, so the three timeline cases below run none", () => {
    // Card 402 removed the only effect that read the workspace and called the layout store.
    expect(workspaceLayoutEffects(APP)).toEqual([]);
  });

  it("the announcement the first message brings back leaves the dock closed", () => {
    const render = mount(workspaceLayoutEffects(APP));
    const timeline: Record<string, unknown>[] = [];
    let live = initialState;
    render(live);
    timeline.push({ step: "mount", ...dock() });
    live = reduceAll(live, [connect]);
    render(live);
    timeline.push({ step: "connect", ...dock() });
    live = reduceAll(live, [resolved("s-402", "/tmp/spectroscope-ws/s-402")]);
    render(live);
    timeline.push({ step: "the first message resolves the workspace", ...dock() });

    expect(live.workspace?.resolved).toBe(true);
    expect(live.workspace?.path).toBe("/tmp/spectroscope-ws/s-402");
    expect(timeline).toEqual([
      { step: "mount", ...CLOSED },
      { step: "connect", ...CLOSED },
      { step: "the first message resolves the workspace", ...CLOSED },
    ]);
  });

  it("every later announcement leaves it closed too: a new folder, a new chat, a resume", () => {
    const render = mount(workspaceLayoutEffects(APP));
    let live = reduceAll(initialState, [connect]);
    render(live);
    live = reduceAll(live, [resolved("s-402", "/tmp/spectroscope-ws/s-402")]);
    render(live);
    closeByHand();

    const timeline: Record<string, unknown>[] = [];
    const step = (name: string, next: UiState): void => {
      live = next;
      render(live);
      timeline.push({
        step: name,
        resolved: live.workspace?.resolved,
        path: live.workspace?.path,
        ...dock(),
      });
    };
    step("the same announcement again", reduceAll(live, [resolved("s-402", "/tmp/spectroscope-ws/s-402")]));
    step("the operator picks another folder", reduceAll(live, [resolved("s-402", "/work/picked")]));
    step("new chat, connect", reduceAll(initialState, [connect]));
    step("new chat, first message", reduceAll(live, [resolved("s-403", "/tmp/spectroscope-ws/s-403")]));
    step(
      "resume an earlier session",
      reduceAll(initialState, [resolved("s-401", "/tmp/spectroscope-ws/s-401")]),
    );

    expect(timeline).toEqual([
      { step: "the same announcement again", resolved: true, path: "/tmp/spectroscope-ws/s-402", ...CLOSED },
      { step: "the operator picks another folder", resolved: true, path: "/work/picked", ...CLOSED },
      { step: "new chat, connect", resolved: false, path: undefined, ...CLOSED },
      { step: "new chat, first message", resolved: true, path: "/tmp/spectroscope-ws/s-403", ...CLOSED },
      { step: "resume an earlier session", resolved: true, path: "/tmp/spectroscope-ws/s-401", ...CLOSED },
    ]);
  });

  it("a wake's answer leaves it closed too: a folder on disk and a folder that is gone (card 498)", () => {
    const render = mount(workspaceLayoutEffects(APP));
    const live = reduceAll(initialState, [connect]);
    render(live);
    const timeline: Record<string, unknown>[] = [];
    const step = (name: string, woken: UiState | undefined): void => {
      render(live, woken);
      timeline.push({ step: name, path: woken?.workspace?.path, ...dock() });
    };
    step("the wake's socket connects", reduceAll(initialState, [connect]));
    step(
      "the wake names the stored folder",
      reduceAll(initialState, [connect, resolved("s-498", "/work/stored")]),
    );
    step(
      "another stored session, its folder gone",
      reduceAll(initialState, [connect, gone("s-499", "/work/deleted")]),
    );
    step("the session leaves the screen, the wake is released", undefined);

    expect(timeline).toEqual([
      { step: "the wake's socket connects", path: undefined, ...CLOSED },
      { step: "the wake names the stored folder", path: "/work/stored", ...CLOSED },
      { step: "another stored session, its folder gone", path: undefined, ...CLOSED },
      { step: "the session leaves the screen, the wake is released", path: undefined, ...CLOSED },
    ]);
  });
});
