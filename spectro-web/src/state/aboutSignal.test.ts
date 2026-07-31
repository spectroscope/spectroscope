// The About signal, and the cross-project wire it carries.
//
// The suite runs in plain Node (no jsdom), so the listener is driven through an
// injected event target the way browserLog.test.ts does it.
//
// The last case is the one that earns its keep: it reads the desktop shell's
// menu module off disk. The two halves of this wire live in different projects
// with different build systems and nothing else connects them, so a rename on
// either side would leave a menu item that clicks and does nothing — a dead
// prop of the kind card 114 found shipping.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABOUT_REQUESTED, onAboutRequested } from "./aboutSignal";

function fakeTarget() {
  const listeners = new Map<string, (() => void)[]>();
  return {
    addEventListener(type: string, listener: () => void): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: () => void): void {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatch(type: string): void {
      for (const l of listeners.get(type) ?? []) l();
    },
    count(type: string): number {
      return (listeners.get(type) ?? []).length;
    },
  };
}

describe("the About signal", () => {
  it("opens the panel when the event arrives", () => {
    const target = fakeTarget();
    let opened = 0;
    onAboutRequested(() => (opened += 1), target);

    target.dispatch(ABOUT_REQUESTED);
    expect(opened).toBe(1);
  });

  it("stops listening when the subscription is released", () => {
    const target = fakeTarget();
    let opened = 0;
    const off = onAboutRequested(() => (opened += 1), target);

    off();
    target.dispatch(ABOUT_REQUESTED);

    expect(opened).toBe(0);
    // A leaked listener would re-open the panel for every mount that ever ran.
    expect(target.count(ABOUT_REQUESTED)).toBe(0);
  });

  it("does nothing outside a browser rather than throwing", () => {
    // Server-side rendering, or a unit test that imports the footer: there is
    // no window, and the absence of a menu bar is not an error.
    expect(() => onAboutRequested(() => {})()).not.toThrow();
  });
});

describe("the desktop shell's half of the wire", () => {
  /** The Electron main process, read from the tree this bundle ships beside. */
  const shell = readFileSync(
    fileURLToPath(new URL("../../../spectro-desktop/src/menu.ts", import.meta.url)),
    "utf8",
  );

  it("dispatches the event name this module listens for", () => {
    expect(shell).toContain(ABOUT_REQUESTED);
  });

  it("reaches the panel by dispatching, not by rebuilding the notice", () => {
    // The failure this guards is not a typo: it is someone answering the menu
    // item with a native dialog full of licence text. That text would be a
    // second grant, unpinned to LICENSE, drifting from the day it is written.
    expect(shell).toContain("dispatchEvent");
    expect(shell).not.toContain("CC BY");
  });
});
