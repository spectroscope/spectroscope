// The module-level beacon: how a deep component tells the ladder what it just
// showed, without a prop threaded through four layers that do not care.
import { afterEach, describe, expect, it, vi } from "vitest";
import { beacon, setBeaconSink } from "./levelingBeacon";

afterEach(() => setBeaconSink(null));

describe("the leveling beacon", () => {
  it("passes the surface and the session to the sink", () => {
    const seen: [string, string | null | undefined][] = [];
    setBeaconSink((surface, sessionId) => seen.push([surface, sessionId]));
    beacon("lens");
    beacon("replay", "20260726-aaa");
    expect(seen).toEqual([
      ["lens", undefined],
      ["replay", "20260726-aaa"],
    ]);
  });

  it("is a no-op before the app has registered a sink", () => {
    // Components fire beacons on mount and on interaction; a module loaded in a
    // test, a story or a stray render must not explode for want of an app.
    expect(() => beacon("lens")).not.toThrow();
  });

  it("survives a sink that throws", () => {
    // Leveling is a nicety. A broken sink must not take a lens toggle with it.
    setBeaconSink(() => {
      throw new Error("the ladder is having a bad day");
    });
    expect(() => beacon("lens")).not.toThrow();
  });

  it("lets the app replace its sink", () => {
    const first = vi.fn();
    const second = vi.fn();
    setBeaconSink(first);
    setBeaconSink(second);
    beacon("lab");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("lab", undefined, undefined);
  });
});
