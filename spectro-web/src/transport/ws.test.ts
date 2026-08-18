// The transport itself, with the browser replaced by two clocks and a socket
// double — the whole point being that none of this needs a window.
//
// Card 261. The owner's report was a view that showed nothing of the last half
// hour while the session file on disk had every event. Two causes were named,
// and they are told apart here rather than by watching: one of them catches up
// in a single fold the moment a frame arrives, the other never catches up at
// all because nothing will ever arrive again.

import { describe, expect, it } from "vitest";
import { browserHost, connect, type TransportHost, type TransportSocket } from "./ws";
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

/** The frame an older server answers an unknown type with, verbatim. */
const unknownType = (): string =>
  JSON.stringify({ type: "error", agentId: "main", message: "Unknown message type.", ts: 1 });

describe("a server that predates the probe", () => {
  // Card 261 review. A page carrying this transport can meet a server built
  // before `case "ping"` existed — an older dev server, an older desktop jar.
  // That server's default arm is sendError("Unknown message type."), and
  // sendError is a first-class RunEvent: it goes through send() and is
  // APPENDED to the session's JSONL. Asking every fifteen seconds would fill
  // the operator's chat and his record on disk with error rows forever.
  it("asks once, is refused, and never asks that socket again", () => {
    const rigged = rig({ paints: true });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    rigged.advance(LIVENESS_TICK_MS * 3);
    expect(socket.sent).toEqual([PROBE_FRAME]);

    socket.deliver(unknownType());
    rigged.paint();
    expect(batches).toEqual([]); // our own probe coming back is not news

    rigged.advance(LIVENESS_WINDOW_MS * 4);
    expect(socket.sent).toEqual([PROBE_FRAME]); // asked once, and only once
  });

  it("does not condemn a socket that answered, even with a refusal", () => {
    // Answering at all is proof of delivery — that is the whole premise of the
    // probe. Retiring here would cost the operator the run over a version skew.
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const socket = accept(rigged);

    rigged.advance(LIVENESS_TICK_MS * 3);
    socket.deliver(unknownType());
    rigged.advance(LIVENESS_WINDOW_MS * 4);

    expect(socket.closes.count).toBe(0);
    expect(rigged.sockets.length).toBe(1);
  });

  it("still shows an error the server raised on its own", () => {
    // Only the answer to an OUTSTANDING probe is swallowed. The same text with
    // nothing asked is the agent's own error and belongs on the screen.
    const rigged = rig({ paints: true });
    const batches: RunEvent[][] = [];
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: (b) => batches.push(b) });
    const socket = accept(rigged);

    socket.deliver(unknownType());
    rigged.paint();
    expect(batches.flat().length).toBe(1);
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

  it("goes back fresh when the watchdog's own reconnect is refused", () => {
    // Card 261 review, the headline scenario end to end. A half-open socket
    // means the server never saw a FIN, so it still holds the LiveSessions
    // claim: the watchdog retires at 35 s, the reconnect asks for the session
    // back, and start() refuses it. The socket AFTER that must ask for
    // nothing — a retry that kept the resume would be refused every second
    // for as long as the server's own half-open socket holds the claim.
    const rigged = rig({ paints: true });
    connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const first = accept(rigged);
    first.deliver(JSON.stringify({ type: "workspace_info", sessionId: "s-9", path: "/w" }));
    rigged.paint();

    rigged.advance(LIVENESS_WINDOW_MS); // the watchdog gives up on a live socket
    expect(first.closes.count).toBe(1);
    rigged.advance(2000); // the backoff runs out
    expect(rigged.sockets[1].url).toBe("ws://x/ws?resume=s-9");

    const second = accept(rigged);
    second.deliver(JSON.stringify({ type: "session_busy", sessionId: "s-9" }));
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
  it("opens at once instead of waiting out the backoff", () => {
    // Card 261 review: the whole body of reconnectNow() could be replaced with
    // `return` and the suite stayed green, because only its guard was pinned.
    // This is what the banner's retry link is FOR.
    const rigged = rig({ paints: true });
    const connection = connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    const first = accept(rigged);

    first.onclose?.(); // retired, with a backoff armed
    expect(rigged.sockets.length).toBe(1);

    connection.reconnectNow();
    expect(rigged.sockets.length).toBe(2); // now, not in a second

    // …and the backoff it skipped must be cancelled, not merely overtaken:
    // a second socket arriving behind this one is the two-client defect.
    rigged.advance(60_000);
    expect(rigged.sockets.length).toBe(2);
  });

  it("does not open a second socket while the first one is still connecting", () => {
    const rigged = rig({ paints: true });
    const connection = connect({ url: "ws://x/ws", host: rigged.host, onEvents: () => {} });
    expect(rigged.sockets.length).toBe(1);

    connection.reconnectNow(); // the socket has not said onopen yet
    expect(rigged.sockets.length).toBe(1);
  });
});

describe("the wiring to the real browser", () => {
  // Card 261 review. browserHost() is the exact seam this card exists to fix,
  // and it was the one part of it no test touched: every other test in this
  // file injects a double. A setTimer pointed at requestAnimationFrame, or an
  // onmessage handed the MessageEvent instead of its data, would ship the
  // original defect with all of the above green.

  interface FakeRaw {
    url: string;
    readyState: number;
    sent: string[];
    closed: number;
    onopen: (() => void) | null;
    onmessage: ((msg: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
  }
  interface Calls {
    frames: (() => void)[];
    cancelledFrames: number[];
    timers: { ms: number }[];
    clearedTimers: number[];
    opened: FakeRaw[];
  }

  /** Runs `body` with globalThis.window and WebSocket replaced by recorders. */
  function withFakeBrowser(body: (calls: Calls) => void): void {
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { window: globals.window, socket: globals.WebSocket };
    const calls: Calls = {
      frames: [],
      cancelledFrames: [],
      timers: [],
      clearedTimers: [],
      opened: [],
    };
    class FakeWebSocket implements FakeRaw {
      static readonly OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      closed = 0;
      onopen: (() => void) | null = null;
      onmessage: ((msg: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        calls.opened.push(this);
      }
      send(text: string): void {
        this.sent.push(text);
      }
      close(): void {
        this.closed += 1;
      }
    }
    globals.WebSocket = FakeWebSocket;
    globals.window = {
      requestAnimationFrame: (run: () => void) => {
        calls.frames.push(run);
        return 11;
      },
      cancelAnimationFrame: (handle: number) => calls.cancelledFrames.push(handle),
      setTimeout: (run: () => void, ms: number) => {
        void run;
        calls.timers.push({ ms });
        return 22;
      },
      clearTimeout: (handle: number) => calls.clearedTimers.push(handle),
    };
    try {
      body(calls);
    } finally {
      globals.window = saved.window;
      globals.WebSocket = saved.socket;
    }
  }

  it("puts each of the four clock calls on the global it belongs to", () => {
    withFakeBrowser((calls) => {
      const host = browserHost();
      const noop = (): void => {};

      expect(host.requestFrame(noop)).toBe(11);
      expect(calls.frames.length).toBe(1);
      expect(calls.timers).toEqual([]); // a frame may not arm a timeout

      expect(host.setTimer(noop, 250)).toBe(22);
      expect(calls.timers).toEqual([{ ms: 250 }]);
      expect(calls.frames.length).toBe(1); // …and a timeout may not arm a frame

      host.cancelFrame(11);
      expect(calls.cancelledFrames).toEqual([11]);
      expect(calls.clearedTimers).toEqual([]);

      host.clearTimer(22);
      expect(calls.clearedTimers).toEqual([22]);
      expect(calls.cancelledFrames).toEqual([11]);

      expect(Math.abs(host.now() - Date.now())).toBeLessThan(1000);
    });
  });

  it("hands the transport the frame's data, not the event that carried it", () => {
    // The liveness watch keys on the frame's `type`, so a MessageEvent here
    // would parse to null, every pong would be dropped, and every socket in
    // the product would be condemned after 35 s.
    withFakeBrowser((calls) => {
      const socket = browserHost().openSocket("ws://x/ws");
      const seen: unknown[] = [];
      socket.onmessage = (data) => seen.push(data);

      const raw = calls.opened[0];
      expect(raw.url).toBe("ws://x/ws");
      raw.onmessage?.({ data: '{"type":"pong","ts":1}' });
      expect(seen).toEqual(['{"type":"pong","ts":1}']);
    });
  });

  it("reads open, send and close off the socket underneath", () => {
    withFakeBrowser((calls) => {
      const socket = browserHost().openSocket("ws://x/ws");
      const raw = calls.opened[0];

      expect(socket.isOpen()).toBe(true);
      raw.readyState = 3; // CLOSED
      expect(socket.isOpen()).toBe(false);

      socket.send("hi");
      expect(raw.sent).toEqual(["hi"]);
      socket.close();
      expect(raw.closed).toBe(1);
    });
  });

  it("forwards the three lifecycle events to the handlers the transport set", () => {
    withFakeBrowser((calls) => {
      const socket = browserHost().openSocket("ws://x/ws");
      const seen: string[] = [];
      socket.onopen = () => seen.push("open");
      socket.onclose = () => seen.push("close");
      socket.onerror = () => seen.push("error");

      const raw = calls.opened[0];
      raw.onopen?.();
      raw.onerror?.();
      raw.onclose?.();
      expect(seen).toEqual(["open", "error", "close"]);
    });
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
