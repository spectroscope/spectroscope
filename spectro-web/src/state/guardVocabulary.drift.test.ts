// The three self-reports' vocabularies, held against the Java that emits them.
//
// Cards 281 and 282 draw a line per VALUE — one infoKey for each detector, each
// intervention, each leash decision, each goal outcome — because the values do
// not mean the same kind of thing and one shared template is wrong for at least
// one of them. That design has a cost: four small sets in reducer.ts restating
// four Java enums, in files that cannot import each other.
//
// A value the Java gains and this list does not is not a crash. It quietly takes
// the `unknown` fallback, so the transcript keeps drawing a line and nobody ever
// learns that the specific sentence went missing. That is the same shape as
// nonWire.ts listing socket frames from memory and missing three, and as bus.css
// naming 37 tokens that did not exist. So the Java is read off disk.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const java = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

const GUARD = "spectro-core/src/main/java/dev/spectroscope/core/progress/ProgressGuard.java";
const LEASH = "spectro-core/src/main/java/dev/spectroscope/core/loop/ContinuationLeash.java";
const reducer = readFileSync(fileURLToPath(new URL("./reducer.ts", import.meta.url)), "utf8");

/** The set literal named `name` in reducer.ts, as its string members. */
const setInReducer = (name: string): Set<string> => {
  const at = reducer.indexOf(`const ${name}`);
  expect(at, `${name} is gone from reducer.ts`).toBeGreaterThan(-1);
  const body = reducer.slice(at, reducer.indexOf("]);", at));
  return new Set([...body.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]));
};

describe("the guard vocabularies the transcript draws", () => {
  it("has a sentence for every detector the guard can emit", () => {
    const enumBody = java(GUARD).slice(
      java(GUARD).indexOf("enum Detector"),
      java(GUARD).indexOf("public String wireName()"),
    );
    const wireNames = new Set([...enumBody.matchAll(/\("([a-z_]+)"\)/g)].map((m) => m[1]));
    expect(wireNames.size, "no detector wire names found — the enum's shape moved").toBe(3);
    for (const name of wireNames) {
      expect(
        setInReducer("PROGRESS_DETECTORS").has(name),
        `${name} falls to the unknown fallback: the transcript draws a line with no sentence of its own`,
      ).toBe(true);
    }
  });

  it("has a sentence for every intervention the guard can report", () => {
    const enumBody = java(GUARD).slice(
      java(GUARD).indexOf("enum Intervention"),
      java(GUARD).indexOf("public record Response"),
    );
    const values = new Set([...enumBody.matchAll(/^\s{8}([A-Z_]+),?$/gm)].map((m) => m[1]));
    expect(values, "the Intervention enum's shape moved").toEqual(
      new Set(["CARRY_ON", "CHANGE_COURSE", "END"]),
    );
    for (const value of values) {
      expect(setInReducer("PROGRESS_INTERVENTIONS").has(value), `${value} has no sentence`).toBe(true);
    }
  });

  it("keeps the leash's decisions and the run-end reasons apart", () => {
    // "no_progress" names three things in this codebase: the RunEvent subtype,
    // ProgressGuard.STOP_REASON and ContinuationLeash.Decision.NO_PROGRESS. The
    // leash's exhaustion reaches run_end as unfinished_after_continuations, so
    // the two run-end reasons are safely distinct — but only as long as nobody
    // keys a label on the bare word.
    const leash = java(LEASH);
    expect(leash).toContain("unfinished_after_continuations");
    expect(
      setInReducer("CONTINUATION_DECISIONS").has("no_progress"),
      "the leash's own decision value is missing, so its line loses its sentence",
    ).toBe(true);
  });
});
