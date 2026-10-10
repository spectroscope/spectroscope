// Card 430, criterion 1 and card 481: the mode is learn, light or developer, learn by default, kept in
// local storage under one key, and followed by every open window through the
// browser's `storage` event. One test per path, the listener included.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_MODE,
  VIEW_MODES,
  VIEW_MODE_KEY,
  __resetViewModeForTests,
  __setViewModeStorage,
  currentViewMode,
  followOtherWindows,
  readViewMode,
  setViewMode,
  subscribeViewMode,
} from "./viewMode";

/** An in-memory storage, so the suite needs no DOM. */
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

/** A storage whose every call throws, as a blocked or private one does. */
const throwing = {
  get: (): string | null => {
    throw new Error("SecurityError");
  },
  set: (): void => {
    throw new Error("SecurityError");
  },
};

/** A window stand-in: an EventTarget the listener can hang off. */
function windowLike() {
  return new EventTarget();
}

/** A storage event as another window of the same origin fires it. */
function storageEvent(key: string | null, newValue: string | null): Event {
  const e = new Event("storage");
  Object.assign(e, { key, newValue });
  return e;
}

describe("the mode store (criterion 1)", () => {
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

  it("is learn when nothing is stored", () => {
    expect(DEFAULT_VIEW_MODE).toBe("learn");
    expect(readViewMode()).toBe("learn");
    expect(currentViewMode()).toBe("learn");
  });

  it("reads a stored light before the first render", () => {
    __setViewModeStorage(memory({ [VIEW_MODE_KEY]: "light" }));
    __resetViewModeForTests();
    expect(currentViewMode()).toBe("light");
  });

  it("lists the three modes, learn first", () => {
    expect([...VIEW_MODES]).toEqual(["learn", "light", "developer"]);
  });

  it("reads a stored developer before the first render", () => {
    __setViewModeStorage(memory({ [VIEW_MODE_KEY]: "developer" }));
    __resetViewModeForTests();
    expect(currentViewMode()).toBe("developer");
  });

  it("stores developer under the one key and reads it back after a reload", () => {
    setViewMode("developer");
    expect([...store.data.entries()]).toEqual([[VIEW_MODE_KEY, "developer"]]);
    __resetViewModeForTests();
    expect(currentViewMode()).toBe("developer");
  });

  it("follows a switch to developer made in another window", () => {
    const win = windowLike();
    const stop = followOtherWindows(win);
    win.dispatchEvent(storageEvent(VIEW_MODE_KEY, "developer"));
    expect(currentViewMode()).toBe("developer");
    stop();
  });

  it("reads a stored value that is none of the three words as learn", () => {
    for (const odd of ["LIGHT", "edu", "", "Developer", "dev", '"light"']) {
      __setViewModeStorage(memory({ [VIEW_MODE_KEY]: odd }));
      expect(readViewMode(), odd).toBe("learn");
    }
  });

  it("reads a storage that throws as learn, and a switch still takes effect", () => {
    __setViewModeStorage(throwing);
    __resetViewModeForTests();
    expect(currentViewMode()).toBe("learn");
    setViewMode("light");
    expect(currentViewMode()).toBe("light");
  });

  it("stores the mode word and nothing else under its one key", () => {
    setViewMode("light");
    expect([...store.data.entries()]).toEqual([[VIEW_MODE_KEY, "light"]]);
    setViewMode("learn");
    expect([...store.data.entries()]).toEqual([[VIEW_MODE_KEY, "learn"]]);
  });

  it("tells its listeners once per change, and not for the mode it already has", () => {
    const heard: string[] = [];
    const stop = subscribeViewMode(() => heard.push(currentViewMode()));
    setViewMode("light");
    setViewMode("light");
    setViewMode("learn");
    stop();
    setViewMode("light");
    expect(heard).toEqual(["light", "learn"]);
  });

  it("follows a switch made in another window through the storage event", () => {
    const win = windowLike();
    const stop = followOtherWindows(win);
    const heard: string[] = [];
    const unsub = subscribeViewMode(() => heard.push(currentViewMode()));
    win.dispatchEvent(storageEvent(VIEW_MODE_KEY, "light"));
    expect(currentViewMode()).toBe("light");
    win.dispatchEvent(storageEvent(VIEW_MODE_KEY, "learn"));
    expect(currentViewMode()).toBe("learn");
    expect(heard).toEqual(["light", "learn"]);
    // The other window wrote the value already; following it writes nothing.
    expect(store.data.size).toBe(0);
    unsub();
    stop();
    win.dispatchEvent(storageEvent(VIEW_MODE_KEY, "light"));
    expect(currentViewMode()).toBe("learn");
  });

  it("ignores other keys, and reads a removed or odd value from another window as learn", () => {
    const win = windowLike();
    const stop = followOtherWindows(win);
    setViewMode("light");
    win.dispatchEvent(storageEvent("spectroscope:lang", "de"));
    expect(currentViewMode()).toBe("light");
    win.dispatchEvent(storageEvent(VIEW_MODE_KEY, "nonsense"));
    expect(currentViewMode()).toBe("learn");
    setViewMode("light");
    win.dispatchEvent(storageEvent(VIEW_MODE_KEY, null));
    expect(currentViewMode()).toBe("learn");
    setViewMode("light");
    // localStorage.clear() in another window fires with a null key.
    win.dispatchEvent(storageEvent(null, null));
    expect(currentViewMode()).toBe("learn");
    stop();
  });
});
