// Card 301: the dock holds three panels now, and exactly ONE is mounted.
// The read half of that choice is pure, so the gate can bite the key and the
// round-trip without a DOM to click in — the same shape LENS_STORAGE_KEY and
// ROWS_STORAGE_KEY already use in LabView.

import { describe, expect, it, vi, afterEach } from "vitest";
import { DOCK_TABS, dockTabFrom, DOCK_TAB_STORAGE_KEY, persistDockTab } from "./labDockTabs";

afterEach(() => vi.unstubAllGlobals());

describe("dockTabFrom — the stored choice", () => {
  it("keeps every tab the dock actually has", () => {
    for (const tab of DOCK_TABS) expect(dockTabFrom(tab)).toBe(tab);
  });

  it("falls back to the context peak, the panel card 300 shipped", () => {
    expect(dockTabFrom(null)).toBe("ctx");
    expect(dockTabFrom("")).toBe("ctx");
    expect(dockTabFrom("nonsense")).toBe("ctx");
  });

  it("lists the three panels in reading order", () => {
    expect([...DOCK_TABS]).toEqual(["ctx", "msg", "files"]);
  });
});

describe("persistDockTab — the write half", () => {
  it("writes the choice under the dock's own key", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    persistDockTab("files");
    expect(setItem).toHaveBeenCalledWith(DOCK_TAB_STORAGE_KEY, "files");
  });

  it("does not use a key another lab preference already owns", () => {
    expect(DOCK_TAB_STORAGE_KEY).not.toBe("spectroscope.lab.view");
    expect(DOCK_TAB_STORAGE_KEY).not.toBe("spectroscope.lab.lens");
    expect(DOCK_TAB_STORAGE_KEY).not.toBe("spectroscope.lab.rows");
  });

  it("survives a browser that refuses to store anything", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("private mode");
      },
    });
    expect(() => persistDockTab("msg")).not.toThrow();
  });
});
