// Card 430, criteria 5, 6 and 7: light does no background work for the
// surfaces it closes, the chat sees the same thing in both modes, and the way
// back to learn loses nothing.
//
// Criterion 5 has six gates. Each has its own test here, each is bitten on its
// own (evidence 430/loop/bites.md), and each sits beside a learn twin that shows
// the work does happen there. The call sites in App are pinned in
// modeWork.drift.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { archiveEvents } from "../testkit/archiveEvents";
import type { LevelingSnapshot } from "./leveling";
import {
  applyModeSwitch,
  feedSurfaceStores,
  fetchFleetRosterIn,
  foldLiveBatch,
  foldResume,
  indexWanted,
  recordLiveOutgoing,
  returnToLearn,
  traceReachableIn,
  type ModeSwitchDeps,
} from "./modeWork";
import { initialState, LIVE_TRACE_WINDOW, reduceAll, windowTrace, type UiState } from "./reducer";
import {
  __getState as labState,
  __resetForTests as resetLab,
  backToLive as labBackToLive,
  pushLive as labPushLive,
} from "./stepper";
import type { ViewMode } from "./viewMode";

/** A list cut into batches the size a socket's rAF batch might have. */
function batches(events: RunEvent[], size: number): RunEvent[][] {
  const out: RunEvent[][] = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}

/** The live state after the whole list arrived in batches, in one mode. */
function foldLive(events: RunEvent[], mode: ViewMode, wanted = true): UiState {
  return batches(events, 37).reduce((s, batch) => foldLiveBatch(s, batch, mode, wanted), initialState);
}

/** Every field of a state except the two the trace owns. */
function chatFields(state: UiState): Omit<UiState, "trace" | "traceDropped"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { trace, traceDropped, ...rest } = state;
  return rest;
}

const OUT: ClientMessage = { type: "abort" };

describe("gate 1: trace rows in the fold", () => {
  const events = archiveEvents(1200);

  it("builds no row for a live frame in light", () => {
    const s = foldLive(events, "light");
    expect(s.turns.length).toBeGreaterThan(0);
    expect(s.trace).toEqual([]);
    expect(s.traceDropped).toBe(0);
  });

  it("builds a row per live frame in learn (twin)", () => {
    const s = foldLive(events, "learn");
    expect(s.trace).toHaveLength(events.length);
  });

  it("builds no row for an outgoing frame in light, and one in learn (twin)", () => {
    expect(recordLiveOutgoing(initialState, OUT, "light", true).trace).toEqual([]);
    expect(recordLiveOutgoing(initialState, OUT, "learn", true).trace).toHaveLength(1);
  });

  it("builds no row when a recorded session is resumed in light, and every row in learn (twin)", async () => {
    const options = { isCurrent: () => true, yieldToBrowser: () => Promise.resolve() };
    const light = await foldResume(events, "light", options);
    const learn = await foldResume(events, "learn", options);
    expect(light?.trace).toEqual([]);
    expect(learn?.trace).toHaveLength(events.length);
  });
});

describe("gate 2: the hidden trace warm-up", () => {
  const base = { nav: "sessions" as const, skillsOpen: false, enteredFleet: null, leveling: null };

  it("is not armed in light, for the live view and a recorded session alike", () => {
    expect(traceReachableIn({ ...base, mode: "light" })).toBe(false);
  });

  it("is armed in learn on the sessions segment (twin)", () => {
    expect(traceReachableIn({ ...base, mode: "learn" })).toBe(true);
  });

  it("keeps the conditions it had in learn: no fleet, no other segment, no skills view, no lock", () => {
    expect(traceReachableIn({ ...base, mode: "learn", enteredFleet: "ctx" })).toBe(false);
    expect(traceReachableIn({ ...base, mode: "learn", nav: "stategraph" })).toBe(false);
    expect(traceReachableIn({ ...base, mode: "learn", nav: "fleets" })).toBe(false);
    expect(traceReachableIn({ ...base, mode: "learn", skillsOpen: true })).toBe(false);
    const locked: LevelingSnapshot = {
      mode: "ladder",
      introSeen: true,
      level: 0,
      levelId: "dark-frame",
      ladder: {
        schemaVersion: 1,
        levels: [
          { index: 0, id: "dark-frame", nameKey: "", blurbKey: "", opens: ["chat"], advanceWhen: [] },
          { index: 1, id: "first-light", nameKey: "", blurbKey: "", opens: ["trace"], advanceWhen: [] },
        ],
        criteria: [],
      },
      marks: {},
      remaining: [],
      history: [],
    };
    expect(traceReachableIn({ ...base, mode: "learn", leveling: locked })).toBe(false);
  });
});

describe("gates 3 and 4: the Lab's live queue and the fleet store", () => {
  const batch = archiveEvents(10).slice(0, 5);

  it("feeds neither in light", () => {
    const fed: string[] = [];
    feedSurfaceStores(batch, "light", { lab: () => fed.push("lab"), fleet: () => fed.push("fleet") });
    expect(fed).toEqual([]);
  });

  it("feeds both the same batch in learn (twin)", () => {
    const fed: Array<[string, RunEvent[]]> = [];
    feedSurfaceStores(batch, "learn", {
      lab: (b) => fed.push(["lab", b]),
      fleet: (b) => fed.push(["fleet", b]),
    });
    expect(fed).toEqual([
      ["lab", batch],
      ["fleet", batch],
    ]);
  });
});

describe("gate 5: the fleet roster fetch at start", () => {
  it("is not sent in light", () => {
    let sent = 0;
    fetchFleetRosterIn("light", async () => {
      sent++;
    });
    expect(sent).toBe(0);
  });

  it("is sent in learn (twin)", () => {
    let sent = 0;
    fetchFleetRosterIn("learn", async () => {
      sent++;
    });
    expect(sent).toBe(1);
  });
});

describe("gate 6: the /llm-wire/index fetch", () => {
  it("is not wanted in light, so neither an open nor a resume waits for it", () => {
    expect(indexWanted("light")).toBe(false);
  });

  it("is wanted in learn (twin)", () => {
    expect(indexWanted("learn")).toBe(true);
  });
});

describe("the chat sees the same thing in both modes (criterion 6)", () => {
  const events = archiveEvents(3000);

  it("folds the live stream to an equal chat state, field by field, without the trace", () => {
    const learn = foldLive(events, "learn");
    const light = foldLive(events, "light");
    expect(learn.turns.length).toBeGreaterThan(10);
    expect(Object.keys(chatFields(light)).sort()).toEqual(Object.keys(chatFields(learn)).sort());
    for (const key of Object.keys(chatFields(learn)) as (keyof UiState)[]) {
      expect(light[key], key).toEqual(learn[key]);
    }
  });

  it("folds a resumed session to an equal chat state", async () => {
    const options = { isCurrent: () => true, yieldToBrowser: () => Promise.resolve() };
    const learn = (await foldResume(events, "learn", options))!;
    const light = (await foldResume(events, "light", options))!;
    expect(learn.turns.length).toBeGreaterThan(10);
    expect(chatFields(light)).toEqual(chatFields(learn));
  });
});

describe("back to learn loses nothing (criterion 7)", () => {
  const events = archiveEvents(6200);
  beforeEach(() => resetLab());
  afterEach(() => resetLab());

  /** A session that stayed in learn: its state and its Lab after every batch. */
  function stayedInLearn(wanted: boolean): { live: UiState; lab: ReturnType<typeof labState> } {
    resetLab();
    let live = initialState;
    for (const batch of batches(events, 41)) {
      live = foldLiveBatch(live, batch, "learn", wanted);
      feedSurfaceStores(batch, "learn", { lab: labPushLive, fleet: () => {} });
    }
    return { live, lab: labState() };
  }

  /** A session that ran in light and then switched back, with what the switch did. */
  function returnedFromLight(wanted: boolean): {
    live: UiState;
    lab: ReturnType<typeof labState>;
    rosterFetches: number;
  } {
    resetLab();
    let live = initialState;
    const seen: RunEvent[] = [];
    for (const batch of batches(events, 41)) {
      live = foldLiveBatch(live, batch, "light", wanted);
      feedSurfaceStores(batch, "light", { lab: labPushLive, fleet: () => {} });
      seen.push(...batch);
    }
    let rosterFetches = 0;
    const deps: ModeSwitchDeps = {
      place: () => ({
        replayId: null,
        importPath: null,
        enteredFleet: null,
        tab: "chat",
        settingsOpen: false,
      }),
      nav: () => "sessions",
      land: () => {
        throw new Error("the chat was on screen; nothing to land");
      },
      liveEvents: () => seen,
      setLive: (update) => {
        live = update(live);
      },
      traceWanted: () => wanted,
      lab: { reset: () => {}, backToLive: labBackToLive },
      fetchFleetRoster: () => {
        rosterFetches++;
      },
    };
    applyModeSwitch("learn", deps);
    return { live, lab: labState(), rosterFetches };
  }

  it("rebuilds the same windowed trace a session that stayed in learn holds, after more than 5000 events", () => {
    expect(events.length).toBeGreaterThan(LIVE_TRACE_WINDOW + 1000);
    const stayed = stayedInLearn(true);
    const back = returnedFromLight(true);
    expect(stayed.live.trace).toHaveLength(LIVE_TRACE_WINDOW);
    expect(back.live.trace).toEqual(stayed.live.trace);
    expect(back.live.traceDropped).toBe(stayed.live.traceDropped);
    expect(back.live.traceDropped).toBe(events.length - LIVE_TRACE_WINDOW);
    expect(chatFields(back.live)).toEqual(chatFields(stayed.live));
  });

  it("seeds the Lab with the same queue", () => {
    const stayed = stayedInLearn(true);
    const back = returnedFromLight(true);
    expect(stayed.lab.queue).toHaveLength(events.length);
    expect(back.lab.queue).toEqual(stayed.lab.queue);
    expect(back.lab.applied).toEqual(stayed.lab.applied);
  });

  it("fetches the fleet roster again", () => {
    expect(returnedFromLight(true).rosterFetches).toBe(1);
  });

  it("builds no trace rows when the live trace switch is off, as learn would not", () => {
    const stayed = stayedInLearn(false);
    const back = returnedFromLight(false);
    expect(stayed.live.trace).toEqual([]);
    expect(back.live.trace).toEqual([]);
    expect(back.live.traceDropped).toBe(0);
  });

  it("is the card's formula: windowTrace(reduceAll(initialState, liveEvents))", () => {
    const formula = windowTrace(reduceAll(initialState, events));
    const rebuilt = returnToLearn(foldLive(events, "light"), events, true);
    expect(rebuilt.trace).toEqual(formula.trace);
    expect(rebuilt.traceDropped).toBe(formula.traceDropped);
  });
});

describe("the switch", () => {
  function deps(over: Partial<ModeSwitchDeps>): { deps: ModeSwitchDeps; did: string[]; live: () => UiState } {
    const did: string[] = [];
    let live = foldLive(archiveEvents(300), "learn");
    return {
      did,
      live: () => live,
      deps: {
        place: () => ({
          replayId: "s1",
          importPath: null,
          enteredFleet: null,
          tab: "trace",
          settingsOpen: false,
        }),
        nav: () => "sessions",
        land: (landing) => did.push(`land:${landing.tab}:${landing.route?.kind}`),
        liveEvents: () => archiveEvents(300),
        setLive: (update) => {
          live = update(live);
        },
        traceWanted: () => true,
        lab: { reset: () => did.push("lab.reset"), backToLive: () => did.push("lab.backToLive") },
        fetchFleetRoster: () => did.push("roster"),
        ...over,
      },
    };
  }

  it("to light: lands on the chat, frees the trace rows and the Lab's queue, fetches no roster", () => {
    const run = deps({});
    expect(run.live().trace.length).toBeGreaterThan(0);
    applyModeSwitch("light", run.deps);
    expect(run.did).toEqual(["land:chat:session", "lab.reset"]);
    expect(run.live().trace).toEqual([]);
    expect(run.live().traceDropped).toBe(0);
  });

  it("to learn: rebuilds the trace, seeds the Lab and fetches the roster, landing nowhere", () => {
    const run = deps({
      place: () => ({
        replayId: null,
        importPath: null,
        enteredFleet: null,
        tab: "chat",
        settingsOpen: false,
      }),
    });
    run.deps.setLive((s) => ({ ...s, trace: [], traceDropped: 0 }));
    applyModeSwitch("learn", run.deps);
    expect(run.did).toEqual(["lab.backToLive", "roster"]);
    expect(run.live().trace.length).toBeGreaterThan(0);
  });
});
