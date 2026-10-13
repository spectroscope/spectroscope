// Card 586: the wide run view is a layout setting, kept for the page only.
//
// The layout store reads localStorage once, at module load. The reload test
// stubs localStorage before a dynamic import, so it runs the read a browser
// runs on the next load. Own file, because it resets the module registry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT, hydrateLayout } from "./layout";

const KEY = "spectroscope:layout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A localStorage over `store`, shared by every load of the module. */
function stubStorage(store: Map<string, string>): void {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

async function load() {
  vi.resetModules();
  return import("./layout");
}

describe("the wide run view in the layout store (card 586)", () => {
  it("is off by default", () => {
    expect(DEFAULT_LAYOUT.runWide).toBe(false);
  });

  it("setRunWide(true) turns it on and tells the listeners", async () => {
    stubStorage(new Map());
    const layout = await load();
    let told = 0;
    // useLayout subscribes through the store; a listener stands in for it.
    const off = layout.__subscribeForTests(() => told++);
    layout.setRunWide(true);
    expect(layout.__getState().runWide).toBe(true);
    expect(told).toBe(1);
    layout.setRunWide(true);
    expect(told).toBe(1);
    off();
  });

  // Final fix round (review M1): wide is not kept across reloads. A reload
  // starts compact, so a session with a run never opens without its chat.
  it("is not stored, and a reload starts compact", async () => {
    const store = new Map<string, string>();
    stubStorage(store);
    const first = await load();
    first.setRunWide(true);
    first.setRunWide(true);
    expect(first.__getState().runWide, "premise: on in this page").toBe(true);
    first.toggleRightPanel();
    const saved = JSON.parse(store.get(KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(saved), "premise: the layout was written").toContain("rightPanelW");
    expect(saved).not.toHaveProperty("runWide");

    const second = await load();
    expect(second.__getState().runWide).toBe(false);
  });

  it("reads a stored true from an older build as off", () => {
    expect(hydrateLayout({ runWide: true }, null).runWide).toBe(false);
    expect(hydrateLayout({ runWide: "yes" }, null).runWide).toBe(false);
    expect(hydrateLayout(null, null).runWide).toBe(false);
  });
});
