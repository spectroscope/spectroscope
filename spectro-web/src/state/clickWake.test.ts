// Card 520: a click on a stored session wakes it.
//
// Card 498 woke a stored session when its message box got the focus. This card
// moves the wake to the selection: the replay landing on screen runs the same
// path, so Files and Terminal reach the folder before anything is typed. The
// effect in App calls wakeFollowsScreen with the replay on screen; these tests
// drive the real SessionSet through that function with fake sockets and count
// the frames that leave.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection, ConnectionStatus } from "../transport/ws";
import { SessionSet } from "./sessionSet";
import { initialState } from "./reducer";
import { WAKE_SETTLE_MS, settleWake, wakeFollowsScreen } from "../workspace/wakeChip";

interface FakeSocket {
  sent: ClientMessage[];
  closed: boolean;
  open: boolean;
  emit(events: RunEvent[]): void;
  status(status: ConnectionStatus): void;
}

function harness() {
  const sockets: FakeSocket[] = [];
  const refused: { sessionId: string; woken: boolean }[] = [];
  const connect = (options: ConnectOptions): Connection => {
    const socket: FakeSocket = {
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
    onBusy: (sessionId, woken) => refused.push({ sessionId, woken }),
  });
  /** Every wake_session frame that left on any socket, in order. */
  const wakes = (): string[] =>
    sockets.flatMap((socket) =>
      socket.sent
        .filter((msg) => msg.type === "wake_session")
        .map((msg) => (msg as { sessionId: string }).sessionId),
    );
  /** Opens every socket that is not open yet, as the server would. */
  const openAll = (): void => {
    for (const socket of sockets) if (!socket.open && !socket.closed) socket.status("open");
  };
  return { set, sockets, refused, wakes, openAll };
}

const A = "20261011-090000-aaaa";
const B = "20261011-090100-bbbb";
const C = "20261011-090200-cccc";

describe("a click on a stored session wakes it (card 520)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** App's effect: each landed replay settles a wake, and the next one cancels it. */
  const screen = () => {
    let cancel: (() => void) | null = null;
    return (replayId: string | null): void => {
      cancel?.();
      cancel = settleWake(h.set, { replayId, continuable: replayId !== null, refused: false });
    };
  };

  it("three selections wake each session once and keep only the one on screen", () => {
    vi.useFakeTimers();
    const land = screen();
    for (const id of [A, B, C]) {
      land(id);
      vi.advanceTimersByTime(WAKE_SETTLE_MS);
      h.openAll();
      // A re-render with the same session on screen runs the effect no more,
      // and a focus in the message box finds the wake.
      wakeFollowsScreen(h.set, { replayId: id, continuable: true, refused: false });
      h.openAll();
    }

    expect(h.wakes()).toEqual([A, B, C]);
    const woken = h.set.slots().filter((slot) => slot.woken);
    expect(woken.map((slot) => slot.sessionId)).toEqual([C]);
    const openSockets = h.sockets.filter((socket) => !socket.closed);
    expect(openSockets).toHaveLength(2);
    expect(h.sockets[0].sent).toEqual([]);
  });

  it("ten quick clicks that all land send one wake, for the session that stays on screen", () => {
    // Measured on 2026-10-11: on loopback every replay of a small session
    // lands before the next scripted click, so each click puts its session on
    // screen. Only the one that stays there long enough wakes.
    vi.useFakeTimers();
    const land = screen();
    for (let click = 0; click < 10; click++) {
      land(click % 2 === 0 ? A : B);
      vi.advanceTimersByTime(30);
      h.openAll();
    }
    vi.advanceTimersByTime(WAKE_SETTLE_MS);
    h.openAll();
    expect(h.wakes()).toEqual([B]);
    expect(
      h.set
        .slots()
        .filter((slot) => slot.woken)
        .map((slot) => slot.sessionId),
    ).toEqual([B]);
  });

  it("leaving the screen lets a wake go at once, before any settle", () => {
    vi.useFakeTimers();
    const land = screen();
    land(A);
    vi.advanceTimersByTime(WAKE_SETTLE_MS);
    h.openAll();
    land(null);
    expect(h.set.slots().some((slot) => slot.woken)).toBe(false);
    vi.advanceTimersByTime(WAKE_SETTLE_MS);
    expect(h.wakes()).toEqual([A]);
  });

  it("wakes nothing for an import, a scenario, a read only session or a refused one", () => {
    wakeFollowsScreen(h.set, { replayId: "import:x", continuable: true, refused: false });
    wakeFollowsScreen(h.set, { replayId: "scenario:demo", continuable: true, refused: false });
    wakeFollowsScreen(h.set, { replayId: A, continuable: false, refused: false });
    wakeFollowsScreen(h.set, { replayId: B, continuable: true, refused: true });
    wakeFollowsScreen(h.set, { replayId: null, continuable: false, refused: false });
    h.openAll();
    expect(h.wakes()).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  it("composer focus after the click wake is a no-op on the client", () => {
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    // The focus calls the same function a second time for the same session.
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    expect(h.wakes()).toEqual([A]);
    expect(h.sockets).toHaveLength(2);
  });

  it("the woken record closes when the session leaves the screen", () => {
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    wakeFollowsScreen(h.set, { replayId: null, continuable: false, refused: false });
    expect(h.set.slots().some((slot) => slot.woken)).toBe(false);
    expect(h.sockets[1].closed).toBe(true);
  });
});

describe("clicking the woken session again shows the replay (card 520)", () => {
  it("a held chat is never a woken record", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    // First click: the replay lands and the session wakes.
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    const inView = h.set.viewKey();
    // Second click on the same row: openSession asks for a held chat first.
    expect(h.set.findHeld(A)).toBeUndefined();
    // The wake stays found for the dedupe, and stays out of view.
    expect(h.set.findBySession(A)?.woken).toBe(true);
    expect(h.set.viewKey()).toBe(inView);
    // The replay lands again with the same id: still one wake.
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    expect(h.wakes()).toEqual([A]);
  });

  it("a continued session is a held chat again", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    const key = h.set.findBySession(A)!.key;
    h.set.continueWoken(key, { state: initialState, events: [], firstMessage: { text: "go on" } });
    expect(h.set.findHeld(A)?.key).toBe(key);
  });
});

describe("a session live in another window (card 520)", () => {
  it("answers session_busy: the record goes, the set says it was a wake, and nothing wakes again", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.sockets[0].status("open");
    const inView = h.set.viewKey();
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: false });
    h.openAll();
    h.sockets[1].emit([{ type: "session_busy", sessionId: A } as unknown as RunEvent]);

    expect(h.refused).toEqual([{ sessionId: A, woken: true }]);
    expect(h.set.findBySession(A)).toBeUndefined();
    expect(h.sockets[1].closed).toBe(true);
    expect(h.set.viewKey()).toBe(inView);
    // App marks the session refused; the effect runs again and wakes nothing.
    wakeFollowsScreen(h.set, { replayId: A, continuable: true, refused: true });
    h.openAll();
    expect(h.wakes()).toEqual([A]);
    expect(h.sockets).toHaveLength(2);
  });

  it("a resume refused the same way says it was not a wake", () => {
    const h = harness();
    h.set.start();
    h.set.activate();
    h.set.open({ resumeId: B, state: initialState, events: [], replace: true });
    h.sockets[1].emit([{ type: "session_busy", sessionId: B } as unknown as RunEvent]);
    expect(h.refused).toEqual([{ sessionId: B, woken: false }]);
  });
});

describe("the fleet carrier is never a woken record (card 520)", () => {
  it("the carrier skips a woken record when the first record goes", () => {
    const batches: { key: string; carrier: boolean }[] = [];
    const sockets: { emit(events: RunEvent[]): void }[] = [];
    let carrierChanges = 0;
    const set = new SessionSet({
      onCarrierChange: () => {
        carrierChanges += 1;
      },
      connect: (options) => {
        sockets.push({ emit: (events) => options.onEvents(events) });
        return { send: () => false, reconnectNow: () => {}, close: () => {} };
      },
      mode: () => "learn",
      traceWanted: () => true,
      onBatch: (key, _batch, info) => batches.push({ key, carrier: info.carrier }),
    });
    set.start();
    set.activate();
    const first = set.viewKey();
    const woken = set.open({ wake: A });
    set.close(first);

    // Something that is not the wake comes into view and carries the frames.
    const now = set.view();
    expect(now.woken).toBe(false);
    expect(now.key).not.toBe(woken);
    sockets[1].emit([{ type: "live_sessions", sessions: [] } as unknown as RunEvent]);
    sockets[2].emit([{ type: "live_sessions", sessions: [] } as unknown as RunEvent]);
    expect(batches).toEqual([
      { key: woken, carrier: false },
      { key: now.key, carrier: true },
    ]);
    // The roster is read again once, for the carrier that went away.
    expect(carrierChanges).toBe(1);
  });

  it("a wake beside the first record does not carry the frames", () => {
    const batches: { key: string; carrier: boolean }[] = [];
    const sockets: { emit(events: RunEvent[]): void }[] = [];
    const set = new SessionSet({
      connect: (options) => {
        sockets.push({ emit: (events) => options.onEvents(events) });
        return { send: () => false, reconnectNow: () => {}, close: () => {} };
      },
      mode: () => "learn",
      traceWanted: () => true,
      onBatch: (key, _batch, info) => batches.push({ key, carrier: info.carrier }),
    });
    set.start();
    set.activate();
    const woken = set.open({ wake: B });
    sockets[1].emit([{ type: "live_sessions", sessions: [] } as unknown as RunEvent]);
    expect(batches).toEqual([{ key: woken, carrier: false }]);
  });
});
