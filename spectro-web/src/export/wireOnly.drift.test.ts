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

const CONNECTION = "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java";
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

const BROWSER_TOOLS = "spectro-core/src/main/java/dev/spectroscope/core/browser/BrowserTools.java";
const BROWSER_SOCKET =
  "spectro-server/src/main/java/dev/spectroscope/server/browser/BrowserControlSocket.java";

/**
 * Every verb the browser control channel carries — the LIVE half of card 201.
 *
 * These ride /ws/browser between the server and the desktop shell, and they are
 * a different protocol from the session socket entirely: their replies carry an
 * accessibility tree, a console dump and, for `screenshot`, the picture itself
 * as base64. None of that is a RunEvent and none of it may become one.
 *
 * Read off the two files that actually send them rather than listed by hand, for
 * the reason this whole file exists: the first version of NON_WIRE_TYPES was
 * written from memory and named three of six.
 */
function browserVerbs(): string[] {
  const tools = java(BROWSER_TOOLS);
  const found = [...tools.matchAll(/browser\.send\("([a-z_]+)"/g)].map((m) => m[1]);
  if (found.length === 0) throw new Error(`${BROWSER_TOOLS} no longer sends any verb by name`);
  const socket = java(BROWSER_SOCKET);
  found.push(...[...socket.matchAll(/"verb",\s*"([a-z_]+)"/g)].map((m) => m[1]));
  found.push(...[...socket.matchAll(/send\(sessionId,\s*"([a-z_]+)"/g)].map((m) => m[1]));
  return [...new Set(found)];
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

  it("keeps the browser's LIVE control frames out of the file format entirely", () => {
    // Card 204, criterion 5. What the operator watches live is a native
    // WebContentsView driven over its own socket; the screenshot verb's reply
    // carries the PNG as base64. A verb name that had also become a RunEvent
    // type would be a reader's invitation to append one of those replies to a
    // session file, which is how a text-sized trace turns into tens of megabytes
    // of pictures — the exact cost the stress test named.
    const verbs = browserVerbs();
    expect(verbs).toContain("screenshot");
    expect(verbs).toContain("eval");
    expect(verbs).toContain("navigate");
    const union = unionTypes();
    for (const verb of verbs) {
      expect(union, `${verb} is a live control verb and must never be a wire event`).not.toContain(verb);
    }
    // And the one browser thing that IS a session event goes the other way: it
    // is in the union, so it must NOT be in the gate, or every browser run would
    // be dropped on the way to the file it belongs in.
    expect(union).toContain("browser_action");
    expect(NON_WIRE_TYPES.has("browser_action")).toBe(false);
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
