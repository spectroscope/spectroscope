// Card 576, fix round (review finding 1): the Lab's chat offers no Send again
// under a refused command either.
//
// The Lab folds its own chat from the stream it steps, which never sees a
// frame leave, and its Chat is mounted anew on every tab switch. A command
// refused in the Chat tab therefore drew a Send again in the Lab, and the
// click resent the owner's old prompt. On the live run the Lab's chat now
// takes the record's marks.
//
// Scenario of the review: a live session whose last prompt is OLD, the
// command typed in the Chat tab, the refusal, then the Lab tab, stepped to
// the live end. LabView and its Chat run under HookHost, the sessions are a
// real SessionSet on fake sockets (testkit/chatHost.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { Chat } from "../components/Chat";
import { HookHost } from "../testkit/hookHost";
import { LabView } from "./LabView";
import { __getState, __resetForTests, seek } from "../state/stepper";
import { __resetCommandList, __setCommandRows } from "../state/commandList";
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
  type El,
} from "../testkit/chatHost";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => children,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children?: ReactNode }) => children,
  ViewportPortal: ({ children }: { children?: ReactNode }) => children,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
  useNodesState: () => [[], () => {}, () => {}],
  useEdgesState: () => [[], () => {}, () => {}],
  getSmoothStepPath: () => ["M0,0 L1,1", 0, 0],
}));

const OLD = "Reply with the single word ready.";
const USAGE = "Usage: /run-with-playbook <prompt>, for example /run-with-playbook add a CSV export";

const ran = (prompt: string, runId: string): RunEvent[] =>
  [
    { type: "run_start", runId, agentId: "main", prompt, ts: 1 },
    { type: "text_delta", agentId: "main", text: "ready", ts: 2 },
    { type: "run_end", runId, stopReason: "end_turn", ts: 3 },
  ] as RunEvent[];
const refusal = (message: string): RunEvent => ({ type: "error", message, ts: 4 }) as RunEvent;

let resent: string[] = [];

beforeEach(() => {
  resent = [];
  __resetForTests();
  __setCommandRows(coreCommandRows());
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCommandList();
  __resetForTests();
});

describe("the record's turns reach the Lab", () => {
  it("App hands the Lab the whole live record as liveStatus, on the live run only", () => {
    const app = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app.match(/liveStatus=\{viewingLive \? live : null\}/g) ?? []).toHaveLength(1);
  });
});

describe("the Lab's chat after a command refused in the Chat tab", () => {
  it("offers no Send again under the refusal at the live end", () => {
    const h = sessionHarness();
    const key = h.set.viewKey();
    h.set.send(key, OLD);
    h.sockets[0].emit(ran(OLD, "r1"));

    // The Chat tab.
    const chat = hostChat(() => liveChatView(h.set, resent));
    submit(chat, "/run-with-playbook");
    // The refusal, and a frame after it that the Lab can still hold back.
    h.sockets[0].emit([refusal(USAGE), { type: "permission_mode_info", mode: "ask" } as unknown as RunEvent]);
    chat.invalidate();
    expect(errorCards(treeOf(chat)), "premise: no Send again in the Chat tab").toEqual([
      { text: USAGE, sendAgain: [] },
    ]);
    chat.unmount();

    // The Lab tab, with the props App gives it on the live run.
    const lab = new HookHost(() => {
      const live = h.set.view();
      const tree = flatten(
        LabView({
          replay: null,
          liveEvents: live.events,
          running: live.state.running,
          onSend: (text) => {
            resent.push(text);
            h.set.send(key, text);
          },
          onReturnToLive: () => {},
          sendClient: (frame) => h.set.sendClient(key, frame),
          onSessionFrame: (frame) => h.set.sendClient(key, frame),
          liveStatus: live.state,
        }) as ReactNode,
      );
      const labChat = tree.find((el) => el.type === Chat) as El | undefined;
      if (labChat === undefined) throw new Error("the Lab's chat is not drawn");
      return Chat(labChat.props as Parameters<typeof Chat>[0]);
    });
    const total = __getState().queue.length + __getState().applied.length;
    expect(total, "premise: the Lab holds the live stream").toBe(h.set.view().events.length);

    // Stepped to the refusal, one frame still held back.
    seek(total - 1);
    lab.invalidate();
    expect(__getState().queue, "premise: one frame still waits").toHaveLength(1);
    expect(errorCards(flatten(lab.value as ReactNode)), "no resend while stepping").toEqual([
      { text: USAGE, sendAgain: [] },
    ]);

    // At the live end.
    seek(total);
    lab.invalidate();
    expect(__getState().queue, "premise: the Lab is at the live end").toEqual([]);
    const tree = flatten(lab.value as ReactNode);
    expect(errorCards(tree), "the refusal, without a resend of the old prompt").toEqual([
      { text: USAGE, sendAgain: [] },
    ]);
    expect(sendAgainButtons(tree)).toEqual([]);
    expect(resent).toEqual([]);
    lab.unmount();
  });

  it("still offers Send again under a prompt that failed, and resends it", () => {
    const h = sessionHarness();
    const key = h.set.viewKey();
    h.set.send(key, OLD);
    h.sockets[0].emit([
      { type: "run_start", runId: "r1", agentId: "main", prompt: OLD, ts: 1 },
      refusal("the provider is down"),
      { type: "run_end", runId: "r1", stopReason: "error", ts: 3 },
    ] as RunEvent[]);
    const lab = new HookHost(() => {
      const live = h.set.view();
      const tree = flatten(
        LabView({
          replay: null,
          liveEvents: live.events,
          running: live.state.running,
          onSend: (text) => {
            resent.push(text);
            h.set.send(key, text);
          },
          onReturnToLive: () => {},
          sendClient: (frame) => h.set.sendClient(key, frame),
          liveStatus: live.state,
        }) as ReactNode,
      );
      const labChat = tree.find((el) => el.type === Chat) as El | undefined;
      if (labChat === undefined) throw new Error("the Lab's chat is not drawn");
      return Chat(labChat.props as Parameters<typeof Chat>[0]);
    });
    seek(__getState().queue.length);
    lab.invalidate();
    const cards = errorCards(flatten(lab.value as ReactNode));
    expect(cards.map((c) => [c.text, c.sendAgain.length])).toEqual([["the provider is down", 1]]);
    resent.length = 0;
    (cards[0].sendAgain[0].props.onClick as () => void)();
    expect(resent).toEqual([OLD]);
    lab.unmount();
  });
});
