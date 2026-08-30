// Card 326: how far the source pane's tree opens.
//
// The owner: "dann können wir da auch eine option machen default (bis ebene 2
// ausgeklappt) und verbose alles ausklappen."
//
// TWO DOCTRINES EXIST IN THIS APP AND THEY DISAGREE, deliberately.
// state/disclosure.ts lets a hand-made choice SURVIVE a level change
// (`manual ?? defaultOpen(level)`), because a chat reader opens one specific
// block and means it. state/traceFace.ts has the MASTER WIN over every
// hand-made choice, because the complaint that produced it was "otherwise I
// have to switch every row".
//
// THIS CONTROL TAKES traceFace's DOCTRINE, and the reason is the same
// complaint: a reader who presses "verbose" is asking for everything open, and
// a control that left the nodes they had already folded alone would look broken
// in exactly the case it exists for. So it is built on the same mechanism —
// createFaceStore's epoch, which retires every hand-made fold at once without
// keeping a list of them.
//
// WHAT THIS FILE PINS AND WHAT IT DOES NOT. It pins the master: its default,
// its vocabulary, how far each level opens, and that every real change bumps
// the epoch. It does NOT pin the consequence — that a fold clicked shut by
// hand springs open when the master moves. JsonTree holds each node's open
// state from mount (JsonTree.tsx:76), so the master's epoch has to REMOUNT the
// tree, and this repo renders to static markup with no DOM to click in. That
// half is the builder's own mutation bite (remove the epoch from the tree's
// key, demand red), and saying so here is cheaper than a test name that
// promises it.

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_DEPTH,
  SOURCE_DEPTHS,
  currentSourceDepth,
  openLevels,
  parseSourceDepth,
  setSourceDepth,
} from "./sourceDepth";

describe("the depth master", () => {
  beforeEach(() => {
    setSourceDepth(DEFAULT_SOURCE_DEPTH);
  });

  it("ships on the owner's default rather than on verbose", () => {
    expect(DEFAULT_SOURCE_DEPTH).toBe("default");
    expect(currentSourceDepth().depth).toBe("default");
  });

  it("offers exactly the two the owner named", () => {
    expect([...SOURCE_DEPTHS]).toEqual(["default", "verbose"]);
  });

  it("round-trips a set", () => {
    setSourceDepth("verbose");
    expect(currentSourceDepth().depth).toBe("verbose");
    setSourceDepth("default");
    expect(currentSourceDepth().depth).toBe("default");
  });

  // useSyncExternalStore compares snapshots by identity: a fresh object on
  // every read would re-render the open pane forever.
  it("keeps the snapshot identical until something actually changes", () => {
    const before = currentSourceDepth();
    setSourceDepth("default");
    expect(currentSourceDepth()).toBe(before);
    setSourceDepth("verbose");
    expect(currentSourceDepth()).not.toBe(before);
  });

  it("falls back for absent, malformed or foreign storage", () => {
    for (const raw of [null, "", "Verbose", "all", "2", "constructor", "__proto__"]) {
      expect(parseSourceDepth(raw), String(raw)).toBe(DEFAULT_SOURCE_DEPTH);
    }
  });

  it("reads back every level it can write", () => {
    for (const level of SOURCE_DEPTHS) {
      expect(parseSourceDepth(level), level).toBe(level);
    }
  });
});

// The epoch is what retires the hand-made folds. Monotonic and not the value's
// own identity, because default -> verbose -> default must not resurrect a fold
// made under the first default.
describe("the epoch that retires a hand-made fold", () => {
  beforeEach(() => {
    setSourceDepth(DEFAULT_SOURCE_DEPTH);
  });

  it("moves on every real change", () => {
    const before = currentSourceDepth().epoch;
    setSourceDepth("verbose");
    expect(currentSourceDepth().epoch).not.toBe(before);
  });

  it("stands still when the master is set to what it already was", () => {
    const before = currentSourceDepth().epoch;
    setSourceDepth("default");
    expect(currentSourceDepth().epoch).toBe(before);
  });

  it("never returns to an epoch it has already been on", () => {
    const seen = new Set<number>([currentSourceDepth().epoch]);
    for (const level of ["verbose", "default", "verbose", "default"] as const) {
      setSourceDepth(level);
      const now = currentSourceDepth().epoch;
      expect(seen.has(now), `epoch ${now} came round again`).toBe(false);
      seen.add(now);
    }
  });
});

describe("how far each level opens", () => {
  // The owner's own number. Two is also JsonTree's own default
  // (JsonTree.tsx:61), so "default" is the component as it was always built and
  // the card adds the second setting rather than a new renderer.
  it("opens the default reading to level 2", () => {
    expect(openLevels("default")).toBe(2);
  });

  // Deliberately NOT pinned as a number: what "everything" has to beat is the
  // deepest thing a real record nests to, and readable.ts measured that at 9
  // structural levels over the corpus. The render suite next door drives a
  // ten-level line and asserts the bottom leaf is on screen, which is the
  // statement itself; here only the ordering, so a builder cannot satisfy
  // "verbose" with a number that is smaller than the default.
  it("opens verbose further than the default, past anything a record nests to", () => {
    expect(openLevels("verbose")).toBeGreaterThan(openLevels("default"));
    expect(openLevels("verbose")).toBeGreaterThan(9);
  });

  it("answers for every level in the vocabulary", () => {
    for (const level of SOURCE_DEPTHS) {
      expect(Number.isNaN(openLevels(level)), level).toBe(false);
      expect(openLevels(level), level).toBeGreaterThan(0);
    }
  });
});
