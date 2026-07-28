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

  it("names exactly the four faces, structured first", () => {
    expect(TRACE_FACES).toEqual(["structured", "insight", "compact", "raw"]);
  });

  // Nobody's trace changes shape on upgrade: this is what every row did before
  // the master switch existed.
  it("opens frames structured out of the box", () => {
    expect(DEFAULT_TRACE_FACE).toBe("structured");
    expect(currentTraceFace().face).toBe("structured");
  });

  it("set + read round-trips", () => {
    setTraceFace("raw");
    expect(currentTraceFace().face).toBe("raw");
    setTraceFace("compact");
    expect(currentTraceFace().face).toBe("compact");
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
    expect(parseTraceFace("compact")).toBe("compact");
    expect(parseTraceFace("insight")).toBe("insight");
  });

  it("falls back to the default for absent, malformed or foreign storage", () => {
    expect(parseTraceFace(null)).toBe(DEFAULT_TRACE_FACE);
    expect(parseTraceFace("")).toBe(DEFAULT_TRACE_FACE);
    expect(parseTraceFace("Insight")).toBe(DEFAULT_TRACE_FACE);
    expect(parseTraceFace("json")).toBe(DEFAULT_TRACE_FACE);
  });
});

describe("a row on top of the master", () => {
  beforeEach(() => {
    setTraceFace("structured");
  });

  it("follows the master while the row was never touched", () => {
    expect(rowFace(currentTraceFace(), null)).toBe("structured");
    setTraceFace("raw");
    expect(rowFace(currentTraceFace(), null)).toBe("raw");
  });

  it("shows the hand-picked face over the master", () => {
    const pref = currentTraceFace();
    expect(rowFace(pref, { face: "raw", epoch: pref.epoch })).toBe("raw");
  });

  // The complaint that produced the master switch was "otherwise I have to
  // switch every row" — so a master that left touched rows alone would look
  // broken in exactly the case it exists for.
  it("discards the hand-picked face when the master moves", () => {
    const override = { face: "raw" as const, epoch: currentTraceFace().epoch };
    setTraceFace("compact");
    expect(rowFace(currentTraceFace(), override)).toBe("compact");
  });

  it("survives a re-read of the same master (scrolling, streaming, re-render)", () => {
    const override = { face: "raw" as const, epoch: currentTraceFace().epoch };
    expect(rowFace(currentTraceFace(), override)).toBe("raw");
    expect(rowFace(currentTraceFace(), override)).toBe("raw");
  });

  // Stamping an override with the master's VALUE would resurrect it here.
  it("never resurrects an override when the master returns to where it was", () => {
    const override = { face: "raw" as const, epoch: currentTraceFace().epoch };
    setTraceFace("compact");
    setTraceFace("structured");
    expect(rowFace(currentTraceFace(), override)).toBe("structured");
  });

  it("leaves a row alone when the master is set to what it already was", () => {
    const override = { face: "raw" as const, epoch: currentTraceFace().epoch };
    setTraceFace("structured");
    expect(rowFace(currentTraceFace(), override)).toBe("raw");
  });
});
