// The Chat as App drives it, without a DOM (card 576).
//
// A test file mocks "react" with fakeHooks (testkit/hookHost.ts), so the Chat
// runs under HookHost and its effects run as in the window. The sessions are a
// real SessionSet on fake sockets; a test emits server frames on a socket and
// reads what the window sent. Helpers here type into the composer's own field,
// press its Send button and read the error cards a pass draws.
//
// Test-only by construction: nothing under src/ imports this module except
// *.test.* files, so it never reaches the shipped bundle.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { Chat } from "../components/Chat";
import type { ChatCommandName } from "../state/chatCommands";
import type { UiState } from "../state/reducer";
import { SessionSet } from "../state/sessionSet";
import { t } from "../i18n/i18n";
import { HookHost } from "./hookHost";

export type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Every element of a pass, outermost first; components are not expanded. */
export function flatten(node: ReactNode): El[] {
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child as ReactNode);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as El;
    out.push(el);
    walk(el.props.children);
  };
  walk(node);
  return out;
}

export interface FakeSocket {
  sent: ClientMessage[];
  open: boolean;
  emit(events: RunEvent[]): void;
  status(status: ConnectionStatus): void;
}

/** A started SessionSet whose first record's socket is open. */
export function sessionHarness(): { set: SessionSet; sockets: FakeSocket[] } {
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
  const set = new SessionSet({ connect, mode: () => "learn", traceWanted: () => true, onBatch: () => {} });
  set.start();
  set.activate();
  sockets[0].status("open");
  return { set, sockets };
}

/** The globals the Chat's effects reach in a window. */
export function stubBrowser(): void {
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      setTimeout: (task: () => void, ms: number) => setTimeout(task, ms),
      clearTimeout: (id: number) => clearTimeout(id),
      innerWidth: 1400,
      innerHeight: 900,
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    }),
  );
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

/** What App hands the Chat for a view: the state, the key and the senders. */
export interface ChatView {
  state: UiState;
  viewKey: string;
  liveView: boolean;
  onSend: (text: string) => void;
  /** App's command: /compact and /clear. */
  onCommand: (name: ChatCommandName) => boolean;
  /** App's sessionFrame: the session's own route. */
  sessionFrame: (frame: ClientMessage) => boolean;
  /** App's sendClient: the socket in view. */
  sendClient: (frame: ClientMessage) => boolean;
}

/**
 * The live record in view, wired the way App wires it.
 *
 * @param set    the sessions
 * @param resent receives every text the Chat sends as a prompt
 */
export function liveChatView(set: SessionSet, resent: string[]): ChatView {
  const slot = set.view();
  const key = slot.key;
  return {
    state: slot.state,
    viewKey: `live:${key}`,
    liveView: true,
    onSend: (text) => {
      resent.push(text);
      set.send(key, text);
    },
    onCommand: (name) => set.command(key, name),
    sessionFrame: (frame) => set.sendClient(key, frame),
    sendClient: (frame) => set.sendClient(set.viewKey(), frame),
  };
}

/** The props App gives the main chat for a view. */
export function chatProps(v: ChatView): Parameters<typeof Chat>[0] {
  return {
    state: v.state,
    viewKey: v.viewKey,
    liveView: v.liveView,
    continuable: !v.liveView,
    onSend: v.onSend,
    onCommand: v.onCommand,
    onSessionFrame: v.sessionFrame,
    onBindSessionFrame: () => v.sessionFrame,
    onLocalLine: () => {},
    commandWorkspace: "/ws",
    onReturnToLive: () => {},
    sendClient: v.sendClient,
  };
}

/** The main chat, rendered again for whatever view `view` names at each pass. */
export function hostChat(view: () => ChatView): HookHost<unknown> {
  return new HookHost(() => Chat(chatProps(view())));
}

export function treeOf(h: HookHost<unknown>): El[] {
  return flatten(h.value as ReactNode);
}

/** Types the draft into the composer's field and presses its Send button. */
export function submit(h: HookHost<unknown>, draft: string): void {
  const field = treeOf(h).find((el) => el.type === "textarea");
  if (field === undefined) throw new Error("the composer field is not drawn");
  (field.props.onChange as (e: { target: { value: string; selectionStart: number } }) => void)({
    target: { value: draft, selectionStart: draft.length },
  });
  const send = treeOf(h).find(
    (el) => el.type === "button" && String(el.props.className).includes("composer-seat--send"),
  );
  if (send === undefined) throw new Error("the send button is not drawn");
  (send.props.onClick as () => void)();
}

const isSendAgain = (el: El): boolean =>
  el.type === "button" && el.props.children === t("en", "chat.sendAgain");

/** Every "Send again" button of a pass. */
export function sendAgainButtons(tree: El[]): El[] {
  return tree.filter(isSendAgain);
}

/** Every error card of a pass, with its text and its "Send again" buttons. */
export function errorCards(tree: El[]): { text: string; sendAgain: El[] }[] {
  return tree
    .filter((el) => el.props.className === "error-card")
    .map((card) => {
      const inner = flatten(card.props.children);
      const text = inner.find((el) => el.props.className === "error-text")?.props.children;
      return { text: String(text), sendAgain: inner.filter(isSendAgain) };
    });
}
