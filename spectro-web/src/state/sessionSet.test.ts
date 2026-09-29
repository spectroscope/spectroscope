// The session set (cards 458 and 459): the sockets this page holds, one record
// each. The transport is faked here, so every test drives frames and statuses
// by hand and reads what left on which socket.

import { beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { initialState, recordResumeMarker } from "./reducer";
import { SessionSet, type BatchInfo } from "./sessionSet";

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
  const batches: { key: string; types: string[]; info: BatchInfo }[] = [];
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
    onBatch: (key, batch, info) => batches.push({ key, types: batch.map((e) => e.type), info }),
  });
  return { set, sockets, batches };
}

const runStart = (prompt: string): RunEvent =>
  ({ type: "run_start", runId: "r1", agentId: "main", prompt, provider: "ollama", ts: 1 }) as RunEvent;
const delta = (text: string): RunEvent => ({ type: "text_delta", agentId: "main", text, ts: 2 }) as RunEvent;
const runEnd = (): RunEvent => ({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 }) as RunEvent;
const workspace = (sessionId: string): RunEvent =>
  ({ type: "workspace_info", path: "/w", configured: true, sessionId, ts: 1 }) as unknown as RunEvent;

describe("the session set, one record per socket", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("opens no socket before activate(), so a server render of the page stays offline", () => {
    h.set.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.set.view().sessionId).toBeNull();
    h.set.activate();
    expect(h.sockets).toHaveLength(1);
  });

  it("starts with one fresh record in view and one socket without a resume", () => {
    h.set.start();
    h.set.activate();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].resume).toBeUndefined();
    expect(h.set.view().sessionId).toBeNull();
    expect(h.set.view().state).toEqual(initialState);
    expect(h.set.slots()).toHaveLength(1);
  });

  it("learns the session id from workspace_info and folds the stream into the record", () => {
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    h.sockets[0].emit([workspace("s-1"), runStart("hello"), delta("hi there")]);
    const slot = h.set.view();
    expect(slot.sessionId).toBe("s-1");
    expect(slot.state.running).toBe(true);
    expect(slot.events.map((e) => e.type)).toEqual(["workspace_info", "run_start", "text_delta"]);
    expect(h.set.findBySession("s-1")?.key).toBe(slot.key);
  });

  it("sends an idle message at once, queues one while the socket is down, and drains it on open", () => {
    h.set.start();
    h.set.activate();
    const key = h.set.viewKey();
    h.set.send(key, "first");
    expect(h.sockets[0].sent).toEqual([]);
    expect(h.set.view().queue.map((m) => m.text)).toEqual(["first"]);
    h.sockets[0].status("open");
    expect(h.sockets[0].sent).toEqual([{ type: "user_message", text: "first" }]);
    expect(h.set.view().queue).toEqual([]);
  });

  it("queues behind a run it cannot steer and sends the next message after run_end", () => {
    h.set.start();
    h.set.activate();
    const key = h.set.viewKey();
    h.sockets[0].status("open");
    h.set.send(key, "one");
    h.sockets[0].emit([runStart("one")]);
    // Attachments never steer, so this one has to wait for the run.
    h.set.send(key, "two", [{ name: "a.png", mediaType: "image/png", dataBase64: "AA==", sizeBytes: 1 }]);
    expect(h.set.view().queue.map((m) => m.text)).toEqual(["two"]);
    expect(h.sockets[0].sent.filter((m) => m.type === "user_message")).toHaveLength(1);
    h.sockets[0].emit([runEnd()]);
    const users = h.sockets[0].sent.filter((m) => m.type === "user_message");
    expect(users).toHaveLength(2);
    expect(h.set.view().queue).toEqual([]);
  });

  it("steers a plain sentence into the running turn", () => {
    h.set.start();
    h.set.activate();
    const key = h.set.viewKey();
    h.sockets[0].status("open");
    h.set.send(key, "one");
    h.sockets[0].emit([runStart("one")]);
    h.set.send(key, "shorter please");
    expect(h.sockets[0].sent.map((m) => m.type)).toEqual(["user_message", "steering_message"]);
    expect(h.set.view().steering.pending.map((p) => p.text)).toEqual(["shorter please"]);
  });

  it("shows stopping only for an abort that reached a running socket, and clears it on run_end", () => {
    h.set.start();
    h.set.activate();
    const key = h.set.viewKey();
    h.set.abort(key);
    expect(h.set.view().stopRequested).toBe(false);
    h.sockets[0].status("open");
    h.set.send(key, "go");
    h.sockets[0].emit([runStart("go")]);
    h.set.abort(key);
    expect(h.set.view().stopRequested).toBe(true);
    expect(h.sockets[0].sent.some((m) => m.type === "abort")).toBe(true);
    h.sockets[0].emit([runEnd()]);
    expect(h.set.view().stopRequested).toBe(false);
  });

  it("traces the frames it sends into the record that sent them", () => {
    h.set.start();
    h.set.activate();
    const key = h.set.viewKey();
    h.sockets[0].status("open");
    h.set.sendClient(key, { type: "abort" });
    const out = h.set.view().state.trace.filter((row) => row.dir === "out");
    expect(out.map((row) => row.type)).toEqual(["abort"]);
  });

  it("continues a stored session on a socket that carries its id, with the first message waiting for open", () => {
    h.set.start();
    h.set.activate();
    const seeded = recordResumeMarker(initialState, { sessionId: "s-old" });
    const key = h.set.open({
      resumeId: "s-old",
      state: seeded,
      events: [runStart("earlier")],
      firstMessage: { text: "weiter" },
      replace: true,
    });
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].resume).toBe("s-old");
    // Card 458, step 1: one socket per page, so the fresh one it replaces is closed.
    expect(h.sockets[0].closed).toBe(true);
    expect(h.set.viewKey()).toBe(key);
    expect(h.set.view().sessionId).toBe("s-old");
    expect(h.set.view().state.trace.some((row) => row.type === "session_resume")).toBe(true);
    expect(h.sockets[1].sent).toEqual([]);
    h.sockets[1].status("open");
    expect(h.sockets[1].sent).toEqual([{ type: "user_message", text: "weiter" }]);
    expect(h.set.slots()).toHaveLength(1);
  });

  it("reports a refused continuation and lets the record go", () => {
    const refused: string[] = [];
    const sockets: FakeSocket[] = [];
    const set = new SessionSet({
      connect: (options) => {
        const socket: FakeSocket = {
          resume: options.resume,
          sent: [],
          closed: false,
          open: false,
          emit: (events) => options.onEvents(events),
          status: (status) => options.onStatus?.(status),
        };
        sockets.push(socket);
        return {
          send: () => false,
          reconnectNow: () => {},
          close: () => {
            socket.closed = true;
          },
        };
      },
      mode: () => "learn",
      traceWanted: () => true,
      onBusy: (sessionId) => refused.push(sessionId),
    });
    set.start();
    set.activate();
    set.open({ resumeId: "s-held", state: initialState, events: [], replace: true });
    sockets[1].emit([{ type: "session_busy", sessionId: "s-held" } as unknown as RunEvent]);
    expect(refused).toEqual(["s-held"]);
    expect(sockets[1].closed).toBe(true);
    expect(set.findBySession("s-held")).toBeUndefined();
    // Something is always in view: a fresh record takes the place.
    expect(set.slots()).toHaveLength(1);
    expect(set.view().resumeId).toBeNull();
  });

  it("hands every batch to the side-effect seam with where it came from", () => {
    h.set.start();
    h.set.activate();
    h.sockets[0].emit([runStart("x")]);
    expect(h.batches).toEqual([
      { key: h.set.viewKey(), types: ["run_start"], info: { inView: true, carrier: true } },
    ]);
  });
});

// ---- card 459: several sessions at once ----

const askFrame = (callId: string): RunEvent =>
  ({
    type: "question_asked",
    agentId: "main",
    callId,
    questions: [{ question: "which?", options: ["a", "b"] }],
    ts: 4,
  }) as unknown as RunEvent;

describe("several records at once (card 459)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
  });

  /** Makes the record in view a used session with an id, so a new chat adds one. */
  function use(socket: FakeSocket, sessionId: string, prompt: string): void {
    h.set.send(h.set.viewKey(), prompt);
    socket.emit([workspace(sessionId), runStart(prompt)]);
  }

  it("adds a session on new chat and leaves the running one's socket open", () => {
    use(h.sockets[0], "s-a", "long job");
    const a = h.set.viewKey();
    const b = h.set.newChat();
    expect(b).not.toBe(a);
    expect(h.set.slots()).toHaveLength(2);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0].closed).toBe(false);
    expect(h.set.get(a)?.state.running).toBe(true);
    expect(h.set.viewKey()).toBe(b);
  });

  it("reuses a fresh chat nobody has typed into instead of stacking empty sockets", () => {
    const first = h.set.viewKey();
    expect(h.set.newChat()).toBe(first);
    expect(h.sockets).toHaveLength(1);
    expect(h.set.slots()).toHaveLength(1);
  });

  it("streams two sessions at once and never folds one's frames into the other", () => {
    use(h.sockets[0], "s-a", "job a");
    const a = h.set.viewKey();
    const b = h.set.newChat();
    h.sockets[1].status("open");
    h.set.send(b, "job b");
    h.sockets[1].emit([workspace("s-b"), runStart("job b")]);
    h.sockets[0].emit([delta("from A ")]);
    h.sockets[1].emit([delta("from B ")]);
    h.sockets[0].emit([delta("again A")]);
    const textOf = (key: string) =>
      (h.set.get(key)?.events ?? [])
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join("");
    expect(textOf(a)).toBe("from A again A");
    expect(textOf(b)).toBe("from B ");
    expect(h.set.get(a)?.sessionId).toBe("s-a");
    expect(h.set.get(b)?.sessionId).toBe("s-b");
    expect(h.set.get(a)?.state.running).toBe(true);
    expect(h.set.get(b)?.state.running).toBe(true);
    // What each socket sent stayed on that socket.
    expect(h.sockets[0].sent.map((m) => (m as { text?: string }).text)).toEqual(["job a"]);
    expect(h.sockets[1].sent.map((m) => (m as { text?: string }).text)).toEqual(["job b"]);
  });

  it("switches the view without touching a socket, and the running session keeps streaming", () => {
    use(h.sockets[0], "s-a", "job a");
    const a = h.set.viewKey();
    const b = h.set.newChat();
    h.set.select(a);
    expect(h.set.viewKey()).toBe(a);
    h.set.select(b);
    expect(h.sockets[0].closed).toBe(false);
    expect(h.sockets[1].closed).toBe(false);
    h.sockets[0].emit([delta("still here")]);
    expect(h.set.get(a)?.events.some((e) => e.type === "text_delta")).toBe(true);
    expect(h.set.view().key).toBe(b);
  });

  it("tells the side effects which batch is on screen and which socket carries the fleet frames", () => {
    use(h.sockets[0], "s-a", "job a");
    const b = h.set.newChat();
    h.batches.length = 0;
    h.sockets[0].emit([delta("a")]);
    h.sockets[1].emit([delta("b")]);
    expect(h.batches).toEqual([
      { key: h.set.slots()[0].key, types: ["text_delta"], info: { inView: false, carrier: true } },
      { key: b, types: ["text_delta"], info: { inView: true, carrier: false } },
    ]);
  });

  it("continues a stored session beside the running one instead of in its place", () => {
    use(h.sockets[0], "s-a", "job a");
    h.set.open({ resumeId: "s-old", state: initialState, events: [], firstMessage: { text: "weiter" } });
    expect(h.sockets[0].closed).toBe(false);
    expect(h.set.slots().map((s) => s.sessionId)).toEqual(["s-a", "s-old"]);
  });

  it("stops a running session before it lets it go, and waits for its run_end", async () => {
    use(h.sockets[0], "s-a", "job a");
    const a = h.set.viewKey();
    h.set.newChat();
    const released = h.set.release(a, 2_000);
    expect(h.sockets[0].sent.some((m) => m.type === "abort")).toBe(true);
    expect(h.sockets[0].closed).toBe(false);
    h.sockets[0].emit([runEnd()]);
    await released;
    expect(h.sockets[0].closed).toBe(true);
    expect(h.set.get(a)).toBeUndefined();
    expect(h.set.slots()).toHaveLength(1);
  });

  it("marks a background session that waits for an answer, and a session held up by a busy model", () => {
    use(h.sockets[0], "s-a", "job a");
    h.sockets[0].emit([delta("streaming")]);
    const b = h.set.newChat();
    h.sockets[1].status("open");
    h.set.send(b, "job b");
    h.sockets[1].emit([workspace("s-b"), runStart("job b")]);
    const row = (id: string) => h.set.heldRows().find((r) => r.id === id);
    // B started after A and has had no model output while A streams on the same backend.
    expect(row("s-b")?.attention).toBe("model");
    expect(row("s-a")?.attention).toBeNull();
    h.sockets[0].emit([askFrame("q1")]);
    expect(row("s-a")?.attention).toBe("answer");
    h.sockets[1].emit([delta("now B talks")]);
    expect(row("s-b")?.attention).toBeNull();
  });
});
