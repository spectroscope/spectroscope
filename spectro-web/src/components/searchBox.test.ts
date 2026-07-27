// House test style: pure logic only, no DOM/testing-library (the repo has
// none). What can drift here is not the markup but the decisions AROUND it —
// which chord counts as "find" on which platform, what the readout says when
// nothing matched, and whether the hotkey install can be removed cleanly.
// The readout helper deliberately returns a shape rather than a translated
// string: these pins then hold whatever the i18n table later says.

import { beforeEach, describe, expect, it } from "vitest";
import { getSearch, openSearch, resetSearch, setQuery } from "../state/search";
import { installSearchHotkey, isApplePlatform, isFindChord, keyIntent, searchReadout } from "./SearchBox";

beforeEach(() => resetSearch());

describe("searchReadout", () => {
  it("says nothing at all while the query is empty", () => {
    // Not "0 / 0": an empty box has not searched yet, it has not failed.
    expect(searchReadout("", 0, 0)).toEqual({ kind: "idle" });
    expect(searchReadout("   ", 0, 0)).toEqual({ kind: "idle" });
  });

  it("reports a real query with no hits as its own state, never as 0 / 0", () => {
    expect(searchReadout("zzz", 0, 0)).toEqual({ kind: "none" });
  });

  it("counts from one for the reader, from zero for the store", () => {
    expect(searchReadout("a", 17, 2)).toEqual({ kind: "at", position: 3, total: 17 });
    expect(searchReadout("a", 17, 0)).toEqual({ kind: "at", position: 1, total: 17 });
  });

  it("clamps an index that outran the count", () => {
    // A view can report a smaller count in the same frame the index moved;
    // the readout must stay inside the set rather than print "9 / 3".
    expect(searchReadout("a", 3, 8)).toEqual({ kind: "at", position: 3, total: 3 });
    expect(searchReadout("a", 3, -2)).toEqual({ kind: "at", position: 1, total: 3 });
  });
});

describe("isFindChord", () => {
  const chord = (over: Partial<Parameters<typeof isFindChord>[0]>) => ({
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...over,
  });

  it("is Cmd+F on Apple platforms", () => {
    expect(isFindChord(chord({ metaKey: true }), true)).toBe(true);
    expect(isFindChord(chord({ ctrlKey: true }), true)).toBe(false); // Ctrl+F moves the caret on macOS
  });

  it("is Ctrl+F everywhere else", () => {
    expect(isFindChord(chord({ ctrlKey: true }), false)).toBe(true);
    expect(isFindChord(chord({ metaKey: true }), false)).toBe(false);
  });

  it("takes the shifted and capital forms", () => {
    expect(isFindChord(chord({ metaKey: true, key: "F" }), true)).toBe(true);
  });

  it("is not any of the neighbouring chords", () => {
    expect(isFindChord(chord({ metaKey: true, key: "g" }), true)).toBe(false);
    expect(isFindChord(chord({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isFindChord(chord({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isFindChord(chord({}), true)).toBe(false);
  });
});

describe("isApplePlatform", () => {
  it("recognises the Apple platform strings", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("macOS")).toBe(true);
    expect(isApplePlatform("iPhone")).toBe(true);
    expect(isApplePlatform("iPad")).toBe(true);
  });

  it("leaves the rest on Ctrl", () => {
    expect(isApplePlatform("Win32")).toBe(false);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
    expect(isApplePlatform("")).toBe(false);
  });
});

describe("keyIntent", () => {
  it("steps forward on Enter and back on Shift+Enter", () => {
    expect(keyIntent({ key: "Enter", shiftKey: false })).toBe("next");
    expect(keyIntent({ key: "Enter", shiftKey: true })).toBe("prev");
  });

  it("closes on Escape", () => {
    expect(keyIntent({ key: "Escape", shiftKey: false })).toBe("close");
  });

  it("stays out of the way of typing", () => {
    expect(keyIntent({ key: "a", shiftKey: false })).toBe(null);
    expect(keyIntent({ key: "ArrowDown", shiftKey: false })).toBe(null);
  });

  it("leaves Enter alone while an IME is composing", () => {
    // That Enter commits the candidate the reader is still choosing; stepping
    // the search on it would eat the keystroke that finishes their word.
    expect(keyIntent({ key: "Enter", shiftKey: false, isComposing: true })).toBe(null);
  });
});

/** Records what was attached, so a test can fire at it and watch it detach. */
class FakeTarget {
  listeners: Array<(event: unknown) => void> = [];
  addEventListener(_type: string, listener: (event: unknown) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: unknown) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  fire(event: unknown): void {
    for (const l of [...this.listeners]) l(event);
  }
}

function findKey(): {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  prevented: boolean;
  preventDefault(): void;
} {
  return {
    key: "f",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    prevented: false,
    preventDefault(): void {
      this.prevented = true;
    },
  };
}

describe("installSearchHotkey", () => {
  it("opens the box on the chord and keeps the browser's find bar out of it", () => {
    const target = new FakeTarget();
    const off = installSearchHotkey(target, { apple: true });
    const e = findKey();
    target.fire(e);
    expect(getSearch().open).toBe(true);
    expect(e.prevented).toBe(true);
    off();
  });

  it("ignores every other key", () => {
    const target = new FakeTarget();
    const off = installSearchHotkey(target, { apple: true });
    const e = { ...findKey(), key: "p" };
    target.fire(e);
    expect(getSearch().open).toBe(false);
    expect(e.prevented).toBe(false);
    off();
  });

  it("swallows the chord while already open instead of stacking a second box", () => {
    openSearch();
    setQuery("ssh");
    const target = new FakeTarget();
    const off = installSearchHotkey(target, { apple: true });
    const e = findKey();
    target.fire(e);
    expect(e.prevented).toBe(true);
    expect(getSearch().open).toBe(true);
    expect(getSearch().query).toBe("ssh"); // re-focus and select, never a reset
    off();
  });

  it("comes off cleanly — nothing left listening after the teardown", () => {
    const target = new FakeTarget();
    const off = installSearchHotkey(target, { apple: true });
    expect(target.listeners.length).toBe(1);
    off();
    expect(target.listeners.length).toBe(0);
    const e = findKey();
    target.fire(e);
    expect(getSearch().open).toBe(false);
  });

  it("does not stack listeners when installed twice", () => {
    const target = new FakeTarget();
    const first = installSearchHotkey(target, { apple: true });
    const second = installSearchHotkey(target, { apple: true });
    expect(target.listeners.length).toBe(1);
    expect(second).toBe(first);
    first();
    expect(target.listeners.length).toBe(0);
  });

  it("wants Ctrl rather than Cmd off the Apple platforms", () => {
    const target = new FakeTarget();
    const off = installSearchHotkey(target, { apple: false });
    target.fire(findKey());
    expect(getSearch().open).toBe(false);
    target.fire({ ...findKey(), metaKey: false, ctrlKey: true });
    expect(getSearch().open).toBe(true);
    off();
  });
});
