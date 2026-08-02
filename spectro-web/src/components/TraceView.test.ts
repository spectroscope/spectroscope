// Pins the class the trace table wears for its optional columns. The modifier
// names are the contract with panels.css: each one drops exactly one track from
// the grid that header and rows share, so the two never fall out of step.

import { describe, expect, it } from "vitest";
import { traceLinkState, traceTableClass } from "./TraceView";

describe("traceTableClass", () => {
  it("is the plain table while both optional columns show", () => {
    expect(traceTableClass({ host: true, model: true })).toBe("trace-table");
  });

  it("marks a hidden host column", () => {
    expect(traceTableClass({ host: false, model: true })).toBe("trace-table trace-table--no-host");
  });

  it("marks a hidden model column", () => {
    expect(traceTableClass({ host: true, model: false })).toBe("trace-table trace-table--no-model");
  });

  it("composes both modifiers when both columns are off", () => {
    expect(traceTableClass({ host: false, model: false })).toBe(
      "trace-table trace-table--no-host trace-table--no-model",
    );
  });
});

// The session to trace deep link (card 137). Three states, and one of them is
// silence: the trace toolbar is not where anyone learns what Langfuse is.
describe("traceLinkState", () => {
  it("shows nothing before the first export", () => {
    expect(traceLinkState(null, null)).toBe("none");
  });

  it("shows the failure line when nothing has landed", () => {
    expect(traceLinkState(null, "HTTP 401")).toBe("failed");
  });

  it("shows the link once an export landed", () => {
    expect(traceLinkState("http://localhost:3000/trace/abc", null)).toBe("link");
  });

  it("a later failure does not remove a working link", () => {
    expect(traceLinkState("http://localhost:3000/trace/abc", "HTTP 500")).toBe("link");
  });

  it("stays silent for an export that landed on a non-langfuse backend", () => {
    // A successful Jaeger export yields no url, and that is not a failure.
    expect(traceLinkState(null, null)).toBe("none");
  });
});
