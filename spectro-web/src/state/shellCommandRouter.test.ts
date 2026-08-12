// What each menu command actually does to the app.
//
// The table below is the executable form of the owner's bar: every item the
// shell can send must move something. An id that reaches the menu with no
// handler behind it fails the first case with its own name in the message —
// which is the failure that otherwise ships as a menu item that clicks and
// does nothing.

import { describe, expect, it } from "vitest";
import { SHELL_COMMAND_IDS, type ShellCommand } from "./shellCommands";
import { runShellCommand, type ShellDeps } from "./shellCommandRouter";

/** A ShellDeps whose every callback records that it was reached. */
function spyDeps(over?: Partial<ShellDeps>): { deps: ShellDeps; touched: string[] } {
  const touched: string[] = [];
  const mark = (name: string) => (): void => {
    touched.push(name);
  };
  const deps: ShellDeps = {
    newChat: mark("newChat"),
    openImport: mark("openImport"),
    openStarters: mark("openStarters"),
    openScenarios: mark("openScenarios"),
    loadStateGraphDemo: mark("loadStateGraphDemo"),
    setNav: mark("setNav"),
    fleetsLocked: false,
    openLevelPanel: mark("openLevelPanel"),
    changeTab: mark("changeTab"),
    openDoctor: mark("openDoctor"),
    openKeymap: mark("openKeymap"),
    toggleImages: mark("toggleImages"),
    abort: mark("abort"),
    ...over,
  };
  return { deps, touched };
}

/** The argument each id needs to mean anything, and what it must move. */
const EXPECTED: Record<string, { arg?: string; touches: string[] }> = {
  "chat.new": { touches: ["newChat"] },
  "import.open": { touches: ["openImport"] },
  "starters.open": { touches: ["openStarters"] },
  "scenarios.open": { touches: ["openScenarios"] },
  // The demo has to show the segment that draws it: the state graph is not
  // addressable, so loading a run without switching to it draws nothing.
  "stategraph.demo": { arg: "crag.graph.jsonl", touches: ["loadStateGraphDemo", "setNav"] },
  "nav.sessions": { touches: ["setNav"] },
  "nav.fleets": { touches: ["setNav"] },
  "nav.stategraph": { touches: ["setNav"] },
  // A tab is only on screen in the sessions segment, so picking one from the
  // menu while the state graph is showing has to come back first.
  "tab.set": { arg: "trace", touches: ["changeTab", "setNav"] },
  "doctor.open": { touches: ["openDoctor"] },
  "keymap.open": { touches: ["openKeymap"] },
  "images.toggle": { touches: ["toggleImages"] },
  "run.abort": { touches: ["abort"] },
};

describe("what a menu command does to the app", () => {
  it("routes every command the shell can send", () => {
    for (const id of SHELL_COMMAND_IDS) {
      const expected = EXPECTED[id];
      expect(expected, `no expectation written for ${id}`).toBeDefined();
      const { deps, touched } = spyDeps();
      const command: ShellCommand = expected.arg === undefined ? { id } : { id, arg: expected.arg };
      runShellCommand(command, deps);
      expect([...touched].sort(), `${id} moved nothing`).toEqual([...expected.touches].sort());
    }
    // And nothing is expected that the shell cannot send.
    expect(Object.keys(EXPECTED).sort()).toEqual([...SHELL_COMMAND_IDS].sort());
  });

  it("shows the ladder instead of doing nothing when fleets are locked", () => {
    // The sidebar's fleets button silently no-ops while the surface is locked
    // (Sidebar.tsx). A menu item must not: it teaches what is missing instead.
    const { deps, touched } = spyDeps({ fleetsLocked: true });
    runShellCommand({ id: "nav.fleets" }, deps);
    expect(touched).toEqual(["openLevelPanel"]);
  });

  it("loads the demo the menu named, and shows the segment that draws it", () => {
    const loaded: string[] = [];
    const navs: string[] = [];
    const { deps } = spyDeps({
      loadStateGraphDemo: (source: string) => loaded.push(source),
      setNav: (n) => navs.push(n),
    });
    runShellCommand({ id: "stategraph.demo", arg: "react-tools.graph.jsonl" }, deps);
    expect(loaded).toEqual(["react-tools.graph.jsonl"]);
    expect(navs).toEqual(["stategraph"]);

    // A demo row with no source behind it must not switch the segment to an
    // empty pane and call that a load.
    const bare = spyDeps({ loadStateGraphDemo: () => {}, setNav: () => {} });
    runShellCommand({ id: "stategraph.demo" }, bare.deps);
    expect(bare.touched).toEqual([]);
  });

  it("ignores a command from a newer shell", () => {
    // The packaged app ships shell and page together, but a dev run can pair a
    // new shell with an old bundle. An unknown id is silence, not a crash.
    const { deps, touched } = spyDeps();
    expect(() => runShellCommand({ id: "settings.export" }, deps)).not.toThrow();
    expect(() => runShellCommand({ id: "" }, deps)).not.toThrow();
    // Nor may a known id with an argument it cannot use guess one.
    runShellCommand({ id: "tab.set", arg: "spectrogram" }, deps);
    expect(touched).toEqual([]);
  });
});
