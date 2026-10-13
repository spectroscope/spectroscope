// Card 554, task 13: App's side of the playbook in the chat. No test renders
// App, so this file parses App.tsx, takes its own functions out of it and runs
// them with stand-ins for what they reach (the pattern of
// storedModelSwitch.drift.test.ts). sendClient, the socket in view, is not
// among the stand-ins: a function that goes back to it throws here.
//
// What is pinned:
// - the header chip's pick and the start sheet's Start leave through
//   sessionFrame, the session's own route (criterion 6), and "No playbook"
//   is the explicit none (integrator decision b);
// - the sheet closes in the record in view, and only once Start left;
// - a page command's line lands in the chat it was typed in, a stored
//   session's included, and nothing is written;
// - the link of /playbook show opens the Steps tab, the play button brings
//   the composer on screen, the command list is asked for on every connect;
// - the Playbook pane starts nothing: App passes it no start, and App sends
//   no start_playbook or start_workflow of its own.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ClientMessage } from "../events";
import { foldLocalLine, initialState, type UiState } from "../state/reducer";
import { noPlaybookFrame, setPlaybookFrame, startPlaybookFrame } from "../state/chatCommands";
import { composerMoves, headerPlaybook } from "../state/playbookHost";
import { headerWorkspace } from "../workspace/wakeChip";
import { markStarting, type PlaybookConfirm } from "../state/playbookChat";
import type { Picks } from "../state/playbookPicks";

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

/** The one arrow function App assigns to `const name`. */
function constArrow(name: string): ts.ArrowFunction {
  const decls = collect(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(decls, `const ${name} in App`).toHaveLength(1);
  const init = decls[0].initializer;
  if (init === undefined || !ts.isArrowFunction(init)) throw new Error(`${name} is not an arrow function`);
  return init;
}

/** Runs App's own source for an expression with the given names in scope. */
function evaluate<T>(node: ts.Node, scope: Record<string, unknown>): T {
  const js = ts.transpile(`(${node.getText(FILE)})`, {
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
  });
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

const CONFIRM = {
  dir: "/pb/spectro",
  prompt: "add a CSV export",
  preview: {
    dir: "/pb/spectro",
    hash: "sha256:ab",
    findings: [],
    steps: [],
    skills: [],
    commands: [],
    refusals: [],
  },
} as unknown as PlaybookConfirm;

describe("the header chip's pick", () => {
  function pick(delivered = true) {
    const sent: ClientMessage[] = [];
    const run = evaluate<(dir: string | null) => boolean>(constArrow("pickPlaybook"), {
      noPlaybookFrame,
      setPlaybookFrame,
      sessionFrame: (frame: ClientMessage) => {
        sent.push(frame);
        return delivered;
      },
    });
    return { run, sent };
  }

  it("leaves on the session's own route, a folder or the explicit No playbook", () => {
    const { run, sent } = pick();
    expect(run("/pb/team-x")).toBe(true);
    expect(run(null)).toBe(true);
    expect(sent).toEqual([
      { type: "set_playbook", dir: "/pb/team-x" },
      { type: "set_playbook", dir: null, none: true },
    ]);
  });

  it("is the header's onPick, beside the play button's showComposer", () => {
    const [prop] = attributes("AppHeader", "playbook");
    expect(prop).toMatch(/onPick: \(dir\) => void pickPlaybook\(dir\)/);
    expect(prop).toMatch(/onShowComposer: showComposer/);
    expect(prop).toMatch(/pick: chipPlaybook\.pick/);
  });
});

describe("the start sheet", () => {
  function sheet(delivered: boolean) {
    const sent: ClientMessage[] = [];
    const updates: { key: string; next: UiState }[] = [];
    const scope = {
      startPlaybookFrame,
      markStarting,
      nextStartAsk: () => "start-1",
      slot: { key: "s1" },
      sessions: {
        update: (key: string, fn: (s: UiState) => UiState) =>
          void updates.push({ key, next: fn({ ...initialState, playbookConfirm: CONFIRM }) }),
      },
      sessionFrame: (frame: ClientMessage) => {
        sent.push(frame);
        return delivered;
      },
    };
    const close = evaluate<() => void>(constArrow("closePlaybookSheet"), scope);
    const start = evaluate<(c: PlaybookConfirm, picks?: Picks) => void>(
      constArrow("startConfirmedPlaybook"),
      {
        ...scope,
        closePlaybookSheet: close,
      },
    );
    return { start, close, sent, updates };
  }

  // Card 584, fix round (review N7): the sheet stays open, marked as starting,
  // until the run's start closes it or the server's refusal shows in it.
  it("starts the run on the session's own route with the hash the sheet showed and the task, and marks it starting", () => {
    const { start, sent, updates } = sheet(true);
    start(CONFIRM, {});
    expect(sent).toEqual([
      {
        type: "start_playbook",
        dir: "/pb/spectro",
        hash: "sha256:ab",
        prompt: "add a CSV export",
        ask: "start-1",
      },
    ]);
    expect(updates.map((u) => [u.key, u.next.playbookConfirm])).toEqual([
      ["s1", { ...CONFIRM, starting: true, ask: "start-1", refusal: null }],
    ]);
  });

  // Card 584: the models picked per step in the sheet go with the start.
  it("sends the picks of the sheet with the start", () => {
    const { start, sent } = sheet(true);
    start(CONFIRM, { write_plan: { provider: "ollama", model: "llama3:8b" } });
    expect(sent).toEqual([
      {
        type: "start_playbook",
        dir: "/pb/spectro",
        hash: "sha256:ab",
        prompt: "add a CSV export",
        picks: { write_plan: { provider: "ollama", model: "llama3:8b" } },
        ask: "start-1",
      },
    ]);
  });

  it("stays open when the start did not leave", () => {
    const { start, updates } = sheet(false);
    start(CONFIRM, {});
    expect(updates).toEqual([]);
  });

  it("is drawn from the live record's confirmation, with these two handlers", () => {
    expect(APP).toContain("const playbookSheet = viewingLive ? live.playbookConfirm : null;");
    expect(attributes("PlaybookChatSheet", "confirm")).toEqual(["{playbookSheet}"]);
    expect(attributes("PlaybookChatSheet", "onStart")).toEqual([
      "{(picks) => startConfirmedPlaybook(playbookSheet, picks)}",
    ]);
    expect(attributes("PlaybookChatSheet", "onClose")).toEqual(["{closePlaybookSheet}"]);
  });
});

describe("a page command's line", () => {
  it("lands in the record that was in view, never written", () => {
    const updates: { key: string; next: UiState }[] = [];
    const add = evaluate<(line: { text: string; tone?: "warn"; openPlaybook?: string }) => void>(
      constArrow("addLocalLine"),
      {
        lineReplay: null,
        lineKey: "s2",
        foldLocalLine,
        setReplay: () => {
          throw new Error("the live view has no replay");
        },
        sessions: {
          update: (key: string, fn: (s: UiState) => UiState) =>
            void updates.push({ key, next: fn(initialState) }),
        },
      },
    );
    add({ text: "Playbook spectro", openPlaybook: "/pb/spectro" });
    expect(updates).toHaveLength(1);
    expect(updates[0].key).toBe("s2");
    expect(updates[0].next.turns).toEqual([
      { kind: "info", text: "Playbook spectro", tone: "neutral", openPlaybook: "/pb/spectro" },
    ]);
  });

  it("lands in the stored session on screen, and not in another one", () => {
    type R = { id: string; state: UiState } | null;
    let replay: R = { id: "stored-1", state: initialState };
    const add = evaluate<(line: { text: string; tone?: "warn" }) => void>(constArrow("addLocalLine"), {
      lineReplay: "stored-1",
      lineKey: "s2",
      foldLocalLine,
      setReplay: (fn: (r: R) => R) => {
        replay = fn(replay);
      },
      sessions: {
        update: () => {
          throw new Error("a stored session's line is no record's");
        },
      },
    });
    add({ text: "No playbook is named x.", tone: "warn" });
    expect(replay?.state.turns).toEqual([{ kind: "info", text: "No playbook is named x.", tone: "warn" }]);
    replay = { id: "stored-2", state: initialState };
    add({ text: "late" });
    expect(replay.state.turns, "the screen moved on").toEqual([]);
  });

  it("is the composer's, beside the Skills view, the Steps link and the chip's workspace", () => {
    expect(APP).toContain("onLocalLine: addLocalLine,");
    expect(APP).toContain("onOpenSkills: openSkills,");
    expect(APP).toContain('onOpenPlaybook: viewMode === "developer" ? openPlaybookSteps : undefined,');
    expect(APP).toContain("commandWorkspace: chipWorkspace?.path ?? null,");
  });
});

describe("the doors around it", () => {
  it("opens the Steps tab of the playbook a /playbook show named", () => {
    const calls: string[] = [];
    const open = evaluate<(dir: string) => void>(constArrow("openPlaybookSteps"), {
      showFolder: (dir: string, tab: string) => void calls.push(`showFolder ${dir} ${tab}`),
      pickSegment: (next: string) => void calls.push(`segment ${next}`),
    });
    open("/pb/spectro");
    expect(calls).toEqual(["showFolder /pb/spectro playbook", "segment playbook"]);
  });

  it("brings the composer on screen for the play button", () => {
    const calls: string[] = [];
    const show = (at: { skillsOpen: boolean; nav: string; tab: string }) =>
      evaluate<() => void>(constArrow("showComposer"), {
        ...at,
        composerMoves,
        pickSegment: (next: string) => void calls.push(`segment ${next}`),
        changeTab: (next: string) => void calls.push(`tab ${next}`),
      })();
    show({ skillsOpen: false, nav: "playbook", tab: "trace" });
    expect(calls).toEqual(["segment sessions", "tab chat"]);
    calls.length = 0;
    show({ skillsOpen: false, nav: "sessions", tab: "chat" });
    expect(calls).toEqual([]);
  });

  it("asks for the command list on every connect (criterion 8h)", () => {
    expect(APP.match(/useCommandsOnConnect\(conn\.status\);/g) ?? []).toHaveLength(1);
  });

  it("passes the Playbook pane no start, and sends no start of its own (criterion 8)", () => {
    expect(attributes("PlaybookPane", "onStartPlaybook")).toEqual([]);
    expect(attributes("PlaybookPane", "onStartWorkflow")).toEqual([]);
    expect(APP).not.toMatch(/type: "start_playbook"/);
    expect(APP).not.toMatch(/type: "start_workflow"/);
    expect(attributes("PlaybookPane", "workspace"), "positive: the pane is still mounted").toHaveLength(1);
  });
});

// Card 554 fix round 3, item 1 (criterion 6, reproduced live): /playbook use
// typed in A, New chat B 300 ms later, and the pick went to B while A said it
// was taken. The composer asks App for a sender at the submit; App binds it to
// the record in view then, and a record that is gone takes nothing.
describe("the sender a page command is bound to at its submit", () => {
  type Sent = [string, ClientMessage];
  function liveSet(view: string, held: string[]) {
    const state = { view, held: new Set(held), sent: [] as Sent[] };
    const sessions = {
      view: () => ({ key: state.view }),
      get: (key: string) => (state.held.has(key) ? { key } : undefined),
      sendClient: (key: string, msg: ClientMessage) => {
        state.sent.push([key, msg]);
        return true;
      },
    };
    return { state, sessions };
  }
  const bindIn = (scope: Record<string, unknown>) =>
    evaluate<() => (frame: ClientMessage) => boolean>(constArrow("bindSessionFrame"), scope);
  const FRAME: ClientMessage = { type: "set_playbook", dir: "/pb/team-x" };

  it("sends to the record that was in view at the submit, after the view moved on", () => {
    const { state, sessions } = liveSet("A", ["A", "B"]);
    const bind = bindIn({
      replay: null,
      replayShown: { current: null },
      sessions,
      sessionFrame: () => {
        throw new Error("the render's sessionFrame reads the view when the frame leaves");
      },
    });
    const send = bind();
    state.view = "B";
    expect(send(FRAME)).toBe(true);
    expect(state.sent).toEqual([["A", FRAME]]);
  });

  it("sends nothing when that record is gone", () => {
    const { state, sessions } = liveSet("A", ["A"]);
    const send = bindIn({
      replay: null,
      replayShown: { current: null },
      sessions,
      sessionFrame: () => true,
    })();
    state.held.delete("A");
    expect(send(FRAME)).toBe(false);
    expect(state.sent).toEqual([]);
  });

  it("continues the stored session that was on screen, and nothing once another one is", () => {
    const shown = { current: "stored-1" as string | null };
    const through: ClientMessage[] = [];
    const send = bindIn({
      replay: { id: "stored-1" },
      replayShown: shown,
      sessions: { view: () => ({ key: "s1" }) },
      sessionFrame: (frame: ClientMessage) => {
        through.push(frame);
        return true;
      },
    })();
    expect(send(FRAME)).toBe(true);
    expect(through).toEqual([FRAME]);
    shown.current = "stored-2";
    expect(send(FRAME)).toBe(false);
    expect(through).toHaveLength(1);
  });

  it("is what /playbook use sends through, across a slow read and a switch to a new chat", async () => {
    const { state, sessions } = liveSet("A", ["A", "B"]);
    const send = bindIn({
      replay: null,
      replayShown: { current: null },
      sessions,
      sessionFrame: () => true,
    })();
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const { runPageCommand } = await import("../state/pageCommands");
    const lines: string[] = [];
    const prior = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.startsWith("/api/playbooks?")) {
        return { ok: true, json: async () => ({ folders: ["/pb/team-x"], active: null }) };
      }
      await slow;
      return { ok: true, json: async () => ({ dir: "/pb/team-x", playbook: { name: "Team X" } }) };
    }) as unknown as typeof fetch;
    try {
      const run = runPageCommand(
        { kind: "playbookUse", name: "Team X" },
        {
          rows: [],
          lang: "en",
          pick: null,
          workspace: "/ws",
          sendSession: send,
          line: (l) => void lines.push(l.text),
        },
      );
      await new Promise((r) => setTimeout(r, 300));
      state.view = "B";
      release();
      await run.settled;
    } finally {
      globalThis.fetch = prior;
    }
    expect(state.sent).toEqual([["A", FRAME]]);
    expect(lines).toEqual(["This session now uses the playbook Team X (/pb/team-x)."]);
  });

  it("is the composer's, beside the render's own session sender", () => {
    expect(APP).toContain("onBindSessionFrame: bindSessionFrame,");
    expect(APP).toMatch(/replayShown\.current = replay\?\.id \?\? null;/);
  });
});

// Card 554 fix round 3, item 4: the inputs of the header's two chips, run as
// App's own expressions, so a mutated input turns a case red.
describe("the header chips' inputs", () => {
  function initializer(name: string): ts.Expression {
    const decls = collect(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    );
    expect(decls, `const ${name} in App`).toHaveLength(1);
    const init = decls[0].initializer;
    if (init === undefined) throw new Error(`${name} has no initializer`);
    return init;
  }
  const L = { dir: "/pb/live", name: "L", found: true };
  const R = { dir: "/pb/rec", name: "R", found: null };
  const W = { dir: "/pb/woken", name: "W", found: true };

  it("draws the live pick live, the recorded pick before the wake and the wake's after it", () => {
    const pick = (scope: Record<string, unknown>) =>
      evaluate<{ pick: unknown } | null>(initializer("chipPlaybook"), { headerPlaybook, ...scope });
    expect(
      pick({
        viewingLive: true,
        live: { playbook: L },
        continuable: false,
        replay: null,
        wokenSlot: undefined,
      }),
    ).toEqual({
      pick: L,
    });
    const stored = {
      viewingLive: false,
      live: { playbook: L },
      continuable: true,
      replay: { state: { playbook: R } },
    };
    expect(pick({ ...stored, wokenSlot: undefined })).toEqual({ pick: R });
    expect(pick({ ...stored, wokenSlot: { state: { playbook: W } } })).toEqual({ pick: W });
    expect(pick({ ...stored, continuable: false, wokenSlot: undefined })).toBeNull();
  });

  it("draws the live folder live, the recorded folder before the wake and the wake's answer after it", () => {
    const where = (scope: Record<string, unknown>) =>
      evaluate<{ path?: string } | null>(initializer("chipWorkspace"), { headerWorkspace, ...scope });
    const live = { path: "/live", resolved: true, configured: true };
    const woken = { path: "/woken", resolved: true, configured: true, sessionId: "stored-1" };
    const base = { view: { workspace: live }, shownStoredCwd: "/recorded" };
    expect(
      where({ ...base, viewingLive: true, continuable: false, replay: null, wokenSlot: undefined })?.path,
    ).toBe("/live");
    const stored = { ...base, viewingLive: false, continuable: true, replay: { id: "stored-1" } };
    expect(where({ ...stored, wokenSlot: undefined })?.path).toBe("/recorded");
    expect(where({ ...stored, wokenSlot: { state: { workspace: woken } } })?.path).toBe("/woken");
  });
});
