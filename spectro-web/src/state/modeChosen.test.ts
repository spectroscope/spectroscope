// Card 455: the mark that the first-start mode screen has been answered. It is
// a second local-storage key next to the mode word (owner decision of
// 2026-09-29), so the desktop app and a browser each ask once, the way each
// keeps its own mode.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODE_CHOSEN_KEY,
  MODE_SCREEN_GENERATION,
  VIEW_MODE_KEY,
  __resetViewModeForTests,
  __setViewModeStorage,
  chooseViewMode,
  currentViewMode,
  followOtherWindows,
  modeChosen,
  readModeChosen,
  subscribeModeChosen,
  subscribeViewMode,
} from "./viewMode";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key: string) => data.get(key) ?? null,
    set: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const throwing = {
  get: (): string | null => {
    throw new Error("SecurityError");
  },
  set: (): void => {
    throw new Error("SecurityError");
  },
};

function storageEvent(key: string | null, newValue: string | null): Event {
  const e = new Event("storage");
  Object.assign(e, { key, newValue });
  return e;
}

describe("the mode screen mark", () => {
  let store = memory();
  beforeEach(() => {
    store = memory();
    __setViewModeStorage(store);
    __resetViewModeForTests();
  });
  afterEach(() => {
    __setViewModeStorage(memory());
    __resetViewModeForTests();
  });

  it("sits under its own key, next to the mode word", () => {
    expect(MODE_CHOSEN_KEY).not.toBe(VIEW_MODE_KEY);
    expect(MODE_CHOSEN_KEY.startsWith("spectroscope:")).toBe(true);
  });

  it("is unset on a fresh install", () => {
    expect(readModeChosen()).toBe(false);
    expect(modeChosen()).toBe(false);
  });

  it("is unset for an existing install that stored a mode but never saw the screen", () => {
    store = memory({ [VIEW_MODE_KEY]: "light" });
    __setViewModeStorage(store);
    __resetViewModeForTests();
    expect(modeChosen()).toBe(false);
    // Its current mode stays in place until it chooses.
    expect(currentViewMode()).toBe("light");
  });

  it("choosing writes the mode and the mark, and tells the listeners", () => {
    let told = 0;
    const stop = subscribeViewMode(() => told++);
    chooseViewMode("light");
    stop();
    expect(store.data.get(VIEW_MODE_KEY)).toBe("light");
    expect(store.data.get(MODE_CHOSEN_KEY)).toBe(String(MODE_SCREEN_GENERATION));
    expect(modeChosen()).toBe(true);
    expect(currentViewMode()).toBe("light");
    expect(told).toBeGreaterThan(0);
  });

  it("choosing the mode already in place still sets the mark, and tells the mark's listeners once", () => {
    let modeTold = 0;
    let markTold = 0;
    const stopMode = subscribeViewMode(() => modeTold++);
    const stopMark = subscribeModeChosen(() => markTold++);
    chooseViewMode("learn");
    stopMode();
    stopMark();
    expect(store.data.get(MODE_CHOSEN_KEY)).toBe(String(MODE_SCREEN_GENERATION));
    expect(modeChosen()).toBe(true);
    expect(markTold).toBe(1);
    // The mode did not change, so the mode's listeners hear nothing.
    expect(modeTold).toBe(0);
  });

  it("survives a reload: a new page load reads the mark back", () => {
    chooseViewMode("learn");
    __resetViewModeForTests();
    expect(modeChosen()).toBe(true);
    expect(currentViewMode()).toBe("learn");
  });

  it("reads any value but the current generation as not chosen", () => {
    store = memory({ [MODE_CHOSEN_KEY]: "yes" });
    __setViewModeStorage(store);
    __resetViewModeForTests();
    expect(modeChosen()).toBe(false);
    store = memory({ [MODE_CHOSEN_KEY]: String(MODE_SCREEN_GENERATION) });
    __setViewModeStorage(store);
    __resetViewModeForTests();
    expect(modeChosen()).toBe(true);
  });

  it("with a blocked storage reads as not chosen, and a choice still holds for this window", () => {
    __setViewModeStorage(throwing);
    __resetViewModeForTests();
    expect(modeChosen()).toBe(false);
    expect(() => chooseViewMode("light")).not.toThrow();
    expect(modeChosen()).toBe(true);
    expect(currentViewMode()).toBe("light");
  });

  it("follows another window that chose", () => {
    const target = new EventTarget();
    const stop = followOtherWindows(target);
    target.dispatchEvent(storageEvent(MODE_CHOSEN_KEY, String(MODE_SCREEN_GENERATION)));
    expect(modeChosen()).toBe(true);
    target.dispatchEvent(storageEvent(null, null));
    expect(modeChosen()).toBe(false);
    stop();
  });
});

// Card 518: the mark carries a generation. A stored value equal to the current
// generation reads as chosen; the "1" of every installation that chose before
// this card reads as not chosen, so the screen returns once and offers developer.
describe("the mark's generation (card 518)", () => {
  let store = memory();
  const load = (initial: Record<string, string>): void => {
    store = memory(initial);
    __setViewModeStorage(store);
    __resetViewModeForTests();
  };
  beforeEach(() => load({}));
  afterEach(() => {
    __setViewModeStorage(memory());
    __resetViewModeForTests();
  });

  it("is the number 2 on this card", () => {
    expect(MODE_SCREEN_GENERATION).toBe(2);
  });

  it("reading 1 of 4, unset: not chosen", () => {
    load({ [VIEW_MODE_KEY]: "learn" });
    expect(readModeChosen()).toBe(false);
    expect(modeChosen()).toBe(false);
  });

  it("reading 2 of 4, old generation: a stored 1 from before this card reads as not chosen", () => {
    load({ [VIEW_MODE_KEY]: "learn", [MODE_CHOSEN_KEY]: "1" });
    expect(readModeChosen()).toBe(false);
    expect(modeChosen()).toBe(false);
    // The mode chosen back then stays in force behind the screen.
    expect(currentViewMode()).toBe("learn");
  });

  it("reading 3 of 4, current generation: a choice writes it and a reload reads it back as chosen", () => {
    load({ [VIEW_MODE_KEY]: "learn", [MODE_CHOSEN_KEY]: "1" });
    chooseViewMode("developer");
    expect(store.data.get(MODE_CHOSEN_KEY)).toBe(String(MODE_SCREEN_GENERATION));
    __resetViewModeForTests();
    expect(readModeChosen()).toBe(true);
    expect(modeChosen()).toBe(true);
    expect(currentViewMode()).toBe("developer");
  });

  it("reading 4 of 4, junk: not chosen", () => {
    for (const junk of ["", "yes", "true", "02", " 2", "2.0", "3", "-1", "NaN"]) {
      load({ [MODE_CHOSEN_KEY]: junk });
      expect(readModeChosen(), JSON.stringify(junk)).toBe(false);
    }
  });

  it("a developer user who chose on 0.15.0 and picks developer again changes no mode", () => {
    load({ [VIEW_MODE_KEY]: "developer", [MODE_CHOSEN_KEY]: "1" });
    expect(modeChosen()).toBe(false);
    expect(currentViewMode()).toBe("developer");
    let modeTold = 0;
    const stop = subscribeViewMode(() => modeTold++);
    chooseViewMode("developer");
    stop();
    expect(modeTold).toBe(0);
    expect(currentViewMode()).toBe("developer");
    expect(store.data.get(VIEW_MODE_KEY)).toBe("developer");
    expect(modeChosen()).toBe(true);
  });

  it("another window that writes the old generation does not close the screen here", () => {
    const target = new EventTarget();
    const stop = followOtherWindows(target);
    target.dispatchEvent(storageEvent(MODE_CHOSEN_KEY, "1"));
    expect(modeChosen()).toBe(false);
    target.dispatchEvent(storageEvent(MODE_CHOSEN_KEY, String(MODE_SCREEN_GENERATION)));
    expect(modeChosen()).toBe(true);
    stop();
  });
});
