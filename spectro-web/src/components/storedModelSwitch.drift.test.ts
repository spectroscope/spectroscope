// Card 556: App's side of a model picked in a stored session. No spectro-web
// test renders App, so this file parses App.tsx, takes the real functions out
// of it and runs them with stand-ins for what they reach (the pattern of
// workspace/storedFolderSeam.drift.test.ts). A name the code reads that the
// stand-ins do not provide throws, so a switch that goes back to sendClient,
// the socket in view, fails here.
//
// What is pinned:
// - changeProvider sends the pick through sessionFrame, the route the gear's
//   frames take since card 504, with an ask id the server's answer echoes.
// - every batch reaches saveConfirmedProvider with its own record key and
//   frames (fix round 1: removing that call left every test green), and only
//   the server's answer to the pick writes the default for new chats.
// - a resume that ends without continuing the session drops the pick it held;
//   a failed one says so in the chat (fix round 1).
//
// The rules behind each function are pinned in state/providerSwitch.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { initialState, type UiState } from "../state/reducer";
import {
  askedSwitch,
  confirmedSwitch,
  switchFrame,
  switchLost,
  switchNotSent,
  type AskedSwitch,
} from "../state/providerSwitch";
import { SessionSet } from "../state/sessionSet";
import type { Connection, ConnectOptions } from "../transport/ws";

const APP = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const FILE = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

/** Every node in App.tsx that satisfies the test. */
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

const STORED = "20261012-090000-abcd";
const info = (provider: string, model: string, answers?: string): RunEvent =>
  ({
    type: "provider_info",
    provider,
    model,
    host: "local",
    ...(answers ? { answers } : {}),
  }) as unknown as RunEvent;

describe("the model picker's switch", () => {
  function changeProvider(replay: { id: string } | null, delivered: boolean) {
    const sent: ClientMessage[] = [];
    const asked = { current: null as AskedSwitch | null };
    const run = evaluate<(provider: string, model: string) => void>(constArrow("changeProvider"), {
      replay,
      sessions: { view: () => ({ key: "s1" }) },
      askedSwitch,
      switchFrame,
      nextSwitchAsk: () => "p9",
      providerSwitchAsked: asked,
      sessionFrame: (frame: ClientMessage) => {
        sent.push(frame);
        return delivered;
      },
    });
    return { run, sent, asked };
  }

  it("in a stored session leaves on the session's own route, asking by the session id", () => {
    const { run, sent, asked } = changeProvider({ id: STORED }, true);
    run("ollama", "qwen3");
    expect(sent).toEqual([{ type: "set_provider", provider: "ollama", model: "qwen3", ask: "p9" }]);
    expect(asked.current).toEqual(askedSwitch(STORED, "s1", "ollama", "qwen3", "p9"));
  });

  it("in the live view asks on the record in view", () => {
    const { run, sent, asked } = changeProvider(null, true);
    run("ollama", "");
    expect(sent).toEqual([{ type: "set_provider", provider: "ollama", ask: "p9" }]);
    expect(asked.current).toEqual(askedSwitch(null, "s1", "ollama", "", "p9"));
  });

  it("a pick that did not leave is not waited for", () => {
    const { run, asked } = changeProvider({ id: STORED }, false);
    run("ollama", "qwen3");
    expect(asked.current).toBeNull();
  });

  it("is the picker's apply, under the live view and a stored session alike", () => {
    expect(APP.match(/onApplyProvider: changeProvider,/g) ?? []).toHaveLength(1);
  });
});

describe("the default for new chats", () => {
  function save(asked: AskedSwitch | null) {
    const writes: [string, unknown][] = [];
    const retired: (string | null)[] = [];
    const ref = { current: asked };
    const fn = evaluate<(key: string, batch: RunEvent[]) => void>(constArrow("saveConfirmedProvider"), {
      sessions: {
        slots: () => [
          { key: "s1", sessionId: null },
          { key: "s4", sessionId: STORED },
        ],
        retireBlanks: (except: string | null) => void retired.push(except),
      },
      confirmedSwitch,
      providerSwitchAsked: ref,
      putSettings: (scope: string, body: unknown) => {
        writes.push([scope, body]);
        return Promise.resolve();
      },
    });
    return { fn, writes, ref, retired };
  }

  it("is written from the server's answer to the pick, on the record that holds the session", async () => {
    const { fn, writes, ref, retired } = save(askedSwitch(STORED, "s1", "ollama", "qwen3", "p9"));
    fn("s4", [info("llamacpp", "old-model"), info("ollama", "qwen3", "p9")]);
    expect(writes).toEqual([["user", { provider: "ollama", model: "qwen3" }]]);
    expect(ref.current).toBeNull();
    // Live check 0.15.3 D5: once the write landed, the blank records go, all
    // but the one that asked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retired).toEqual(["s4"]);
  });

  it("is not written from the pair the record announced on its own, nor after a refusal", async () => {
    const { fn, writes, ref, retired } = save(askedSwitch(STORED, "s1", "ollama", "qwen3", "p9"));
    fn("s4", [info("ollama", "qwen3")]);
    fn("s4", [{ type: "error", agentId: "main", message: "refused", ts: 1 } as RunEvent]);
    expect(writes).toEqual([]);
    expect(ref.current).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retired).toEqual([]);
  });

  it("every batch reaches it with its own record key and frames, first and unconditionally", () => {
    const sinks = collect(
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(FILE) === "batchSink.current",
    );
    expect(sinks).toHaveLength(1);
    const sink = sinks[0].right;
    if (!ts.isArrowFunction(sink) || !ts.isBlock(sink.body))
      throw new Error("batchSink.current is not a block arrow");
    const first = sink.body.statements[0];
    if (!ts.isExpressionStatement(first) || !ts.isCallExpression(first.expression)) {
      throw new Error(`the sink starts with: ${first?.getText(FILE)}`);
    }
    const call = first.expression;
    expect(call.expression.getText(FILE)).toBe("saveConfirmedProvider");
    expect(call.arguments.map((arg) => arg.getText(FILE))).toEqual(
      sink.parameters.slice(0, 2).map((param) => param.name.getText(FILE)),
    );
  });

  it("a batch the SessionSet hands on writes the default through App's own sink", () => {
    // The chain as App wires it: SessionSet's onBatch, the sink's first
    // statement, saveConfirmedProvider. Built from App's text, run here.
    const onBatch = collect(
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        node.name.getText(FILE) === "onBatch" &&
        ts.isArrowFunction(node.initializer),
    );
    expect(onBatch).toHaveLength(1);
    const sink = collect(
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) && node.left.getText(FILE) === "batchSink.current",
    )[0].right as ts.ArrowFunction;
    const params = sink.parameters.map((param) => param.name.getText(FILE));
    const first = (sink.body as ts.Block).statements[0].getText(FILE);
    const { fn, writes } = save(askedSwitch(STORED, "s1", "ollama", "qwen3", "p9"));
    const current = new Function("saveConfirmedProvider", `return (${params.join(", ")}) => { ${first} };`)(
      fn,
    );
    const handOn = evaluate<(key: string, batch: RunEvent[], info: unknown) => void>(onBatch[0].initializer, {
      batchSink: { current },
    });
    handOn("s4", [info("ollama", "qwen3", "p9")], { inView: false, carrier: false });
    expect(writes).toEqual([["user", { provider: "ollama", model: "qwen3" }]]);
  });
});

// Live check 0.15.3 D5 (card 556, criterion 3): the owner picked a model in a
// stored session, settings.json held it, and New chat in the same window still
// ran on the old default until a reload. The flow as the page runs it: App's
// own saveConfirmedProvider and newChat on a real SessionSet, against sockets
// that load the user settings when they connect, as
// SpectroSocketHandler.afterConnectionEstablished does.
describe("a pick in a stored session, then New chat in the same window", () => {
  it("starts the new chat on the picked pair, without a reload", async () => {
    let settings = { provider: "llamacpp", model: "local-model" };
    interface Wire {
      loaded: { provider: string; model: string };
      options: ConnectOptions;
      sent: ClientMessage[];
      closed: boolean;
      opened: boolean;
    }
    const wires: Wire[] = [];
    const connect = (options: ConnectOptions): Connection => {
      const wire: Wire = { loaded: { ...settings }, options, sent: [], closed: false, opened: false };
      wires.push(wire);
      return {
        send: (msg) => {
          if (!wire.opened || wire.closed) return false;
          wire.sent.push(msg);
          return true;
        },
        reconnectNow: () => {},
        close: () => {
          wire.closed = true;
        },
      };
    };
    /** Every socket not open yet opens and announces the pair it loaded. */
    const openAll = (): void => {
      for (const wire of wires) {
        if (wire.opened || wire.closed) continue;
        wire.opened = true;
        wire.options.onStatus?.("open");
        wire.options.onEvents([info(wire.loaded.provider, wire.loaded.model)]);
      }
    };
    const asked = { current: null as AskedSwitch | null };
    let sink: (key: string, batch: RunEvent[]) => void = () => {};
    const sessions = new SessionSet({
      connect,
      mode: () => "learn",
      traceWanted: () => false,
      onBatch: (key, batch) => sink(key, batch),
    });
    sink = evaluate<(key: string, batch: RunEvent[]) => void>(constArrow("saveConfirmedProvider"), {
      sessions,
      confirmedSwitch,
      providerSwitchAsked: asked,
      // The write lands a moment after the request, as it does on the server.
      putSettings: (_scope: string, pair: { provider: string; model: string }) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settings = { ...pair };
            resolve();
          }, 5),
        ),
    });
    const newChat = evaluate<() => void>(constArrow("newChat"), {
      sessions,
      setReplay: () => {},
      setEnteredFleet: () => {},
      setSkillsOpen: () => {},
      setTab: () => {},
      navNonce: { issue: () => {} },
      commitUrl: () => {},
    });

    // The page loads with a blank chat on the default of the moment.
    sessions.start();
    sessions.activate();
    openAll();
    // The stored session recorded on llamacpp is opened, and its wake holds it.
    const woken = sessions.open({ wake: STORED });
    openAll();
    // The pick continues the stored session (the view goes live) and leaves
    // on the socket its wake holds; the server answers it there.
    asked.current = askedSwitch(STORED, sessions.viewKey(), "ollama", "minimax-m3:cloud", "pick-1");
    sessions.continueWoken(woken, {
      state: initialState,
      events: [],
      firstFrames: [switchFrame(asked.current)],
    });
    expect(wires[1].sent).toContainEqual(switchFrame(asked.current));
    wires[1].options.onEvents([info("ollama", "minimax-m3:cloud", "pick-1")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settings, "the default for new chats was written").toEqual({
      provider: "ollama",
      model: "minimax-m3:cloud",
    });

    newChat();
    openAll();

    expect(sessions.view().state.providerInfo?.provider, "the new chat announces the picked pair").toBe(
      "ollama",
    );
    sessions.send(sessions.viewKey(), "hello");
    const carrying = wires.filter((wire) => wire.sent.some((msg) => msg.type === "user_message"));
    expect(
      carrying.map((wire) => wire.loaded),
      "the prompt leaves on a socket that loaded the pick",
    ).toEqual([{ provider: "ollama", model: "minimax-m3:cloud" }]);
    expect(
      wires.filter((wire) => !wire.closed && wire.loaded.provider === "llamacpp" && wire !== wires[1]),
      "no blank socket on the old default is left behind",
    ).toEqual([]);
  });
});

describe("a resume that ends without continuing the session", () => {
  const MODE: ClientMessage = { type: "set_permission_mode", mode: "auto" };

  function abandon(asked: AskedSwitch | null, shownId: string = STORED) {
    const dropped: [string, ClientMessage][] = [];
    const ref = { current: asked };
    let shown: { id: string; state: UiState } | null = { id: shownId, state: initialState };
    let replays = 0;
    const fn = evaluate<(id: string, frames: ClientMessage[], failed: boolean) => void>(
      constArrow("abandonResumeFrames"),
      {
        sentWrites: { drop: (id: string, frame: ClientMessage) => void dropped.push([id, frame]) },
        providerSwitchAsked: ref,
        switchLost,
        switchNotSent,
        setReplay: (next: (prev: typeof shown) => typeof shown) => {
          replays += 1;
          shown = next(shown);
        },
      },
    );
    return { fn, dropped, ref, shown: () => shown, replays: () => replays };
  }

  it("drops every frame's held writes, as before", () => {
    const pick = askedSwitch(STORED, "s1", "ollama", "qwen3", "p9");
    const h = abandon(pick);
    h.fn(STORED, [MODE, switchFrame(pick)], false);
    expect(h.dropped).toEqual([
      [STORED, MODE],
      [STORED, switchFrame(pick)],
    ]);
  });

  // Fix round 2: the drop is the card 504 and card 431 rule and holds with no
  // pick in play at all; a loop moved below the pick's guard skipped it.
  it("drops the held writes when no pick waits, superseded or failed", () => {
    const h = abandon(null);
    h.fn(STORED, [MODE], false);
    h.fn(STORED, [MODE], true);
    expect(h.dropped).toEqual([
      [STORED, MODE],
      [STORED, MODE],
    ]);
    const other = abandon(askedSwitch("20261012-090000-other", "s1", "ollama", "qwen3", "p9"));
    other.fn(STORED, [MODE], true);
    expect(other.dropped, "a pick of another session waits").toEqual([[STORED, MODE]]);
  });

  // Fix round 2: the line belongs to the session whose resume failed. With
  // another stored session on screen by then, that chat stays as it was.
  it("a failed resume of one session leaves no line in another session on screen", () => {
    const pick = askedSwitch(STORED, "s1", "ollama", "qwen3", "p9");
    const h = abandon(pick, "20261012-090000-other");
    h.fn(STORED, [switchFrame(pick)], true);
    expect(h.ref.current, "positive: the pick was let go").toBeNull();
    expect(h.replays(), "positive: the replay update ran").toBe(1);
    expect(h.shown()?.id).toBe("20261012-090000-other");
    expect(h.shown()?.state.turns).toEqual(initialState.turns);
  });

  it("when a later navigation won, the pick is no longer waited for and the chat says nothing", () => {
    const pick = askedSwitch(STORED, "s1", "ollama", "qwen3", "p9");
    const h = abandon(pick);
    h.fn(STORED, [switchFrame(pick)], false);
    expect(h.ref.current).toBeNull();
    expect(h.replays()).toBe(0);
  });

  it("when the resume failed, the pick is dropped and the stored session on screen says so", () => {
    const pick = askedSwitch(STORED, "s1", "ollama", "qwen3", "p9");
    const h = abandon(pick);
    h.fn(STORED, [switchFrame(pick)], true);
    expect(h.ref.current).toBeNull();
    const turns = h.shown()?.state.turns ?? [];
    expect(turns[turns.length - 1]).toMatchObject({
      kind: "info",
      tone: "warn",
      infoKey: "chat.switchNotSent",
    });
  });

  it("a resume without the pick leaves the pick alone", () => {
    const pick = askedSwitch(STORED, "s1", "ollama", "qwen3", "p9");
    const h = abandon(pick);
    h.fn(STORED, [MODE], true);
    expect(h.ref.current).toBe(pick);
    expect(h.replays()).toBe(0);
  });

  it("resumeSession hands its frames there at both early returns and in the catch", () => {
    const resume = constArrow("resumeSession");
    const calls = collect(
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && node.expression.getText(FILE) === "abandonResumeFrames",
      resume,
    );
    expect(calls.map((call) => call.arguments.map((arg) => arg.getText(FILE)).join(", "))).toEqual([
      "id, resumeJoin.take(ticket), false",
      "id, resumeJoin.take(ticket), false",
      "id, resumeJoin.take(ticket), true",
    ]);
    const inCatch = (node: ts.Node): boolean =>
      node.parent !== undefined && (ts.isCatchClause(node.parent) || inCatch(node.parent));
    expect(calls.map(inCatch)).toEqual([false, false, true]);
    expect(resume.getText(FILE), "no frame dropped past the one place").not.toContain("sentWrites.drop(");
  });
});
