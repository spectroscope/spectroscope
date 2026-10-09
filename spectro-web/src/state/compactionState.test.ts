// Card 471, review round: a /compact the reader can see and stop.
//
// The summary is a model call, and on a slow local backend it takes as long as
// one. The server opens it with a socket-only compaction_state frame (active
// true) and closes it with one that names the outcome. In between the page is
// running: the stop button is in the seat, a sentence typed meanwhile waits in
// the queue instead of steering a run that does not exist, and it goes out
// once the compaction has ended. The outcomes that changed nothing are lines in
// the reader's language, never an error card with a "Send again" under it.

import { beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { initialState, reduce, type UiState } from "./reducer";
import { SessionSet } from "./sessionSet";
import { t } from "../i18n/i18n";

const state = (active: boolean, outcome?: string, message?: string): RunEvent =>
  ({
    type: "compaction_state",
    active,
    ...(outcome === undefined ? {} : { outcome }),
    ...(message === undefined ? {} : { message }),
    ts: 1,
  }) as unknown as RunEvent;

function lastTurn(s: UiState) {
  return s.turns[s.turns.length - 1];
}

describe("a compaction_state frame in the reducer", () => {
  it("opens a compaction: the page is running and says what it is doing", () => {
    const s = reduce(initialState, state(true));

    expect(s.running).toBe(true);
    expect(s.compacting).toBe(true);
    const line = lastTurn(s);
    expect(line.kind).toBe("info");
    if (line.kind !== "info") return;
    expect(line.infoKey).toBe("chat.compacting");
  });

  it("closes it: running ends, and a compacted history adds no second line", () => {
    const open = reduce(initialState, state(true));
    const compacted = reduce(open, {
      type: "compaction",
      agentId: "main",
      removedTurns: 4,
      summaryChars: 50,
      ts: 2,
    } as RunEvent);
    const s = reduce(compacted, state(false, "compacted"));

    expect(s.running).toBe(false);
    expect(s.compacting).toBe(false);
    // Round three: the "Compacting the history" line goes with the compaction,
    // and the compacted history adds no line of its own.
    expect(s.turns).toEqual(
      compacted.turns.filter((turn) => !(turn.kind === "info" && turn.infoKey === "chat.compacting")),
    );
  });

  // Round three: the line that says a compaction is running leaves when it
  // ends, so the live view reads like a replay, which never had the line.
  it.each(["compacted", "nothing_to_compact", "stopped", "failed"])(
    "removes the compacting line when the compaction ends with %s",
    (outcome) => {
      const open = reduce(initialState, state(true));
      expect(
        open.turns.some((turn) => turn.kind === "info" && turn.infoKey === "chat.compacting"),
        "premise: the line is there while it runs",
      ).toBe(true);

      const s = reduce(open, state(false, outcome, "backend down"));

      expect(s.turns.some((turn) => turn.kind === "info" && turn.infoKey === "chat.compacting")).toBe(false);
    },
  );

  it.each([
    ["nothing_to_compact", "chat.compactNothing"],
    ["stopped", "chat.compactStopped"],
    ["failed", "chat.compactFailed"],
  ])("ends with %s as a line, never as an error card", (outcome, key) => {
    const s = reduce(reduce(initialState, state(true)), state(false, outcome, "backend down"));

    expect(s.running).toBe(false);
    expect(s.turns.some((turn) => turn.kind === "error")).toBe(false);
    const line = lastTurn(s);
    expect(line.kind).toBe("info");
    if (line.kind !== "info") return;
    expect(line.infoKey).toBe(key);
  });

  it("names the failure in the line", () => {
    const s = reduce(reduce(initialState, state(true)), state(false, "failed", "backend down"));
    const line = lastTurn(s);
    if (line.kind !== "info") throw new Error("not a line");

    expect(t("en", line.infoKey ?? "", line.infoVars)).toBe(
      "Compaction failed, the history is unchanged: backend down",
    );
  });

  it("words every outcome in English and in German", () => {
    for (const key of [
      "chat.compacting",
      "chat.compactNothing",
      "chat.compactStopped",
      "chat.compactFailed",
    ]) {
      const en = t("en", key, { message: "m" });
      const de = t("de", key, { message: "m" });
      expect(en, key).not.toBe(key);
      expect(de, key).not.toBe(key);
      expect(de, key).not.toBe(en);
    }
  });

  it("does not end a real run that is under way", () => {
    const run = reduce(initialState, {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "go",
      ts: 1,
    } as RunEvent);

    expect(reduce(run, state(false, "nothing_to_compact")).running).toBe(true);
  });
});

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
  const set = new SessionSet({ connect, mode: () => "learn", traceWanted: () => true, onBatch: () => {} });
  return { set, sockets };
}

describe("a sentence typed while the history is being compacted", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
  });

  it("premise: during a real run the same sentence steers", () => {
    h.sockets[0].emit([{ type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 } as RunEvent]);

    h.set.send(h.set.view().key, "and also this");

    expect(h.sockets[0].sent.map((m) => m.type)).toEqual(["steering_message"]);
  });

  it("waits in the queue, then goes out as the next prompt once the compaction ends", () => {
    h.sockets[0].emit([state(true)]);
    expect(h.set.view().state.running, "premise: the page is running").toBe(true);

    h.set.send(h.set.view().key, "and also this");

    expect(h.sockets[0].sent, "neither steered nor sent").toEqual([]);
    expect(h.set.view().queue.map((q) => q.text)).toEqual(["and also this"]);

    h.sockets[0].emit([state(false, "stopped")]);

    expect(h.sockets[0].sent).toEqual([{ type: "user_message", text: "and also this" }]);
    expect(h.set.view().queue).toEqual([]);
  });

  it("the stop button reaches the server during a compaction", () => {
    h.sockets[0].emit([state(true)]);

    h.set.abort(h.set.view().key);

    expect(h.sockets[0].sent).toEqual([{ type: "abort" }]);
    expect(h.set.view().stopRequested).toBe(true);
  });
});
