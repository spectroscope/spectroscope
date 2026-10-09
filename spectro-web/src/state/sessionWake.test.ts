// Card 498: the record a wake opens.
//
// A click into the message box of a stored session opens a record beside the
// others, out of view, on a plain socket that sends wake_session once it is
// open. The rail does not list it as held; the first message adopts it, with
// the history the resume folds and the frames its socket already brought.

import { beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { SessionSet } from "./sessionSet";
import { initialState } from "./reducer";

interface FakeSocket {
  resume: string | undefined;
  sent: ClientMessage[];
  closed: boolean;
  open: boolean;
  emit(events: RunEvent[]): void;
  status(status: ConnectionStatus): void;
}

function harness() {
  const sockets: FakeSocket[] = [];
  const connect = (options: ConnectOptions): Connection => {
    const socket: FakeSocket = {
      resume: options.resume,
      sent: [],
      closed: false,
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
  const set = new SessionSet({ connect, mode: () => "learn", traceWanted: () => true, onBatch: () => {} });
  return { set, sockets };
}

const ID = "20261009-210000-w498";
const answer = (): RunEvent =>
  ({
    type: "workspace_info",
    resolved: true,
    mode: "recorded",
    configured: false,
    exists: true,
    sessionId: ID,
    path: "/work/ForgeDemo",
  }) as unknown as RunEvent;

describe("a wake", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
  });

  it("opens a record out of view on a plain socket and sends wake_session once it is open", () => {
    const inView = h.set.viewKey();
    const key = h.set.open({ wake: ID });

    expect(h.set.viewKey()).toBe(inView);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].resume).toBeUndefined();
    expect(h.sockets[1].sent).toEqual([]);

    h.sockets[1].status("open");

    expect(h.sockets[1].sent).toEqual([{ type: "wake_session", sessionId: ID }]);
    expect(h.set.get(key)?.woken).toBe(true);
    expect(h.sockets[0].sent).toEqual([]);
  });

  it("sends the frame once, not again on a reconnect", () => {
    h.set.open({ wake: ID });
    h.sockets[1].status("open");
    h.sockets[1].status("closed");
    h.sockets[1].status("open");
    expect(h.sockets[1].sent).toEqual([{ type: "wake_session", sessionId: ID }]);
  });

  it("is found by its session id, and the rail does not list it as held", () => {
    const key = h.set.open({ wake: ID });
    h.sockets[1].status("open");
    h.sockets[1].emit([answer()]);

    expect(h.set.findBySession(ID)?.key).toBe(key);
    expect(h.set.get(key)?.state.workspace?.sessionId).toBe(ID);
    expect(h.set.heldRows().map((row) => row.id)).not.toContain(ID);
  });

  it("is adopted by the first message: history, the frames it already had, the message, and it comes into view", () => {
    const key = h.set.open({ wake: ID });
    h.sockets[1].status("open");
    h.sockets[1].emit([answer()]);
    const history = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "ALPHA", ts: 1 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2 },
    ] as unknown as RunEvent[];

    h.set.continueWoken(key, { state: initialState, events: history, firstMessage: { text: "ZETA next" } });

    const slot = h.set.get(key)!;
    expect(h.set.viewKey()).toBe(key);
    expect(slot.woken).toBe(false);
    expect(slot.resumeId).toBe(ID);
    expect(slot.events.map((e) => (e as { type: string }).type)).toEqual([
      "run_start",
      "run_end",
      "workspace_info",
    ]);
    expect(slot.state.workspace?.sessionId).toBe(ID);
    expect(h.sockets[1].sent).toEqual([
      { type: "wake_session", sessionId: ID },
      { type: "user_message", text: "ZETA next" },
    ]);
    expect(h.sockets).toHaveLength(2);
    expect(h.set.heldRows().map((row) => row.id)).toContain(ID);
  });

  it("drops its record when the server says another socket holds the session", () => {
    const inView = h.set.viewKey();
    const key = h.set.open({ wake: ID });
    h.sockets[1].status("open");
    h.sockets[1].emit([{ type: "session_busy", sessionId: ID } as unknown as RunEvent]);

    expect(h.set.get(key)).toBeUndefined();
    expect(h.sockets[1].closed).toBe(true);
    expect(h.set.viewKey()).toBe(inView);
  });

  it("closing it leaves the view where it was", () => {
    const inView = h.set.viewKey();
    const key = h.set.open({ wake: ID });
    h.set.close(key);
    expect(h.set.viewKey()).toBe(inView);
    expect(h.sockets[1].closed).toBe(true);
  });
});
