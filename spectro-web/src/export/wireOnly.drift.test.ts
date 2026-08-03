// The wire gate, held against the two files that decide what a wire event is.
//
// nonWire.ts says of itself "Every frame type that must never reach a written
// session file", and it was written by hand from memory. It listed eight names
// and missed three, so a live export with an OTLP endpoint configured wrote an
// `otlp_export` line that the Java reader takes for a torn line and discards
// without a word. A hand-kept list beside another hand-kept list is not a gate;
// it is two copies waiting to disagree, and they did: traceDetail.ts's
// UNSTORED_TYPES named all three while this one named none of them.
//
// So both halves are read off disk here, the way toolBody.drift.test.ts reads
// the ToolView union:
//   - what the SERVER pushes over the socket and never appends to a session
//     file. Every one of those frames must be in the gate.
//   - what the JAVA UNION names. None of those may be in the gate, or the app
//     would be refusing to write a frame the file format holds.
//
// It cannot catch a browser-built frame (system_context is neither in Java nor
// on the socket), which is why traceDetail.ts adds that one name by hand and
// takes the rest from here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NON_WIRE_TYPES } from "../wire/nonWire";

const java = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), "utf8");

const CONNECTION = "spectro-server/src/main/java/dev/spectroscope/server/SessionConnection.java";
const UNION = "spectro-core/src/main/java/dev/spectroscope/core/events/RunEvent.java";

/**
 * Every frame the socket handler builds by hand.
 *
 * A RunEvent is serialized by Jackson off a record, so the only place a type
 * name is WRITTEN as a string in this file is a frame the server invents for
 * the UI. Both spellings the file uses are read: the `Map.of("type", "x")`
 * form and the `payload.put("type", "x")` one.
 */
function socketFrames(): string[] {
  const src = java(CONNECTION);
  const found = [...src.matchAll(/"type",\s*"([a-z_]+)"/g)].map((m) => m[1]);
  if (found.length === 0) throw new Error(`${CONNECTION} no longer builds any frame by name`);
  return [...new Set(found)];
}

/** Every type name the sealed union declares, which is exactly what a session
 *  file may hold: no defaultImpl, so anything else raises InvalidTypeIdException
 *  and SessionStore drops the line as torn. */
function unionTypes(): string[] {
  const src = java(UNION);
  const found = [...src.matchAll(/@JsonSubTypes\.Type\([^)]*name\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]);
  if (found.length === 0) throw new Error(`${UNION} no longer declares @JsonSubTypes`);
  return found;
}

describe("the wire gate against the Java seam", () => {
  it("holds every frame the server invents for the socket", () => {
    // Six of them, each saying so in its own javadoc: workspace_info,
    // provider_info, permission_mode_info, fleet_roster, fleet_event and
    // otlp_export. Three were in the gate and three were not.
    const frames = socketFrames();
    expect(frames).toContain("otlp_export");
    for (const type of frames) {
      expect(NON_WIRE_TYPES.has(type), `${type} rides the socket and is not in the gate`).toBe(true);
    }
  });

  it("refuses to write nothing the file format can hold", () => {
    // The other direction, and the one that would turn this gate into a
    // shredder: a name in both lists means the app drops a frame every reader
    // could have read.
    for (const type of unionTypes()) {
      expect(NON_WIRE_TYPES.has(type), `${type} is a wire event and must be written`).toBe(false);
    }
  });
});
