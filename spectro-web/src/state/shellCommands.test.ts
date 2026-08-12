// The channel the desktop menus reach the page through.
//
// The suite runs in plain Node (no jsdom), so the listener is driven through an
// injected event target the way aboutSignal.test.ts and browserLog.test.ts do.
//
// Two cases earn their keep beyond the plumbing. The first imports BOTH id
// lists — the shell's and this mirror — and compares them: aboutSignal.test.ts
// can only read the shell's menu module as text, because it imports an electron
// type; shellCommands.ts imports nothing, so the pin is an equality instead of
// a substring. The buffer case pins the race: the shell dispatches on
// did-finish-load and React mounts after that, so a command sent to a freshly
// created window arrives before anything is listening.

import { beforeEach, describe, expect, it } from "vitest";
import {
  SHELL_COMMAND,
  SHELL_COMMAND_IDS,
  listenForShellCommands,
  onShellCommand,
  type ShellCommand,
} from "./shellCommands";
import {
  SHELL_COMMAND as SHELL_COMMAND_SHELL,
  SHELL_COMMAND_IDS as SHELL_COMMAND_IDS_SHELL,
  shellCommandScript,
} from "../../../spectro-desktop/src/shellCommands";

function fakeTarget() {
  const listeners = new Map<string, ((e: Event) => void)[]>();
  return {
    addEventListener(type: string, listener: (e: Event) => void): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (e: Event) => void): void {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatch(type: string, detail: unknown): void {
      for (const l of listeners.get(type) ?? []) l({ detail } as unknown as Event);
    },
    count(type: string): number {
      return (listeners.get(type) ?? []).length;
    },
  };
}

/** Drain anything a previous case buffered, so each starts from empty. */
beforeEach(() => {
  onShellCommand(() => {})();
});

/** Run a script the shell would hand to executeJavaScript, and report what the
 *  page would have seen. The point is that the script is EVALUATED, not read. */
function evaluate(script: string): ShellCommand | null {
  let seen: ShellCommand | null = null;
  const win = {
    dispatchEvent(e: { type: string; detail: ShellCommand }): boolean {
      if (e.type === SHELL_COMMAND) seen = e.detail;
      return true;
    },
  };
  class FakeCustomEvent {
    type: string;
    detail: ShellCommand;
    constructor(type: string, init: { detail: ShellCommand }) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  new Function("window", "CustomEvent", script)(win, FakeCustomEvent);
  return seen;
}

describe("the shell command channel", () => {
  it("mirrors the shell's command list exactly", () => {
    expect(SHELL_COMMAND).toBe(SHELL_COMMAND_SHELL);
    expect([...SHELL_COMMAND_IDS]).toEqual([...SHELL_COMMAND_IDS_SHELL]);
  });

  it("hands a menu command to the app", () => {
    const target = fakeTarget();
    listenForShellCommands(target);
    const seen: ShellCommand[] = [];
    onShellCommand((c) => seen.push(c));

    target.dispatch(SHELL_COMMAND, { id: "tab.set", arg: "trace" });
    expect(seen).toEqual([{ id: "tab.set", arg: "trace" }]);
  });

  it("holds a command that arrives before the app is listening", () => {
    const target = fakeTarget();
    listenForShellCommands(target);
    // did-finish-load fires before React mounts, so this is the ordinary case
    // for a window the menu just created, not an edge case.
    target.dispatch(SHELL_COMMAND, { id: "doctor.open" });

    const seen: ShellCommand[] = [];
    onShellCommand((c) => seen.push(c));
    expect(seen).toEqual([{ id: "doctor.open" }]);

    // Exactly once: a buffer that replays on every mount would re-open the
    // panel forever.
    const later: ShellCommand[] = [];
    onShellCommand((c) => later.push(c));
    expect(later).toEqual([]);
  });

  it("ignores an event with no usable detail", () => {
    const target = fakeTarget();
    listenForShellCommands(target);
    const seen: ShellCommand[] = [];
    onShellCommand((c) => seen.push(c));

    target.dispatch(SHELL_COMMAND, undefined);
    target.dispatch(SHELL_COMMAND, {});
    target.dispatch(SHELL_COMMAND, { id: 7 });
    target.dispatch(SHELL_COMMAND, { id: "" });
    expect(seen).toEqual([]);
  });

  it("stops listening when the subscription is released", () => {
    const target = fakeTarget();
    const stop = listenForShellCommands(target);
    const seen: ShellCommand[] = [];
    const off = onShellCommand((c) => seen.push(c));

    off();
    stop();
    target.dispatch(SHELL_COMMAND, { id: "chat.new" });

    expect(seen).toEqual([]);
    expect(target.count(SHELL_COMMAND)).toBe(0);
  });

  it("escapes the argument it puts in the page", () => {
    // The script is a string handed to executeJavaScript. A demo filename or a
    // label carrying a quote must not be able to end the literal and start
    // being code.
    expect(evaluate(shellCommandScript("chat.new"))).toEqual({ id: "chat.new" });
    expect(evaluate(shellCommandScript("tab.set", "lab"))).toEqual({ id: "tab.set", arg: "lab" });
    // A quote, a backslash, a closing script tag, a newline, and U+2028 —
    // the line separator that used to end a JavaScript string literal outright.
    const nasty = "a\"b'c\\d</script>\n\u2028end";
    expect(evaluate(shellCommandScript("stategraph.demo", nasty))).toEqual({
      id: "stategraph.demo",
      arg: nasty,
    });
  });
});
