// Card 586: a press on a run's card shows its place in the chat.
//
// The Chat runs under HookHost (testkit/chatHost.ts), so its effects run as in
// the window. There is no DOM: the test hands the chat's scroll box a stand-in
// with querySelector and scrollTo, and the target a stand-in with
// scrollIntoView and a class list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { ChatV2 } from "./ChatV2";
import { __resetChatFocusForTests, requestChatFocus } from "../state/chatFocus";
import { chatProps, hostChat, liveChatView, sessionHarness, stubBrowser, treeOf } from "../testkit/chatHost";
import { HookHost } from "../testkit/hookHost";
import { flatten, type El } from "../testkit/chatHost";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const RUN = "abcdefabcdef";
const KEY = `${RUN}:brainstorm:1`;
const runStep = (fields: Record<string, unknown>): RunEvent =>
  ({
    type: "run_step",
    agentId: "playbook",
    runId: RUN,
    runKind: "playbook",
    ...fields,
  }) as unknown as RunEvent;

/** A playbook run whose chat step has sent its prompt, and a helper that wrote a line. */
const RUN_EVENTS: RunEvent[] = [
  runStep({
    phase: "run_start",
    name: "spectro",
    task: "add a CSV export",
    nodes: [{ id: "brainstorm", name: "Brainstorm", kind: "step" }],
    ts: 1,
  }),
  runStep({
    phase: "step_start",
    node: "brainstorm",
    name: "Brainstorm",
    kind: "step",
    entry: 1,
    performer: "chat",
    ts: 2,
  }),
  {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "Brainstorm the task",
    origin: "playbook",
    ts: 3,
  } as RunEvent,
  { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "look around", ts: 4 } as RunEvent,
  { type: "text_delta", agentId: "worker-1", text: "found it", ts: 5 } as RunEvent,
];

/** A stand-in for one element the chat can find. */
function target() {
  const classes = new Set<string>();
  return {
    classes,
    scrollIntoView: vi.fn(),
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
  };
}

/** The chat's scroll box: it finds `found` for the one selector it is given. */
function box(found: Record<string, ReturnType<typeof target>>) {
  return {
    asked: [] as string[],
    scrollTo: vi.fn(),
    scrollHeight: 2000,
    scrollTop: 0,
    clientHeight: 600,
    querySelector(selector: string) {
      this.asked.push(selector);
      return found[selector] ?? null;
    },
  };
}

function attach(tree: El[], stand: ReturnType<typeof box>): void {
  const scroll = tree.find((el) => el.props.className === "chat-scroll");
  if (scroll === undefined) throw new Error("the scroll box is not drawn");
  (scroll.props.ref as { current: unknown }).current = stand;
}

beforeEach(() => {
  __resetChatFocusForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  stubBrowser();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the chat marks the places a run can jump to (card 586)", () => {
  it("a chat step's prompt carries its run entry, a helper's thread head its agent", () => {
    const h = sessionHarness();
    h.sockets[0].emit(RUN_EVENTS);
    const chat = hostChat(() => liveChatView(h.set, []));
    const tree = treeOf(chat);
    const turn = tree.find((el) => el.props["data-run-entry"] !== undefined);
    expect(turn?.props["data-run-entry"]).toBe(KEY);
    expect(String(turn?.props.className)).toContain("user-turn");
    const head = tree.find((el) => el.props["data-agent-thread"] !== undefined);
    expect(head?.props["data-agent-thread"]).toBe("worker-1");
    expect(head?.props.className).toBe("chat-thread-head");
    chat.unmount();
  });

  it("a typed prompt carries no run entry", () => {
    const h = sessionHarness();
    h.sockets[0].emit([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hello", ts: 1 } as RunEvent,
    ]);
    const chat = hostChat(() => liveChatView(h.set, []));
    expect(treeOf(chat).filter((el) => el.props["data-run-entry"] !== undefined)).toEqual([]);
    expect(treeOf(chat).some((el) => String(el.props.className).includes("user-turn"))).toBe(true);
    chat.unmount();
  });

  it("v2: the chip of a helper carries its agent", () => {
    const h = sessionHarness();
    const host = new HookHost(() => ChatV2({ ...chatProps(liveChatView(h.set, [])), work: [] }));
    const v2 = host.value as El;
    const chip = (v2.props.renderChip as (ids: string[], i: number, f: unknown) => El)(["worker-1"], 0, {
      isOpen: () => false,
      toggle: () => {},
    });
    const pairs = flatten(chip).filter((el) => el.props["data-agent-thread"] !== undefined);
    expect(pairs.map((el) => el.props["data-agent-thread"])).toEqual(["worker-1"]);
    host.unmount();
  });
});

describe("a focus request scrolls the chat to the place and marks it (card 586)", () => {
  it("an entry: scrolls it to the middle, marks it for two seconds and lets the stream go on without dragging the reader down", () => {
    const h = sessionHarness();
    h.sockets[0].emit(RUN_EVENTS);
    const chat = hostChat(() => liveChatView(h.set, []));
    const turn = target();
    const stand = box({ [`[data-run-entry="${KEY}"]`]: turn });
    attach(treeOf(chat), stand);

    h.sockets[0].emit([{ type: "text_delta", agentId: "main", text: "thinking", ts: 6 } as RunEvent]);
    chat.invalidate();
    expect(stand.scrollTo, "premise: a live reader follows the stream").toHaveBeenCalled();

    requestChatFocus({ kind: "entry", key: KEY });
    chat.invalidate();
    expect(stand.asked).toContain(`[data-run-entry="${KEY}"]`);
    expect(turn.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect([...turn.classes]).toEqual(["chat-focus"]);

    stand.scrollTo.mockClear();
    h.sockets[0].emit([{ type: "text_delta", agentId: "main", text: " more", ts: 7 } as RunEvent]);
    chat.invalidate();
    expect(stand.scrollTo, "the pin is released: the reader stays on the entry").not.toHaveBeenCalled();

    vi.advanceTimersByTime(1999);
    expect([...turn.classes]).toEqual(["chat-focus"]);
    vi.advanceTimersByTime(1);
    expect([...turn.classes]).toEqual([]);
    chat.unmount();
  });

  it("an agent: finds its thread, and the same target pressed again jumps again", () => {
    const h = sessionHarness();
    h.sockets[0].emit(RUN_EVENTS);
    const chat = hostChat(() => liveChatView(h.set, []));
    const head = target();
    const stand = box({ ['[data-agent-thread="worker-1"]']: head });
    attach(treeOf(chat), stand);

    requestChatFocus({ kind: "agent", agentId: "worker-1" });
    chat.invalidate();
    requestChatFocus({ kind: "agent", agentId: "worker-1" });
    chat.invalidate();
    expect(head.scrollIntoView).toHaveBeenCalledTimes(2);
    expect([...head.classes]).toEqual(["chat-focus"]);
    chat.unmount();
  });

  it("a place the chat does not hold changes nothing", () => {
    const h = sessionHarness();
    h.sockets[0].emit(RUN_EVENTS);
    const chat = hostChat(() => liveChatView(h.set, []));
    const stand = box({});
    attach(treeOf(chat), stand);
    requestChatFocus({ kind: "entry", key: `${RUN}:ship:1` });
    chat.invalidate();
    expect(stand.asked).toEqual([`[data-run-entry="${RUN}:ship:1"]`]);
    stand.scrollTo.mockClear();
    h.sockets[0].emit([{ type: "text_delta", agentId: "main", text: "x", ts: 8 } as RunEvent]);
    chat.invalidate();
    expect(stand.scrollTo, "the pin stays: nothing was shown").toHaveBeenCalled();
    chat.unmount();
  });

  it("quotes a target that holds a quote or a backslash", () => {
    const h = sessionHarness();
    h.sockets[0].emit(RUN_EVENTS);
    const chat = hostChat(() => liveChatView(h.set, []));
    const stand = box({});
    attach(treeOf(chat), stand);
    requestChatFocus({ kind: "agent", agentId: 'a"b\\c' });
    chat.invalidate();
    expect(stand.asked).toEqual(['[data-agent-thread="a\\"b\\\\c"]']);
    chat.unmount();
  });
});

// Card 586, final fix round (review I1): the request is kept after it was
// shown, and a chat that reads it later (it mounted again when the operator
// came back to the chat tab) must not jump again or drop the live pin. Two
// chats on the same request stand for the earlier and the later mount.
describe("a focus request is shown once (card 586, review I1)", () => {
  it("a chat that reads a request another chat showed neither jumps nor unpins", () => {
    const h = sessionHarness();
    h.sockets[0].emit(RUN_EVENTS);
    const first = hostChat(() => liveChatView(h.set, []));
    const later = hostChat(() => liveChatView(h.set, []));
    const shownFirst = target();
    const shownLater = target();
    const boxFirst = box({ [`[data-run-entry="${KEY}"]`]: shownFirst });
    const boxLater = box({ [`[data-run-entry="${KEY}"]`]: shownLater });
    attach(treeOf(first), boxFirst);
    attach(treeOf(later), boxLater);

    requestChatFocus({ kind: "entry", key: KEY });
    first.invalidate();
    expect(shownFirst.scrollIntoView, "premise: the first chat shows it").toHaveBeenCalledTimes(1);
    later.invalidate();
    expect(shownLater.scrollIntoView).not.toHaveBeenCalled();
    expect([...shownLater.classes]).toEqual([]);

    boxLater.scrollTo.mockClear();
    h.sockets[0].emit([{ type: "text_delta", agentId: "main", text: "on", ts: 9 } as RunEvent]);
    later.invalidate();
    expect(boxLater.scrollTo, "the later chat still follows the stream").toHaveBeenCalled();
    first.unmount();
    later.unmount();
  });
});
