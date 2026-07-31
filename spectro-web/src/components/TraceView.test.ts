// Pins the class the trace table wears for its optional columns. The modifier
// names are the contract with panels.css: each one drops exactly one track from
// the grid that header and rows share, so the two never fall out of step.

import { describe, expect, it } from "vitest";
import { traceTableClass } from "./TraceView";

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
