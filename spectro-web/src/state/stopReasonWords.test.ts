// Card 586, final fix round (review I3): every stop reason a runner can write
// is put in words in the chat's end lines, in both languages.
//
// The reasons are read from the Java source, not typed here: every constant
// of RunStop, and every constant of WorkflowRunner or PlaybookRunner that one
// of their end(...) calls passes as the stop reason (WorkflowRunner.EXHAUSTED).
// A new reason in the runners turns this red until the dictionary learns it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { progressLine, workflowLine } from "./playbookChat";

const RUN = "../../../spectro-core/src/main/java/dev/spectroscope/core/playbook/run/";
const java = (name: string): string =>
  readFileSync(fileURLToPath(new URL(RUN + name, import.meta.url)), "utf8");

/** `public static final String NAME = "value";` of one source file. */
function constants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/static\s+final\s+String\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"/g))
    out.set(m[1], m[2]);
  return out;
}

/** The stop reasons the runners can write, derived from their source. */
function stopReasons(): string[] {
  const runStop = constants(java("RunStop.java"));
  const reasons = new Set(runStop.values());
  for (const file of ["WorkflowRunner.java", "PlaybookRunner.java"]) {
    const source = java(file);
    const own = constants(source);
    for (const m of source.matchAll(/\bend\(\s*([A-Z][A-Z0-9_]*)\s*,/g)) {
      const value = own.get(m[1]);
      if (value !== undefined) reasons.add(value);
    }
  }
  return [...reasons].sort();
}

describe("every stop reason a runner writes has words (card 586, review I3)", () => {
  const reasons = stopReasons();

  it("finds the reasons in the source", () => {
    expect(reasons).toContain("done");
    expect(reasons).toContain("exhausted");
    expect(reasons.length).toBeGreaterThanOrEqual(12);
  });

  it("has pb.run.stop.<reason> in German and English for each", () => {
    const missing = reasons.filter((r) => !dict[`pb.run.stop.${r}`]?.de || !dict[`pb.run.stop.${r}`]?.en);
    expect(missing).toEqual([]);
  });

  it("a workflow's and a playbook's end line put each reason in words, never as written", () => {
    for (const reason of reasons) {
      const wf = workflowLine({
        runKind: "workflow",
        phase: "run_end",
        runId: "abcdefabcdef",
        stopReason: reason,
      });
      expect(wf?.infoRefKey, reason).toBe(`pb.run.stop.${reason}`);
      expect(wf?.infoVars, reason).not.toHaveProperty("ref");
      const pb = progressLine({ phase: "end", runId: "abcdefabcdef", stopReason: reason });
      expect(pb?.infoRefKey, reason).toBe(`pb.run.stop.${reason}`);
    }
  });
});
