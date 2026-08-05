// Pins for the trace's master face (owner 2026-07-27): expanded frames open in
// ONE chosen view, the choice persists, and moving the master puts every row
// back on it — a row switched by hand is an exception on top of the new
// default, not a survivor of the old one.

import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_TRACE_FACE,
  TRACE_FACES,
  currentTraceFace,
  parseTraceFace,
  rowFace,
  setTraceFace,
} from "./traceFace";

describe("traceFace", () => {
  beforeEach(() => {
    setTraceFace("structured");
  });

  it("offers five faces, structured first", () => {
    expect(TRACE_FACES).toEqual(["structured", "insight", "wire", "source"]);
  });

  // "raw" was this store's word for the wire lines until a real source line
  // existed to be confused with. The word changed, the content did not, so a
  // reader who chose it keeps what they chose; without this line parse() falls
  // through to the default and silently puts them back on structured.
  it("reads a stored legacy raw as wire", () => {
    expect(parseTraceFace("raw")).toBe("wire");
  });

  // Nobody's trace changes shape on upgrade: this is what every row did before
  // the master switch existed.
  it("opens frames structured out of the box", () => {
    expect(DEFAULT_TRACE_FACE).toBe("structured");
    expect(currentTraceFace().face).toBe("structured");
  });

  it("set + read round-trips", () => {
    setTraceFace("wire");
    expect(currentTraceFace().face).toBe("wire");
    setTraceFace("wire");
    expect(currentTraceFace().face).toBe("wire");
  });

  // useSyncExternalStore compares snapshots by identity: a fresh object on
  // every read would re-render the open frame forever.
  it("keeps the snapshot identical until something actually changes", () => {
    const before = currentTraceFace();
    setTraceFace("structured");
    expect(currentTraceFace()).toBe(before);
    setTraceFace("insight");
    expect(currentTraceFace()).not.toBe(before);
  });

  it("lets a stored choice win over the default", () => {
    expect(parseTraceFace("compact")).toBe("wire");
    expect(parseTraceFace("insight")).toBe("insight");
  });

  it("falls back to the default for absent, malformed or foreign storage", () => {
    expect(parseTraceFace(null)).toBe(DEFAULT_TRACE_FACE);
    expect(parseTraceFace("")).toBe(DEFAULT_TRACE_FACE);
    expect(parseTraceFace("Insight")).toBe(DEFAULT_TRACE_FACE);
    expect(parseTraceFace("json")).toBe(DEFAULT_TRACE_FACE);
  });

  // The rename map is a plain object, so a lookup that asks whether a word is
  // "in" it also asks Object.prototype. Storage is an arbitrary string from a
  // shared origin, and the store's whole promise is that anything foreign falls
  // back, and a face that came back as a Function would keep that promise on paper
  // and break it in the type.
  it("falls back for a word that only Object.prototype knows", () => {
    for (const word of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(typeof parseTraceFace(word), word).toBe("string");
      expect(parseTraceFace(word), word).toBe(DEFAULT_TRACE_FACE);
    }
  });

  // The one word this store really did write stays a carry-across, which is
  // what the prototype guard must not cost.
  it("still carries the renamed word across", () => {
    expect(parseTraceFace("raw")).toBe("wire");
  });
});

describe("a row on top of the master", () => {
  beforeEach(() => {
    setTraceFace("structured");
  });

  it("follows the master while the row was never touched", () => {
    expect(rowFace(currentTraceFace(), null)).toBe("structured");
    setTraceFace("wire");
    expect(rowFace(currentTraceFace(), null)).toBe("wire");
  });

  it("shows the hand-picked face over the master", () => {
    const pref = currentTraceFace();
    expect(rowFace(pref, { face: "wire", epoch: pref.epoch })).toBe("wire");
  });

  // The complaint that produced the master switch was "otherwise I have to
  // switch every row" — so a master that left touched rows alone would look
  // broken in exactly the case it exists for.
  it("discards the hand-picked face when the master moves", () => {
    const override = { face: "wire" as const, epoch: currentTraceFace().epoch };
    setTraceFace("wire");
    expect(rowFace(currentTraceFace(), override)).toBe("wire");
  });

  it("survives a re-read of the same master (scrolling, streaming, re-render)", () => {
    const override = { face: "wire" as const, epoch: currentTraceFace().epoch };
    expect(rowFace(currentTraceFace(), override)).toBe("wire");
    expect(rowFace(currentTraceFace(), override)).toBe("wire");
  });

  // Stamping an override with the master's VALUE would resurrect it here.
  it("never resurrects an override when the master returns to where it was", () => {
    const override = { face: "wire" as const, epoch: currentTraceFace().epoch };
    setTraceFace("wire");
    setTraceFace("structured");
    expect(rowFace(currentTraceFace(), override)).toBe("structured");
  });

  it("leaves a row alone when the master is set to what it already was", () => {
    const override = { face: "wire" as const, epoch: currentTraceFace().epoch };
    setTraceFace("structured");
    expect(rowFace(currentTraceFace(), override)).toBe("wire");
  });
});

// `compact` was retired (owner, 2026-08-05): it was the wire line wrapped, and
// Wire's readable reading is the same text with the escapes undone. A reader
// who had it saved must land somewhere real rather than on a blank face.
describe("the retired compact face", () => {
  it("is not offered any more", () => {
    expect(TRACE_FACES).not.toContain("compact");
  });

  it("takes a reader who saved it to wire", () => {
    expect(parseTraceFace("compact")).toBe("wire");
    // The other retired name still lands where it always did.
    expect(parseTraceFace("raw")).toBe("wire");
  });
});
