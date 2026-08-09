import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_WANTED_KEY, currentLiveWanted, readLiveWanted, setLiveWanted } from "./liveWanted";

/**
 * A localStorage that behaves like a browser's.
 *
 * The test environment's own `localStorage` is a bare object with none of the
 * methods on it (and there is no `window` either — this runs on node), so every
 * call throws and the module's guards swallow it. A persistence test against
 * that would pass while proving nothing, so a real one gets installed.
 */
function installStore(): Record<string, string> {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
  return store;
}

describe("whether the speaker asked for live text", () => {
  let store: Record<string, string>;
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    store = installStore();
    setLiveWanted(false);
  });

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
  });

  it("is off until somebody turns it on", () => {
    // Live transcription is a METERED path and a new one: a realtime session
    // costs by the minute where the batch call costs by the clip. A feature
    // that spends money differently is switched on by a person, not by an
    // upgrade.
    expect(readLiveWanted()).toBe(false);
  });

  it("remembers the choice across a reload", () => {
    setLiveWanted(true);
    expect(store[LIVE_WANTED_KEY]).toBe("1");
    expect(readLiveWanted()).toBe(true);
  });

  it("forgets it again rather than storing a no", () => {
    setLiveWanted(true);
    setLiveWanted(false);
    expect(store[LIVE_WANTED_KEY]).toBeUndefined();
    expect(readLiveWanted()).toBe(false);
  });

  it("reads anything that is not the stored yes as no", () => {
    // The desktop shell used to lose localStorage on every launch (card 168),
    // so a half-written or foreign value is a real shape — and it must fall to
    // the safe side rather than to the metered one.
    for (const junk of ["", "0", "true", "yes", "{}"]) {
      store[LIVE_WANTED_KEY] = junk;
      expect(readLiveWanted()).toBe(false);
    }
  });

  it("keeps the module's own answer in step with the store", () => {
    setLiveWanted(true);
    expect(currentLiveWanted()).toBe(true);
    setLiveWanted(false);
    expect(currentLiveWanted()).toBe(false);
  });

  it("survives a browser that refuses storage at all", () => {
    // Private mode. The press that set it still counts for this session; only
    // the memory of it is lost, and that is the right thing to lose.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    expect(() => setLiveWanted(true)).not.toThrow();
    expect(currentLiveWanted()).toBe(true);
    expect(readLiveWanted()).toBe(false);
  });
});
