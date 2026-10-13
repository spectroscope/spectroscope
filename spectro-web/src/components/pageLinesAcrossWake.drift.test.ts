// Card 577: the lines a stored session's chat answered on the page stay in
// the chat when the session goes live.
//
// A command the page answers (/help, /playbook list, /playbook use) adds a
// line to the chat it was typed in; for a stored session on screen that is
// the replay's state. A session frame continues the session: the resume folds
// the stored file again and hands that state to the live record, and the
// replay leaves the screen. The lines were in neither the file nor the hand
// over, so the live chat lost them (live check 0.15.3, D2).
//
// No test renders App, so this file takes App's own addLocalLine and
// resumeSession out of App.tsx and runs them with stand-ins for what they
// reach (the pattern of playbookAppWiring.drift.test.ts). The sessions are a
// real SessionSet on fake sockets, so the hand over is the real one.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { foldLocalLine, initialState, reduceAll, type UiState } from "../state/reducer";
import * as resume from "../state/resume";
import { SessionSet } from "../state/sessionSet";
import { setPlaybookFrame } from "../state/chatCommands";
import { enterLight, foldResume, indexWanted, returnToLearn } from "../state/modeWork";
import { isOpen } from "../state/surfaces";
import type { LocalLine } from "../state/pageCommands";

const APP = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const FILE = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

/** The one arrow function App assigns to `const name`. */
function constArrow(name: string): ts.ArrowFunction {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(FILE);
  expect(found, `const ${name} in App`).toHaveLength(1);
  const init = found[0].initializer;
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

interface FakeSocket {
  sent: ClientMessage[];
  open: boolean;
  emit(events: RunEvent[]): void;
  status(status: ConnectionStatus): void;
}

function harness() {
  const sockets: FakeSocket[] = [];
  const connect = (options: ConnectOptions): Connection => {
    const socket: FakeSocket = {
      sent: [],
      open: false,
      emit: (events) => options.onEvents(events),
      status: (status) => {
        socket.open = status === "open";
        options.onStatus?.(status);
      },
    };
    sockets.push(socket);
    return {
      send: (msg) => {
        if (!socket.open) return false;
        socket.sent.push(msg);
        return true;
      },
      reconnectNow: () => {},
      close: () => {
        socket.open = false;
      },
    };
  };
  const set = new SessionSet({ connect, mode: () => "light", traceWanted: () => true, onBatch: () => {} });
  set.start();
  set.activate();
  sockets[0].status("open");
  return { set, sockets };
}

const ID = "20261013-020000-d2d2";
const STORED = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "Reply with the single word ready.", ts: 1 },
  { type: "text_delta", agentId: "main", text: "ready", ts: 2 },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 },
] as RunEvent[];
/** The stored session's own turns, as the resume folds them. */
const HISTORY = reduceAll(initialState, STORED).turns;
const LIST: LocalLine = { text: "Playbooks:\nspectro (current)\nother" };
const USED: LocalLine = { text: "This session now uses the playbook other (/pb/other)." };

type Shown = { id: string; state: UiState; events: RunEvent[] } | null;

/** App's page with one stored session on screen: its line adder and its resume. */
function page(set: SessionSet, onScreen: string = ID) {
  let replay: Shown = { id: onScreen, state: reduceAll(initialState, STORED), events: STORED };
  const setReplay = (next: Shown | ((r: Shown) => Shown)): void => {
    replay = typeof next === "function" ? next(replay) : next;
  };
  // The line adder of the render the command was typed in: the stored session on screen.
  const addLine = evaluate<(line: LocalLine) => void>(constArrow("addLocalLine"), {
    lineReplay: onScreen,
    lineKey: set.viewKey(),
    foldLocalLine,
    setReplay,
    sessions: {
      update: () => {
        throw new Error("a stored session's line is no record's");
      },
    },
  });
  let fetched = 0;
  let held: ClientMessage[] = [];
  const resumeSession = evaluate<(id: string, first: { frame: ClientMessage }) => Promise<void>>(
    constArrow("resumeSession"),
    {
      ...resume,
      resumeJoin: {
        carried: () => [],
        begin: (_id: string, _ticket: number, frames: ClientMessage[]) => {
          held = frames;
        },
        take: () => held,
      },
      navNonce: { issue: () => 1, isCurrent: () => true },
      setOpening: () => {},
      sessionTitleOf: () => "stored",
      currentViewMode: () => "light",
      fetch: async (url: string) => {
        expect(url).toBe(`/api/sessions/${ID}/events`);
        fetched++;
        await new Promise((r) => setTimeout(r, 0));
        return { ok: true, json: async () => STORED };
      },
      indexWanted,
      fetchLlmWireIndex: async () => [],
      fetchPeerFrames: async () => [],
      mergePeerFrames: (events: RunEvent[]) => events,
      abandonResumeFrames: () => {
        throw new Error("the resume hands its frames on");
      },
      foldResume,
      openProgress: { report: () => {} },
      isOpen,
      recordResumeMarker: (s: UiState) => s,
      mergeLlmExchanges: (trace: unknown) => trace,
      returnToLearn,
      enterLight,
      currentLiveTraceWanted: () => true,
      sessions: set,
      setReplay,
      labBackToLive: () => {},
      commitUrl: () => {},
      tab: "chat",
      replayRef: {
        get current() {
          return replay;
        },
      },
    },
  );
  return { addLine, resumeSession, shown: () => replay, fetched: () => fetched };
}

const lineTurn = (line: LocalLine) => foldLocalLine(initialState, line.text, { tone: line.tone }).turns[0];

describe("the lines of a stored session's chat when a command wakes it (D2)", () => {
  it("stay in the live chat: the line before the waking command and the line it added", async () => {
    const h = harness();
    const woken = h.set.open({ wake: ID });
    h.sockets[1].status("open");
    const p = page(h.set);

    p.addLine(LIST); // /playbook list
    // /playbook use other: its frame continues the session, its line follows at once.
    const resumed = p.resumeSession(ID, { frame: setPlaybookFrame("/pb/other") });
    p.addLine(USED);
    expect(p.shown()?.state.turns.slice(-2), "premise: both lines are drawn in the stored chat").toEqual([
      lineTurn(LIST),
      lineTurn(USED),
    ]);
    await resumed;

    expect(p.fetched(), "premise: the stored file was read again").toBe(1);
    expect(p.shown(), "premise: the stored chat left the screen").toBeNull();
    expect(h.set.viewKey(), "premise: the woken record is the live chat").toBe(woken);
    expect(h.sockets[1].sent, "premise: the frame left on the woken socket").toContainEqual(
      setPlaybookFrame("/pb/other"),
    );
    const turns = h.set.view().state.turns;
    expect(turns[0], "positive: the history is there").toEqual({
      kind: "user",
      text: "Reply with the single word ready.",
    });
    expect(turns, "the history, then each line once, in order").toEqual([
      ...HISTORY,
      lineTurn(LIST),
      lineTurn(USED),
    ]);
  });

  it("stay in the live chat of a session that had no wake yet, with their tone and link", async () => {
    const h = harness();
    const p = page(h.set);
    p.addLine({ text: "Playbook other", openPlaybook: "/pb/other" }); // /playbook show other
    p.addLine({ text: "No playbook is named x.", tone: "warn" });
    await p.resumeSession(ID, { frame: setPlaybookFrame("/pb/other") });
    expect(h.set.view().resumeId, "premise: a record opened for the session").toBe(ID);
    expect(h.set.view().state.turns, "the history, then each line once, in order").toEqual([
      ...HISTORY,
      { kind: "info", text: "Playbook other", tone: "neutral", openPlaybook: "/pb/other" },
      { kind: "info", text: "No playbook is named x.", tone: "warn" },
    ]);
  });

  it("are another session's when another stored session is on screen at the hand over", async () => {
    const h = harness();
    h.set.open({ wake: ID });
    h.sockets[1].status("open");
    const p = page(h.set, "20261013-030000-else");
    p.addLine(LIST);
    await p.resumeSession(ID, { frame: setPlaybookFrame("/pb/other") });
    expect(h.set.view().state.turns, "the history alone").toEqual(HISTORY);
  });
});
