// The transport itself, with the browser replaced by two clocks and a socket
// double — the whole point being that none of this needs a window.
//
// Card 261. The owner's report was a view that showed nothing of the last half
// hour while the session file on disk had every event. Two causes were named,
// and they are told apart here rather than by watching: one of them catches up
// in a single fold the moment a frame arrives, the other never catches up at
// all because nothing will ever arrive again.

import { describe, expect, it } from "vitest";
import { connect, type TransportHost, type TransportSocket } from "./ws";
import { LIVENESS_TICK_MS, LIVENESS_WINDOW_MS, PROBE_FRAME } from "./liveness";
import type { RunEvent } from "../events";

interface FakeSocket extends TransportSocket {
  readonly url: string;
  readonly sent: string[];
  readonly closes: { count: number };
  /** Deliver one raw frame, as the server would. */
  deliver(text: string): void;
  live: boolean;
}

interface Rig {
  host: TransportHost;
  /** Every socket the transport has opened, oldest first. */
  sockets: FakeSocket[];
  /** Run the frame callback, if any is armed. A hidden window never calls this. */
  paint(): void;
  /** Advance the wall clock and run every timer that is now due. */
  advance(ms: number): void;
  clock: { now: number };
}

function rig(options: { paints: boolean }): Rig {
  const sockets: FakeSocket[] = [];
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const clock = { now: 0 };

  const host: TransportHost = {
    requestFrame(run) {
      const handle = next++;
      if (options.paints) frames.set(handle, run);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    setTimer(run, ms) {
      const handle = next++;
      timers.set(handle, { at: clock.now + ms, run });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    now: () => clock.now,
    openSocket(url) {
      const socket: FakeSocket = {
        url,
        sent: [],
        closes: { count: 0 },
        live: false,
        isOpen: () => socket.live,
        send: (text) => socket.sent.push(text),
        close: () => {
          socket.live = false;
          socket.closes.count += 1;
        },
        deliver: (text) => socket.onmessage?.(text),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
  };

  return {
    host,
    sockets,
    clock,
    paint() {
      const pending = [...frames.values()];
      frames.clear();
      for (const run of pending) run();
    },
    advance(ms) {
      const target = clock.now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [handle, timer] = due[0];
        timers.delete(handle);
        clock.now = timer.at;
        timer.run();
      }
      clock.now = target;
    },
  };
}

/** Brings the newest socket up, the way a server accepting a connection does. */
function accept(rigged: Rig): FakeSocket {
  const socket = rigged.sockets.at(-1)!;
  socket.live = true;
  socket.onopen?.();
  return socket;
}

const delta = (text: string): string => JSON.stringify({ type: "text_delta", agentId: "main", text, ts: 1 });

describe("the window nobody is looking at", () => {
  it("still gets its batches, with no frame ever fired", () => {
    // Cause one, verbatim: requestAnimationFrame is the only trigger and an
    // occluded window fires none. The record on disk is complete either way,
    // which is exactly why this was invisible.
    const rigged = rig({ paints: false });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    socket.deliver(delta("a"));
    socket.deliver(delta("b"));
    rigged.paint(); // nothing to run: this window is not being composited
    expect(batches).toEqual([]);

    rigged.advance(1000);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(2);
  });

  it("keeps folding rather than growing one enormous catch-up batch", () => {
    const rigged = rig({ paints: false });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    for (let round = 0; round < 5; round += 1) {
      socket.deliver(delta(String(round)));
      rigged.advance(1000);
    }
    expect(batches.length).toBe(5);
    expect(batches.every((b) => b.length === 1)).toBe(true);
  });
});

describe("the window somebody is looking at", () => {
  it("folds once per frame, as it always did", () => {
    const rigged = rig({ paints: true });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    for (let i = 0; i < 40; i += 1) socket.deliver(delta(String(i)));
    rigged.paint();
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(40);

    // …and the fallback timer that was armed alongside folds nothing twice.
    rigged.advance(5000);
    expect(batches.length).toBe(1);
  });
});

describe("the socket that died without saying so", () => {
  it("is asked, in the exact frame the server answers", () => {
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    rigged.advance(LIVENESS_TICK_MS * 4);
    expect(socket.sent).toContain(PROBE_FRAME);
  });

  it("is not asked while it is delivering", () => {
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    for (let i = 0; i < 20; i += 1) {
      socket.deliver(delta(String(i)));
      rigged.advance(LIVENESS_TICK_MS);
      rigged.paint();
    }
    expect(socket.sent).toEqual([]);
  });

  it("swallows the answer instead of showing the app a frame it did not ask for", () => {
    const rigged = rig({ paints: true });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    rigged.advance(LIVENESS_TICK_MS * 4);
    socket.deliver(JSON.stringify({ type: "pong", ts: 3 }));
    rigged.paint();
    rigged.advance(5000);
    expect(batches).toEqual([]);
  });

  it("stops calling itself connected before it reconnects, not after", () => {
    // Criterion 4: a socket that has not delivered inside the window may not
    // read "connected". The chip has to change FIRST — a reconnect that
    // announced itself only on success would leave the banner lying for the
    // whole backoff.
    const rigged = rig({ paints: true });
    const seen: string[] = [];
    connect({
      url: "ws://x/ws",
      host: rigged.host,
      onEvents: () => {},
      onStatus: (status) => seen.push(status),
    });
    accept(rigged);
    expect(seen).toEqual(["connecting", "open"]);

    rigged.advance(LIVENESS_WINDOW_MS); // the tick that gives up, and no further
    expect(seen).toEqual(["connecting", "open", "closed"]);
    expect(rigged.sockets.length).toBe(1);

    rigged.advance(2000); // the backoff runs out
    expect(seen).toEqual(["connecting", "open", "closed", "connecting"]);
    expect(rigged.sockets.length).toBe(2);
  });

  it("hangs up on the dead socket rather than leaving it to rot", () => {
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    rigged.advance(LIVENESS_WINDOW_MS + LIVENESS_TICK_MS);
    expect(socket.closes.count).toBe(1);
  });

  it("folds what was still buffered exactly once when it gives up", () => {
    // Criterion 6, the client half: a socket that dies between one fold and
    // the next must not take the tail of the buffer with it — and must not
    // hand it over twice either. No clock is advanced on purpose: the buffer
    // has to be non-empty at the instant of the retirement, which is the only
    // moment this line of code exists for.
    const rigged = rig({ paints: false });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    socket.deliver(delta("tail"));
    expect(batches).toEqual([]); // still buffered — nothing has folded it yet
    socket.onclose?.();

    const delivered = batches.flat().filter((e) => (e as { text?: string }).text === "tail");
    expect(delivered.length).toBe(1);

    // …and the fold that was armed for it must not run a second time.
    rigged.advance(LIVENESS_WINDOW_MS);
    expect(batches.flat().filter((e) => (e as { text?: string }).text === "tail").length).toBe(1);
  });
});

describe("onerror", () => {
  it("reconnects from an error, not only from a close", () => {
    const rigged = rig({ paints: true });
    const seen: string[] = [];
    connect({
      url: "ws://x/ws",
      host: rigged.host,
      onEvents: () => {},
      onStatus: (status) => seen.push(status),
    });
    const socket = accept(rigged);

    socket.onerror?.();
    expect(seen.at(-1)).toBe("closed");

    rigged.advance(2000);
    expect(rigged.sockets.length).toBe(2);
  });

  it("counts an error and the close behind it as ONE retirement", () => {
    // Browsers fire onerror and then onclose for the same socket. Two retries
    // for one death would halve the backoff and open two sockets.
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    socket.onerror?.();
    socket.onclose?.();
    rigged.advance(2000);
    expect(rigged.sockets.length).toBe(2);
  });

  it("cannot let a retired socket's late close take down the socket that replaced it", () => {
    // The order that actually happens in a browser: onerror, then the retry
    // fires, and only THEN does the dead socket get around to its onclose. A
    // handler still pointing at the transport would retire the wrong socket —
    // and every reconnect after it, forever, one death behind.
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const first = accept(rigged);

    first.onerror?.();
    rigged.advance(2000);
    expect(rigged.sockets.length).toBe(2);
    const second = accept(rigged);

    first.onclose?.(); // the dead one, finally
    rigged.advance(2000);
    expect(second.closes.count).toBe(0);
    expect(rigged.sockets.length).toBe(2);
  });
});

describe("what a reconnect reconnects to", () => {
  it("resumes the session the server minted, instead of starting a new one", () => {
    // Criterion 6. Without this the record on disk stops being the anchor: the
    // old run keeps writing its file while the view is fed by a brand new
    // session, and the two are folded into one screen.
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    socket.deliver(JSON.stringify({ type: "workspace_info", sessionId: "s-42", path: "/w" }));
    rigged.paint();
    socket.onclose?.();
    rigged.advance(2000);

    expect(rigged.sockets[1].url).toBe("ws://x/ws?resume=s-42");
  });

  it("lets go of a session the server refuses, so the retry is not a hammer", () => {
    // SessionConnection#sendSessionBusy says the client "has to act on it (drop
    // the resume, so a retrying socket does not hammer a session it will keep
    // being refused)".
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const first = accept(rigged);

    first.deliver(JSON.stringify({ type: "workspace_info", sessionId: "s-42", path: "/w" }));
    rigged.paint();
    first.onclose?.();
    rigged.advance(2000);

    const second = rigged.sockets[1];
    second.live = true;
    second.onopen?.();
    second.deliver(JSON.stringify({ type: "session_busy", sessionId: "s-42" }));
    rigged.paint();
    second.onclose?.();
    rigged.advance(4000);

    expect(rigged.sockets[2].url).toBe("ws://x/ws");
  });

  it("keeps the resume the app asked for when the server never named a session", () => {
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, resume: "s-7", onEvents: () => {} });
    expect(rigged.sockets[0].url).toBe("ws://x/ws?resume=s-7");
    accept(rigged).onclose?.();
    rigged.advance(2000);
    expect(rigged.sockets[1].url).toBe("ws://x/ws?resume=s-7");
  });
});

describe("the manual reconnect link", () => {
  it("does not open a second socket while the first one is still connecting", () => {
    const rigged = rig({ paints: true });
    const connection = connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    expect(rigged.sockets.length).toBe(1);

    connection.reconnectNow(); // the socket has not said onopen yet
    expect(rigged.sockets.length).toBe(1);
  });
});

describe("a disposed connection", () => {
  it("sends no probe and opens nothing after close()", () => {
    const rigged = rig({ paints: true });
    const connection = connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    connection.close();
    rigged.advance(LIVENESS_WINDOW_MS * 3);
    expect(socket.sent).toEqual([]);
    expect(rigged.sockets.length).toBe(1);
  });
});
