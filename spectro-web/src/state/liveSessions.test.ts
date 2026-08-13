// What the rail is allowed to call live, and where it learns it.
//
// Card 208 gave the live row the same dot as every other row. Card 212 is the
// half that could not be built on the client at all: the page holds ONE socket,
// and until the server grew a live set there was nothing to read, so the rail
// showed one running session while a second one was invisible.
//
// Two sources feed this store on purpose. The socket push is immediate; the
// poll is the floor under it, for a page that has not folded a frame yet or
// whose socket was down while a run started. Both are proven here, including
// that the newer of the two wins.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LIVE_POLL_MS,
  liveSessionsOfBody,
  liveSessionsOfFrame,
  liveSessionsPushLive,
  readSessionBusy,
  refreshLiveSessions,
  startLiveSessionsPoll,
  __getLiveSessions,
  __resetForTests,
  __setTestHooks,
  __subscribeForTests,
} from "./liveSessions";
import { initialState, reduce } from "./reducer";
import type { RunEvent } from "../events";

/** A live_sessions frame as the server writes it. */
function frame(...rows: { id: string; running?: boolean; since?: number }[]): unknown {
  return {
    type: "live_sessions",
    sessions: rows.map((r) => ({ id: r.id, running: r.running ?? false, since: r.since ?? 1 })),
    ts: 7,
  };
}

/** A fetch double answering one JSON body. */
function answering(body: unknown, ok = true): typeof fetch {
  return (() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetForTests();
});

describe("reading the wire", () => {
  it("reads every live session out of one frame, not just the first", () => {
    expect(liveSessionsOfFrame(frame({ id: "a" }, { id: "b", running: true }))).toEqual([
      { id: "a", running: false, since: 1 },
      { id: "b", running: true, since: 1 },
    ]);
  });

  it("is not fooled by another frame or by junk", () => {
    expect(liveSessionsOfFrame({ type: "run_end", runId: "r", stopReason: "end_turn", ts: 1 })).toBeNull();
    expect(liveSessionsOfFrame({ type: "live_sessions" })).toBeNull();
    expect(liveSessionsOfFrame(null)).toBeNull();
    expect(liveSessionsOfFrame("live_sessions")).toBeNull();
  });

  it("drops rows that are not sessions rather than inventing ids", () => {
    const mixed = { type: "live_sessions", sessions: [{ id: "a", running: false, since: 1 }, {}, 3] };
    expect(liveSessionsOfFrame(mixed)).toEqual([{ id: "a", running: false, since: 1 }]);
  });

  it("reads the REST body, which is the bare array", () => {
    expect(liveSessionsOfBody([{ id: "a", running: true, since: 2 }])).toEqual([
      { id: "a", running: true, since: 2 },
    ]);
    expect(liveSessionsOfBody({ sessions: [] })).toBeNull();
  });

  it("names the session a refusal was about", () => {
    expect(readSessionBusy({ type: "session_busy", sessionId: "s-1" })).toBe("s-1");
    expect(readSessionBusy({ type: "session_busy" })).toBeNull();
    expect(readSessionBusy({ type: "error", message: "no", ts: 1 })).toBeNull();
  });
});

describe("the frozen wire is not touched", () => {
  it("changes nothing a session is made of", () => {
    // AC5: the live set is an ADDITIVE socket frame beside the RunEvent wire.
    // The reducer folds it exactly as it folds provider_info — the trace tab
    // shows the frame, because a frame that arrived is a thing that happened —
    // and nothing else about the session moves.
    const before = initialState;
    const after = reduce(before, frame({ id: "a", running: true }) as RunEvent);

    const { trace: beforeTrace, ...beforeRest } = before;
    const { trace: afterTrace, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    expect(afterTrace.length).toBe(beforeTrace.length + 1);
    expect(afterTrace[afterTrace.length - 1].type).toBe("live_sessions");
  });

  it("cannot be mistaken for a run ending", () => {
    // The one fold that would be catastrophic: a frame saying "nothing is live
    // on the server" must never be read as this page's run finishing.
    const running = reduce(initialState, {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "hi",
      ts: 1,
    });
    expect(running.running).toBe(true);
    expect(reduce(running, frame() as RunEvent).running).toBe(true);
  });
});

describe("the store", () => {
  it("holds several live sessions at once, each with its own run flag", () => {
    liveSessionsPushLive([frame({ id: "a", running: true }, { id: "b" })] as RunEvent[]);

    expect(__getLiveSessions()).toEqual([
      { id: "a", running: true, since: 1 },
      { id: "b", running: false, since: 1 },
    ]);
  });

  it("lets one session end while the other keeps running", () => {
    liveSessionsPushLive([frame({ id: "a", running: true }, { id: "b", running: true })] as RunEvent[]);
    liveSessionsPushLive([frame({ id: "b", running: true })] as RunEvent[]);

    expect(__getLiveSessions()).toEqual([{ id: "b", running: true, since: 1 }]);
  });

  it("replaces the set rather than accumulating it", () => {
    // Latest-wins. A store that merged would keep a finished session live for
    // the rest of the page's life, which is the failure this card is about.
    liveSessionsPushLive([frame({ id: "a" })] as RunEvent[]);
    liveSessionsPushLive([frame()] as RunEvent[]);

    expect(__getLiveSessions()).toEqual([]);
  });

  it("ignores a batch that carries no live frame", () => {
    liveSessionsPushLive([frame({ id: "a" })] as RunEvent[]);
    const held = __getLiveSessions();

    liveSessionsPushLive([{ type: "text_delta", agentId: "main", text: "x", ts: 1 }] as RunEvent[]);

    expect(__getLiveSessions()).toBe(held);
  });

  it("takes the LAST live frame of a batch", () => {
    liveSessionsPushLive([frame({ id: "a" }), frame({ id: "b" })] as RunEvent[]);

    expect(__getLiveSessions()).toEqual([{ id: "b", running: false, since: 1 }]);
  });

  it("notifies its subscribers so the rail redraws", () => {
    let woken = 0;
    const stop = __subscribeForTests(() => {
      woken += 1;
    });
    liveSessionsPushLive([frame({ id: "a" })] as RunEvent[]);
    expect(woken).toBe(1);

    stop();
    liveSessionsPushLive([frame({ id: "b" })] as RunEvent[]);
    expect(woken).toBe(1);
  });
});

describe("the poll under the push", () => {
  it("states its own staleness bound", () => {
    // The card has to answer "how stale can this be" with a number.
    expect(LIVE_POLL_MS).toBe(5000);
  });

  it("fills the store from GET /api/sessions/live", async () => {
    const seen: string[] = [];
    __setTestHooks({
      fetch: ((url: string) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: "a", running: true, since: 3 }]),
        } as Response);
      }) as unknown as typeof fetch,
    });

    await refreshLiveSessions();

    expect(seen).toEqual(["/api/sessions/live"]);
    expect(__getLiveSessions()).toEqual([{ id: "a", running: true, since: 3 }]);
  });

  it("leaves the pushed set alone when the poll fails", async () => {
    liveSessionsPushLive([frame({ id: "a", running: true })] as RunEvent[]);
    __setTestHooks({ fetch: answering(null, false) });

    await refreshLiveSessions();

    expect(__getLiveSessions()).toEqual([{ id: "a", running: true, since: 1 }]);
  });

  it("never lets a poll answer overwrite a newer push", async () => {
    // The measured order of the day: the poll leaves, a run ends, the push
    // arrives, THEN the poll answers with the world as it was. A store that
    // took the later answer would resurrect a finished session for five
    // seconds, every five seconds.
    let answer: (value: unknown) => void = () => {};
    __setTestHooks({
      fetch: (() =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              ok: true,
              json: () => Promise.resolve([{ id: "a", running: true, since: 1 }]),
            } as Response);
        })) as unknown as typeof fetch,
    });

    const inFlight = refreshLiveSessions();
    liveSessionsPushLive([frame()] as RunEvent[]); // the socket says: nothing is live
    answer(null);
    await inFlight;

    expect(__getLiveSessions()).toEqual([]);
  });

  it("stops polling when the page lets it go", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    __setTestHooks({
      fetch: ((url: string) => {
        calls.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response);
      }) as unknown as typeof fetch,
    });

    const stop = startLiveSessionsPoll();
    vi.advanceTimersByTime(LIVE_POLL_MS * 2);
    const during = calls.length;
    stop();
    vi.advanceTimersByTime(LIVE_POLL_MS * 3);

    expect(during).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBe(during);
    vi.useRealTimers();
  });
});
