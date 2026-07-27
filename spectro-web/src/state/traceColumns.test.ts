// Pins for the trace's optional columns (owner 2026-07-27): host and model can
// be switched off, both start ON, and a stored choice wins over that default.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TRACE_COLUMNS, TRACE_COLUMNS, currentTraceColumns, effectiveTraceColumns, parseTraceColumns, setTraceColumn, traceColumnData } from "./traceColumns";

describe("traceColumns", () => {
  beforeEach(() => {
    setTraceColumn("host", true);
    setTraceColumn("model", true);
  });

  it("shows both optional columns by default", () => {
    expect(DEFAULT_TRACE_COLUMNS).toEqual({ host: true, model: true });
    expect(currentTraceColumns()).toEqual({ host: true, model: true });
  });

  it("names exactly the two optional columns, host first", () => {
    expect(TRACE_COLUMNS).toEqual(["host", "model"]);
  });

  it("set + read round-trips per column and leaves the other one alone", () => {
    setTraceColumn("host", false);
    expect(currentTraceColumns()).toEqual({ host: false, model: true });
    setTraceColumn("model", false);
    expect(currentTraceColumns()).toEqual({ host: false, model: false });
    setTraceColumn("host", true);
    expect(currentTraceColumns()).toEqual({ host: true, model: false });
  });

  // useSyncExternalStore compares snapshots by identity: a fresh object on
  // every read would re-render the trace forever.
  it("keeps the snapshot identical until something actually changes", () => {
    const before = currentTraceColumns();
    setTraceColumn("host", true);
    expect(currentTraceColumns()).toBe(before);
    setTraceColumn("host", false);
    expect(currentTraceColumns()).not.toBe(before);
  });

  it("lets a stored preference win over the default", () => {
    expect(parseTraceColumns('{"host":false,"model":true}')).toEqual({ host: false, model: true });
    expect(parseTraceColumns('{"host":false,"model":false}')).toEqual({ host: false, model: false });
  });

  it("falls back to the default for absent, malformed or foreign storage", () => {
    expect(parseTraceColumns(null)).toEqual(DEFAULT_TRACE_COLUMNS);
    expect(parseTraceColumns("not json")).toEqual(DEFAULT_TRACE_COLUMNS);
    expect(parseTraceColumns("[]")).toEqual(DEFAULT_TRACE_COLUMNS);
    expect(parseTraceColumns('{"host":"no"}')).toEqual(DEFAULT_TRACE_COLUMNS);
  });

  it("keeps the default for a column a half-written record does not mention", () => {
    expect(parseTraceColumns('{"host":false}')).toEqual({ host: false, model: true });
    expect(parseTraceColumns('{"model":false}')).toEqual({ host: true, model: false });
  });
});

describe("columns a session cannot fill", () => {
  it("finds a column that has at least one value", () => {
    expect(traceColumnData([{ host: "", model: null }, { host: "api.anthropic.com" }])).toEqual({
      host: true,
      model: false,
    });
  });

  it("treats whitespace as empty", () => {
    expect(traceColumnData([{ host: "   ", model: "\t" }])).toEqual({ host: false, model: false });
  });

  it("hides a column the session has no data for", () => {
    // A VS Code agent export records neither; the format has no field for them.
    expect(effectiveTraceColumns({ host: true, model: true }, { host: false, model: false })).toEqual({
      host: false,
      model: false,
    });
  });

  it("never turns a column back on that the reader switched off", () => {
    expect(effectiveTraceColumns({ host: false, model: true }, { host: true, model: true })).toEqual({
      host: false,
      model: true,
    });
  });

  it("leaves a column alone when the session fills it", () => {
    expect(effectiveTraceColumns({ host: true, model: true }, { host: true, model: true })).toEqual({
      host: true,
      model: true,
    });
  });
});
