// Card 504, hub and spoke review round 2: a stored session the gear changes
// twice before its resume has fetched holds every frame, not only the last,
// and each frame that reaches the wire is heard by onSent, which carries the
// leveling beacons (the gear's set_permission_mode leaves through the drain,
// which App's sendClient wrapper never sees).

import { beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { initialState } from "./reducer";
import { SessionSet } from "./sessionSet";

interface FakeSocket {
  sent: ClientMessage[];
  open: boolean;
  closed: boolean;
  emit(events: RunEvent[]): void;
  status(status: ConnectionStatus): void;
}

function harness() {
  const sockets: FakeSocket[] = [];
  const heard: { key: string; msg: ClientMessage }[] = [];
  const connect = (options: ConnectOptions): Connection => {
    const socket: FakeSocket = {
      sent: [],
      open: false,
      closed: false,
      emit: (events) => options.onEvents(events),
      status: (status) => {
        socket.open = status === "open";
        options.onStatus?.(status);
      },
    };
    sockets.push(socket);
    return {
      send: (msg) => {
        if (!socket.open || socket.closed) return false;
        socket.sent.push(msg);
        return true;
      },
      reconnectNow: () => {},
      close: () => {
        socket.closed = true;
        socket.open = false;
      },
    };
  };
  const set = new SessionSet({
    connect,
    mode: () => "learn",
    traceWanted: () => true,
    onBatch: () => {},
    onSent: (key, msg) => void heard.push({ key, msg }),
  });
  set.start();
  set.activate();
  return { set, sockets, heard };
}

const MODE: ClientMessage = { type: "set_permission_mode", mode: "auto" };
const GROUPS: ClientMessage = { type: "set_tool_groups_off", groups: ["web"], save: false };

describe("the frames a continued session holds", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("every frame leaves in order, once, on its own socket", () => {
    h.set.open({ resumeId: "20261012-090000-abcd", firstFrames: [MODE, GROUPS] });
    const socket = h.sockets[h.sockets.length - 1];
    expect(socket.sent).toEqual([]);

    socket.status("open");

    expect(socket.sent).toEqual([MODE, GROUPS]);
    socket.status("closed");
    socket.status("open");
    expect(socket.sent, "sent once, not on every reconnect").toEqual([MODE, GROUPS]);
  });

  it("the frames go before the first message", () => {
    h.set.open({
      resumeId: "20261012-090000-abcd",
      firstFrames: [MODE],
      firstMessage: { text: "go on" },
    });
    const socket = h.sockets[h.sockets.length - 1];
    socket.status("open");
    expect(socket.sent).toEqual([MODE, { type: "user_message", text: "go on" }]);
  });

  it("a woken session takes every frame the composer queued", () => {
    h.sockets[0].status("open");
    const key = h.set.open({ wake: "20261012-090000-abcd" });
    h.sockets[1].status("open");

    h.set.continueWoken(key, { state: initialState, events: [], firstFrames: [MODE, GROUPS] });

    expect(h.sockets[1].sent).toEqual([
      { type: "wake_session", sessionId: "20261012-090000-abcd" },
      { type: "get_session_items" },
      MODE,
      GROUPS,
    ]);
    expect(h.sockets[0].sent).toEqual([]);
  });

  // Card 556: a model picked in a stored session is a frame of that session.
  // It reaches the socket the wake holds, before the first message, so the
  // run that message starts names the picked pair; the record in view, which
  // holds another session, hears nothing.
  it("a woken session takes the model switch before its first message", () => {
    const SWITCH: ClientMessage = { type: "set_provider", provider: "ollama", model: "qwen3" };
    h.sockets[0].status("open");
    const key = h.set.open({ wake: "20261012-090000-abcd" });
    h.sockets[1].status("open");

    h.set.continueWoken(key, {
      state: initialState,
      events: [],
      firstFrames: [SWITCH],
      firstMessage: { text: "go on" },
    });

    expect(h.sockets[1].sent).toEqual([
      { type: "wake_session", sessionId: "20261012-090000-abcd" },
      { type: "get_session_items" },
      SWITCH,
      { type: "user_message", text: "go on" },
    ]);
    expect(h.sockets[0].sent, "the record in view holds another session").toEqual([]);
  });
});

describe("onSent", () => {
  it("hears a frame the drain sends, as it hears a direct send", () => {
    const h = harness();
    const key = h.set.open({ resumeId: "20261012-090000-abcd", firstFrames: [MODE] });
    expect(h.heard, "nothing before the socket is open").toEqual([]);

    h.sockets[h.sockets.length - 1].status("open");
    expect(h.heard).toEqual([{ key, msg: MODE }]);

    h.set.sendClient(key, GROUPS);
    expect(h.heard).toEqual([
      { key, msg: MODE },
      { key, msg: GROUPS },
    ]);
  });

  it("does not hear a frame that did not reach the wire", () => {
    const h = harness();
    const key = h.set.view().key;
    expect(h.set.sendClient(key, MODE)).toBe(false);
    expect(h.heard).toEqual([]);
  });
});
