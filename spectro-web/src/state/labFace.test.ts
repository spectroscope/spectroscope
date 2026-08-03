// Pins for the lab's master tool-panel face (card 120, owner 2026-07-30): the
// tool panel opens on the JSONL-first insight tree, the structured face is one
// click away, and moving the master re-faces every open panel — a panel
// switched by hand is an exception on top of the new default, not a survivor
// of the old one (trace parity, same epoch mechanism, separate store).

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LAB_FACE, LAB_FACES, currentLabFace, panelFace, parseLabFace, setLabFace } from "./labFace";
import { currentTraceFace, rowFace, setTraceFace } from "./traceFace";

describe("labFace", () => {
  beforeEach(() => {
    setLabFace("insight");
  });

  it("names exactly the two faces, insight first", () => {
    expect(LAB_FACES).toEqual(["insight", "structured"]);
  });

  // The lab teaches the JSONL first: the tree is what every panel showed
  // before the master existed, and the AC pins it as the default.
  it("opens panels on insight out of the box", () => {
    expect(DEFAULT_LAB_FACE).toBe("insight");
    expect(currentLabFace().face).toBe("insight");
  });

  it("set + read round-trips", () => {
    setLabFace("structured");
    expect(currentLabFace().face).toBe("structured");
    setLabFace("insight");
    expect(currentLabFace().face).toBe("insight");
  });

  // useSyncExternalStore compares snapshots by identity: a fresh object on
  // every read would re-render every panel forever.
  it("keeps the snapshot identical until something actually changes", () => {
    const before = currentLabFace();
    setLabFace("insight");
    expect(currentLabFace()).toBe(before);
    setLabFace("structured");
    expect(currentLabFace()).not.toBe(before);
  });

  it("lets a stored choice win over the default", () => {
    expect(parseLabFace("structured")).toBe("structured");
    expect(parseLabFace("insight")).toBe("insight");
  });

  // "wire"/"compact"/"source" belong to the trace's store, "json" to the
  // chat's, and "raw" belonged to the trace's store until the rename. The lab's
  // two-value space must reject all of it, the retired word included.
  it("falls back to the default for absent, malformed or foreign storage", () => {
    expect(parseLabFace(null)).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("")).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("Insight")).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("json")).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("wire")).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("source")).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("raw")).toBe(DEFAULT_LAB_FACE);
    expect(parseLabFace("compact")).toBe(DEFAULT_LAB_FACE);
  });

  // This store has no rename map at all, so nothing here should be reachable,
  // and a prototype lookup made it reachable anyway. The header's promise that
  // no other store's word "may leak in here through storage" covers the words
  // every object carries just as much as it covers "wire".
  it("falls back for a word that only Object.prototype knows", () => {
    for (const word of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(typeof parseLabFace(word), word).toBe("string");
      expect(parseLabFace(word), word).toBe(DEFAULT_LAB_FACE);
    }
  });
});

describe("a panel on top of the lab master", () => {
  beforeEach(() => {
    setLabFace("insight");
  });

  it("follows the master while the panel was never touched", () => {
    expect(panelFace(currentLabFace(), null)).toBe("insight");
    setLabFace("structured");
    expect(panelFace(currentLabFace(), null)).toBe("structured");
  });

  it("shows the hand-picked face over the master", () => {
    const pref = currentLabFace();
    expect(panelFace(pref, { face: "structured", epoch: pref.epoch })).toBe("structured");
  });

  // The owner decision (2026-07-30): the master ALSO switches already-open
  // panels — a master that left touched panels alone would look broken in
  // exactly the case it exists for.
  it("discards the hand-picked face when the master moves", () => {
    const override = { face: "structured" as const, epoch: currentLabFace().epoch };
    setLabFace("structured");
    expect(panelFace(currentLabFace(), override)).toBe("structured");
    setLabFace("insight");
    expect(panelFace(currentLabFace(), override)).toBe("insight");
  });

  it("survives a re-read of the same master (streaming, re-render)", () => {
    const override = { face: "structured" as const, epoch: currentLabFace().epoch };
    expect(panelFace(currentLabFace(), override)).toBe("structured");
    expect(panelFace(currentLabFace(), override)).toBe("structured");
  });

  // Stamping an override with the master's VALUE would resurrect it here.
  it("never resurrects an override when the master returns to where it was", () => {
    const override = { face: "structured" as const, epoch: currentLabFace().epoch };
    setLabFace("structured");
    setLabFace("insight");
    expect(panelFace(currentLabFace(), override)).toBe("insight");
  });

  it("leaves a panel alone when the master is set to what it already was", () => {
    const override = { face: "structured" as const, epoch: currentLabFace().epoch };
    setLabFace("insight");
    expect(panelFace(currentLabFace(), override)).toBe("structured");
  });
});

describe("the lab store next to the trace store", () => {
  beforeEach(() => {
    setLabFace("insight");
    setTraceFace("structured");
  });

  // Card scope item 4: same mechanism, SEPARATE stores — moving one master
  // must neither move the other nor retire its overrides.
  it("moves independently of the trace master", () => {
    setLabFace("structured");
    expect(currentTraceFace().face).toBe("structured");
    setTraceFace("wire");
    expect(currentLabFace().face).toBe("structured");
  });

  it("keeps its epochs to itself", () => {
    const traceOverride = { face: "compact" as const, epoch: currentTraceFace().epoch };
    setLabFace("structured");
    expect(rowFace(currentTraceFace(), traceOverride)).toBe("compact");
    const labOverride = { face: "structured" as const, epoch: currentLabFace().epoch };
    setTraceFace("insight");
    expect(panelFace(currentLabFace(), labOverride)).toBe("structured");
  });
});
