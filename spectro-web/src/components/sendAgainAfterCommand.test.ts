// Card 576: "Send again" under a refused command.
//
// Card 554 took the button away from an error that answers a command. The
// mark that said so lived in the Chat and was cleared when the view key
// changed, and the view key changes on a wake (the stored session becomes the
// live record) and on every switch between sessions. Afterwards the refusal
// card offered the owner's last prompt again (live check 0.15.3, D1).
//
// Fix round (integrator decision 2): only a command typed in the composer
// marks the record. The header's playbook pick and the loop chip's Stop leave
// a prompt's failure with its Send again.
//
// Chat runs here under HookHost, so its effects run as in the window, and the
// sessions are a real SessionSet on fake sockets (testkit/chatHost.ts). The
// command is typed into the composer's own field.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { ComposerStrip } from "./ComposerStrip";
import { initialState, normalizeReplay, reduceAll, reduceAllUntraced, type UiState } from "../state/reducer";
import { withCommandMarks } from "../lab/labChatState";
import { seedResumedLive } from "../state/resume";
import { noPlaybookFrame, setPlaybookFrame } from "../state/chatCommands";
import { __resetCommandList, __setCommandRows, type CommandRow } from "../state/commandList";
import { coreCommandRows } from "../testkit/commandRows";
import {
  errorCards,
  flatten,
  hostChat,
  liveChatView,
  sendAgainButtons,
  sessionHarness,
  stubBrowser,
  submit,
  treeOf,
  type ChatView,
} from "../testkit/chatHost";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const ID = "20261013-020000-d1d1";
const OLD = "Reply with the single word ready.";
const USAGE = "Usage: /run-with-playbook <prompt>, for example /run-with-playbook add a CSV export";

/** One prompt and its answer, as a session file and a live socket carry them. */
const ran = (prompt: string, runId: string): RunEvent[] =>
  [
    { type: "run_start", runId, agentId: "main", prompt, ts: 1 },
    { type: "text_delta", agentId: "main", text: "ready", ts: 2 },
    { type: "run_end", runId, stopReason: "end_turn", ts: 3 },
  ] as RunEvent[];
const refusal = (message: string): RunEvent => ({ type: "error", message, ts: 4 }) as RunEvent;
const started = (prompt: string, runId: string): RunEvent =>
  ({ type: "run_start", runId, agentId: "main", prompt, ts: 5 }) as RunEvent;
const failed = (runId: string): RunEvent =>
  ({ type: "run_end", runId, stopReason: "error", ts: 6 }) as RunEvent;

let resent: string[] = [];

beforeEach(() => {
  resent = [];
  __setCommandRows(coreCommandRows());
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/playbooks?") || url === "/api/playbooks") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ folders: ["/pb/spectro", "/pb/team-x"], active: null }),
        });
      }
      if (url.startsWith("/api/playbooks/load")) {
        const dir = decodeURIComponent(/dir=([^&]*)/.exec(url)?.[1] ?? "");
        return Promise.resolve({
          ok: true,
          json: async () => ({ dir, findings: [], steps: [], topology: null, playbook: null }),
        });
      }
      return new Promise(() => {});
    }),
  );
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCommandList();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const lastTurn = (state: UiState) => state.turns[state.turns.length - 1];

/**
 * D1 as the owner met it: a stored session woken by its selection, the
 * command typed into its composer, the resume handing over to the woken
 * record, and the server's refusal.
 */
function wokenRefusal() {
  const h = sessionHarness();
  const stored = reduceAll(initialState, ran(OLD, "r1"));
  const wake = h.set.open({ wake: ID });
  h.sockets[1].status("open");
  // The replay view, as App draws it: the composer continues the session,
  // and a session frame waits for the resume (App's sessionFrame).
  const held: ClientMessage[] = [];
  const replay: ChatView = {
    state: stored,
    viewKey: ID,
    liveView: false,
    onSend: () => {
      throw new Error("a command is not a prompt");
    },
    onCommand: () => {
      throw new Error("not this command");
    },
    sessionFrame: (frame) => {
      held.push(frame);
      return true;
    },
    sendClient: () => {
      throw new Error("a command never leaves on the socket in view");
    },
  };
  let shown: () => ChatView = () => replay;
  const chat = hostChat(() => shown());

  submit(chat, "/run-with-playbook");
  expect(held, "premise: the command waits for the resume").toEqual([
    { type: "confirm_playbook", prompt: "" },
  ]);

  // The resume hands over (App's resumeSession): the woken record takes the
  // history and sends the held frame; the view becomes the live record.
  h.set.continueWoken(wake, { state: seedResumedLive(stored), events: ran(OLD, "r1"), firstFrames: held });
  shown = () => liveChatView(h.set, resent);
  chat.invalidate();
  expect(h.set.viewKey(), "premise: the woken record is in view").toBe(wake);
  expect(h.sockets[1].sent).toContainEqual({ type: "confirm_playbook", prompt: "" });

  h.sockets[1].emit([refusal(USAGE)]);
  chat.invalidate();
  expect(lastTurn(h.set.view().state), "premise: the refusal is drawn").toEqual(
    expect.objectContaining({ kind: "error", text: USAGE }),
  );
  return { h, chat };
}

describe("Send again after a refused command in a woken stored session (D1)", () => {
  it("is not offered under the refusal of the command the wake carried", () => {
    const { chat } = wokenRefusal();
    expect(errorCards(treeOf(chat)), "no resend of the stored prompt").toEqual([
      { text: USAGE, sendAgain: [] },
    ]);
    expect(resent).toEqual([]);
    chat.unmount();
  });

  it("is offered under a prompt that fails afterwards, there alone, and resends that prompt", () => {
    const { h, chat } = wokenRefusal();

    submit(chat, "Try once more");
    expect(h.sockets[1].sent[h.sockets[1].sent.length - 1]).toEqual({
      type: "user_message",
      text: "Try once more",
    });
    h.sockets[1].emit([started("Try once more", "r2"), refusal("the provider is down"), failed("r2")]);
    chat.invalidate();

    const cards = errorCards(treeOf(chat));
    expect(cards.map((c) => [c.text, c.sendAgain.length])).toEqual([
      [USAGE, 0],
      ["the provider is down", 1],
    ]);
    expect(sendAgainButtons(treeOf(chat)), "one Send again in the whole chat").toHaveLength(1);
    resent.length = 0;
    (cards[1].sendAgain[0].props.onClick as () => void)();
    expect(resent).toEqual(["Try once more"]);
    chat.unmount();
  });
});

describe("Send again after a refused command and a view switch", () => {
  it("is still not offered when the owner comes back to the session", () => {
    const h = sessionHarness();
    const a = h.set.viewKey();
    h.set.send(a, OLD);
    h.sockets[0].emit(ran(OLD, "r1"));
    const chat = hostChat(() => liveChatView(h.set, resent));

    submit(chat, "/run-with-playbook");
    expect(h.sockets[0].sent[h.sockets[0].sent.length - 1]).toEqual({ type: "confirm_playbook", prompt: "" });
    h.sockets[0].emit([refusal(USAGE)]);
    chat.invalidate();
    expect(sendAgainButtons(treeOf(chat)), "premise: not offered right after the refusal").toEqual([]);

    const b = h.set.open({});
    h.sockets[h.sockets.length - 1].status("open");
    chat.invalidate();
    expect(h.set.viewKey(), "premise: another session is in view").toBe(b);
    h.set.select(a);
    chat.invalidate();
    expect(lastTurn(h.set.view().state), "premise: back on the refusal").toEqual(
      expect.objectContaining({ kind: "error", text: USAGE }),
    );

    expect(errorCards(treeOf(chat)), "no resend of the last prompt").toEqual([
      { text: USAGE, sendAgain: [] },
    ]);
    chat.unmount();
  });
});

// App's own source for the header chip's pick, run with the session's route
// as its sessionFrame (the pattern of playbookAppWiring.drift.test.ts).
const APP = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const APP_FILE = ts.createSourceFile("App.tsx", APP, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function appArrow<T>(name: string, scope: Record<string, unknown>): T {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(APP_FILE);
  expect(found, `const ${name} in App`).toHaveLength(1);
  const js = ts.transpile(`(${found[0].initializer?.getText(APP_FILE)})`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(scope), `"use strict"; return ${js}`)(...Object.values(scope)) as T;
}

/** The owner's prompt is running in the live record in view. */
function promptRunning(prompt: string) {
  const h = sessionHarness();
  const key = h.set.viewKey();
  const chat = hostChat(() => liveChatView(h.set, resent));
  submit(chat, prompt);
  expect(h.sockets[0].sent, "premise: the prompt left").toEqual([{ type: "user_message", text: prompt }]);
  h.sockets[0].emit([started(prompt, "r1")]);
  return { h, key, chat };
}

/** The prompt fails; its card offers Send again, alone, and it resends the prompt. */
function failsAndOffers(
  h: ReturnType<typeof sessionHarness>,
  chat: ReturnType<typeof hostChat>,
  prompt: string,
) {
  h.sockets[0].emit([refusal("Connection refused"), failed("r1")]);
  chat.invalidate();
  const cards = errorCards(treeOf(chat));
  expect(cards.map((c) => [c.text, c.sendAgain.length])).toEqual([["Connection refused", 1]]);
  resent.length = 0;
  (cards[0].sendAgain[0].props.onClick as () => void)();
  expect(resent).toEqual([prompt]);
}

describe("a control that is no command typed in the composer (fix round, decision 2)", () => {
  it("the header's playbook pick leaves a failed prompt its Send again", () => {
    const { h, key, chat } = promptRunning("Add a CSV export");
    const pick = appArrow<(dir: string | null) => boolean>("pickPlaybook", {
      noPlaybookFrame,
      setPlaybookFrame,
      sessionFrame: (frame: ClientMessage) => h.set.sendClient(key, frame),
    });
    expect(pick("/pb/team-x")).toBe(true);
    expect(pick(null)).toBe(true);
    expect(h.sockets[0].sent.slice(-2), "premise: both picks left").toEqual([
      setPlaybookFrame("/pb/team-x"),
      noPlaybookFrame(),
    ]);
    failsAndOffers(h, chat, "Add a CSV export");
    chat.unmount();
  });

  it("the loop chip's Stop leaves a failed prompt its Send again", () => {
    const { h, chat } = promptRunning("Check the build");
    h.sockets[0].emit([
      {
        type: "loop_info",
        active: true,
        loopId: "l1",
        pacing: "fixed",
        prompt: "Check the build",
        intervalSeconds: 300,
      },
    ] as unknown as RunEvent[]);
    chat.invalidate();
    const strip = treeOf(chat).find((el) => el.type === ComposerStrip);
    if (strip === undefined) throw new Error("the composer strip is not drawn");
    const stop = flatten(ComposerStrip(strip.props as Parameters<typeof ComposerStrip>[0])).find(
      (el) => el.type === "button" && el.props.className === "loop-chip-stop",
    );
    if (stop === undefined) throw new Error("the loop chip's Stop is not drawn");
    (stop.props.onClick as () => void)();
    expect(h.sockets[0].sent[h.sockets[0].sent.length - 1], "premise: the Stop left").toEqual({
      type: "set_loop",
      action: "stop",
    });
    failsAndOffers(h, chat, "Check the build");
    chat.unmount();
  });
});

// Every command of the shared list that the web chat runs, typed into the
// composer: when it sends a frame, the record carries the mark. The rows come
// from the core list, so a new command is driven here as soon as it is listed.
describe("every command typed in the composer marks the record when it sends a frame", () => {
  const rows = coreCommandRows().filter((r) => r.wired && r.surfaces !== "repl");
  const draftOf = (row: CommandRow): string => {
    const head = `/${row.name}${row.sub === null ? "" : ` ${row.sub}`}`;
    if (!row.takesArgs) return head;
    if (row.sub === "workflow") return `${head} fan look at the auth module`;
    if (row.sub === "use") return `${head} team-x`;
    return `${head} add a CSV export`;
  };
  const sentBy: Record<string, number> = {};

  for (const row of rows) {
    it(`${draftOf(row)}`, async () => {
      const h = sessionHarness();
      const chat = hostChat(() => liveChatView(h.set, resent));
      submit(chat, draftOf(row));
      await flush();
      sentBy[row.id] = h.sockets[0].sent.length;
      expect(resent, "a command is never a prompt").toEqual([]);
      if (h.sockets[0].sent.length > 0) expect(h.set.view().state.afterCommand).toBe(true);
      else expect(h.set.view().state.afterCommand).toBeUndefined();
      chat.unmount();
    });
  }

  it("/loop stop", () => {
    const h = sessionHarness();
    const chat = hostChat(() => liveChatView(h.set, resent));
    submit(chat, "/loop stop");
    expect(h.sockets[0].sent, "premise: the stop left").toEqual([{ type: "set_loop", action: "stop" }]);
    expect(h.set.view().state.afterCommand).toBe(true);
    chat.unmount();
  });

  it("positive: the commands that leave as frames were among them", () => {
    const sent = Object.entries(sentBy)
      .filter(([, n]) => n > 0)
      .map(([id]) => id);
    expect(sent).toEqual(
      expect.arrayContaining([
        "compact",
        "clear",
        "loop",
        "run-with-playbook",
        "playbook-use",
        "playbook-workflow",
      ]),
    );
  });
});

// Second review nit 3: with a translation showing, App folds the chat again
// from the translated events (the `view` memo), and that fold never saw a
// frame leave. On the live record it takes the record's marks.
describe("Send again while a translation shows", () => {
  /** App's own `view` memo, run with the given names in scope. */
  function appView(scope: Record<string, unknown>): UiState {
    const found: ts.VariableDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "view")
        found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(APP_FILE);
    expect(found, "const view in App").toHaveLength(1);
    const call = found[0].initializer;
    if (call === undefined || !ts.isCallExpression(call) || call.expression.getText(APP_FILE) !== "useMemo") {
      throw new Error("view is no useMemo");
    }
    const js = ts.transpile(`(${call.arguments[0].getText(APP_FILE)})`, { target: ts.ScriptTarget.ES2022 });
    const fold = new Function(...Object.keys(scope), `"use strict"; return ${js}`)(
      ...Object.values(scope),
    ) as () => UiState;
    return fold();
  }

  /** The record in view with the answer's words in German, as the translate sheet shows them. */
  function translated(h: ReturnType<typeof sessionHarness>): UiState {
    const live = h.set.view();
    const events = live.events.map((e) => (e.type === "text_delta" ? { ...e, text: "bereit" } : e));
    const view = appView({
      showingTranslation: true,
      enteredFleet: null,
      recordedView: live.state,
      replay: null,
      shownEvents: events,
      reduceAllUntraced,
      initialState,
      normalizeReplay,
      withCommandMarks,
    });
    expect(view.turns, "premise: the chat is the translated fold").toContainEqual(
      expect.objectContaining({ kind: "assistant", text: "bereit" }),
    );
    return view;
  }

  it("is not offered under the refusal of a typed command", () => {
    const h = sessionHarness();
    h.set.send(h.set.viewKey(), OLD);
    h.sockets[0].emit(ran(OLD, "r1"));
    const typing = hostChat(() => liveChatView(h.set, resent));
    submit(typing, "/run-with-playbook");
    h.sockets[0].emit([refusal(USAGE)]);
    typing.unmount();

    const view = translated(h);
    const chat = hostChat(() => ({ ...liveChatView(h.set, resent), state: view }));
    expect(errorCards(treeOf(chat))).toEqual([{ text: USAGE, sendAgain: [] }]);
    chat.unmount();
  });

  it("is offered under a failed prompt, and resends it", () => {
    const h = sessionHarness();
    h.set.send(h.set.viewKey(), OLD);
    h.sockets[0].emit([
      { type: "run_start", runId: "r1", agentId: "main", prompt: OLD, ts: 1 },
      { type: "text_delta", agentId: "main", text: "ready", ts: 2 },
      refusal("the provider is down"),
      failed("r1"),
    ] as RunEvent[]);

    const view = translated(h);
    const chat = hostChat(() => ({ ...liveChatView(h.set, resent), state: view }));
    const cards = errorCards(treeOf(chat));
    expect(cards.map((c) => [c.text, c.sendAgain.length])).toEqual([["the provider is down", 1]]);
    resent.length = 0;
    (cards[0].sendAgain[0].props.onClick as () => void)();
    expect(resent).toEqual([OLD]);
    chat.unmount();
  });
});
