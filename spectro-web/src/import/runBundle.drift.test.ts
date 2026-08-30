// The run bundle's field names, held against the Java that writes them.
//
// Card 318 put a new wire between `RunBundle.java` and `runBundle.ts`, and its
// own comments call the field names "the contract": the server writes the
// importer's own shapes so a store load reaches the merge with no mapping layer
// in between. Both sides were then asserted — in Java by
// ClaudeTranscriptsRunBundleTest, in TypeScript by runBundle.test.ts — and
// nothing joined the two. Rename a field and update the Java test, which is the
// natural motion, and `runBundleInput` quietly returns empty arrays: the store
// row asks for the whole run, throws every agent away, and every gate stays
// green. That is this card's own defect, restored.
//
// So both halves are read off disk, the wireOnly.drift.test.ts idiom. The Java
// is the authority — it is the thing on the wire — and the reader must consume
// exactly what it writes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

const JAVA = "spectro-server/src/main/java/dev/spectroscope/server/transcripts/RunBundle.java";
const TS = "spectro-web/src/import/runBundle.ts";

/**
 * Every field name {@code RunBundle} writes, in the bundle and in the refusal.
 *
 * Read off the generator calls and the refusal's own literals rather than typed
 * here, so a rename in Java is the thing that moves this set.
 *
 * @param which the bundle's writer, the refusal's, or both
 * @returns the names, deduplicated
 */
function javaFields(which: "json" | "refusal" | "both" = "both"): string[] {
  const src = read(JAVA);
  const from = src.indexOf("byte[] json(");
  const at = src.indexOf("byte[] refusal(");
  if (from < 0 || at < from) throw new Error(`${JAVA} no longer has json() before refusal()`);
  const written = [
    ...(which === "refusal"
      ? []
      : [...src.slice(from, at).matchAll(/write(?:String|Number|Array)Field(?:Start)?\("([A-Za-z]+)"/g)].map(
          (m) => m[1],
        )),
    // The refusal is a hand-built body, so its names are string literals with
    // escaped quotes rather than generator calls.
    ...(which === "json" ? [] : [...src.slice(at).matchAll(/\\"([A-Za-z]+)\\":/g)].map((m) => m[1])),
  ];
  if (written.length === 0) throw new Error(`${JAVA} no longer writes any field by name`);
  return [...new Set(written)];
}

/**
 * Every field name the browser's reader asks for.
 *
 * `str(x, "name")` and `num(x, "name")` are the only two ways this module
 * reaches into the untrusted body, plus the two arrays it walks by name.
 *
 * @returns the names, deduplicated
 */
function tsFields(): string[] {
  const src = read(TS);
  const found = [
    ...[...src.matchAll(/\b(?:str|num)\([^,]+,\s*"([A-Za-z]+)"\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/raw\?\.([A-Za-z]+)\b/g)].map((m) => m[1]),
  ];
  if (found.length === 0) throw new Error(`${TS} no longer reads any field by name`);
  return [...new Set(found)];
}

describe("the run bundle's field names are one contract, not two", () => {
  it("everything the reader asks for is something the server writes", () => {
    // The direction that matters: a name the browser reads and Java never
    // writes is a field that silently arrives as undefined, and for `sidecars`
    // and `runStates` that means the agents are dropped without a word.
    const written = javaFields();
    for (const name of tsFields()) {
      expect(written, `runBundle.ts reads "${name}", which ${JAVA} does not write`).toContain(name);
    }
  });

  it("the five the importer needs are on both sides, named the same", () => {
    // These are not decoration: `sessionText`, `jsonlText`, `metaJson`, `runId`
    // and `json` ARE the shapes `SidecarText` and `RunStateText` take. The
    // arrays that carry them are checked in the same breath.
    const both = javaFields("json").filter((n) => tsFields().includes(n));
    for (const name of ["sessionText", "sidecars", "jsonlText", "metaJson", "runId", "runStates", "json"]) {
      expect(both, `"${name}" must be written by Java and read by the browser`).toContain(name);
    }
  });

  it("the refusal's numbers are written by the same Java the reader parses", () => {
    // A separate body and a separate reader (`runRefusal`), and the same trap:
    // half a refusal reads worse than the bare status it replaced, so the two
    // sizes and the agent count all have to survive the trip.
    const refusal = javaFields("refusal");
    for (const name of ["totalBytes", "limitBytes", "agents"]) {
      expect(refusal, `the 413 body must name ${name}`).toContain(name);
      expect(tsFields(), `runRefusal must read ${name}`).toContain(name);
    }
  });
});
