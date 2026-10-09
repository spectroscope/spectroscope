// Card 471: a command leaves the page as its own frame.
//
// /compact and /clear are sent by the session set straight to the record's
// socket. Never as a user_message (it would reach the model as a prompt),
// never as a steering_message during a run (same), never into the queue (a
// command answered after the run would act on a history the reader has
// already moved past). During a run the frame still goes out and the server
// answers with the user_message refusal.

import { beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { SessionSet } from "./sessionSet";

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
  const set = new SessionSet({
    connect,
    mode: () => "learn",
    traceWanted: () => true,
    onBatch: () => {},
  });
  return { set, sockets };
}

const runStart = (): RunEvent =>
  ({ type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts: 1 }) as RunEvent;

const types = (sent: ClientMessage[]): string[] => sent.map((m) => m.type);

describe("a command from the composer", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.set.start();
    h.set.activate();
  });

  it("goes out as clear_context on an idle socket, and as nothing else", () => {
    h.sockets[0].status("open");

    expect(h.set.command(h.set.view().key, "clear")).toBe(true);

    expect(h.sockets[0].sent).toEqual([{ type: "clear_context" }]);
    expect(h.set.view().queue).toEqual([]);
  });

  it("goes out as compact_context", () => {
    h.sockets[0].status("open");

    h.set.command(h.set.view().key, "compact");

    expect(h.sockets[0].sent).toEqual([{ type: "compact_context" }]);
  });

  it("is neither steered nor queued during a run; the server answers it", () => {
    h.sockets[0].status("open");
    h.sockets[0].emit([runStart()]);
    expect(h.set.view().state.running, "premise: a run is on").toBe(true);

    h.set.command(h.set.view().key, "clear");

    expect(types(h.sockets[0].sent)).toEqual(["clear_context"]);
    expect(h.set.view().queue).toEqual([]);
  });

  it("reports a socket that is not open, and keeps nothing for later", () => {
    expect(h.set.command(h.set.view().key, "clear")).toBe(false);

    h.sockets[0].status("open");

    expect(h.sockets[0].sent).toEqual([]);
    expect(h.set.view().queue).toEqual([]);
  });

  it("can be the first thing a continued session sends, once its socket opens", () => {
    const key = h.set.open({ resumeId: "20261009-120000-abcd", firstCommand: "clear" });
    const socket = h.sockets[h.sockets.length - 1];
    expect(socket.resume).toBe("20261009-120000-abcd");
    expect(socket.sent).toEqual([]);

    socket.status("open");

    expect(socket.sent).toEqual([{ type: "clear_context" }]);
    socket.status("closed");
    socket.status("open");
    expect(socket.sent, "sent once, not on every reconnect").toEqual([{ type: "clear_context" }]);
    expect(h.set.view().key).toBe(key);
  });
});
