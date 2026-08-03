// The door between an imported stream and a written file.
//
// An import carries frames that are NOT wire events: the socket-only UI frames
// the reducer has always known, and now the four import-only kinds card 141
// adds. Those frames are honest on screen and unreadable in a file. Measured
// against the Java reader: `RunEvent` is a sealed interface with @JsonSubTypes
// and no defaultImpl, so an unknown type raises InvalidTypeIdException, which
// SessionStore.readSessionEvents catches as a torn line and drops in silence.
// The Python edition pins the same behaviour (test_wire.py
// test_unknown_type_is_dropped). So a written line the readers cannot name is
// not an extension, it is a line that quietly disappears.
//
// The file is the reason this is one shared constant rather than a filter per
// writer: the Text tab's JSONL view already dropped them and the download did
// not, so the two disagreed about what the session was.

import { describe, expect, it } from "vitest";
import ccHeavy from "../import/fixtures/cc-heavy.jsonl?raw";
import ccNoConvo from "../import/fixtures/cc-noconvo.jsonl?raw";
import { detectAndLoad } from "../import/detect";
import { eventsToJsonl } from "../state/textFeed";
import { toJsonl } from "./jsonl";
import { toClaudeCodeJsonl } from "./claudeCode";
import { toVscodeAgentJsonl } from "./vscodeAgent";
import { NON_WIRE_TYPES } from "../wire/nonWire";

const imported = (text: string): ReturnType<typeof detectAndLoad>["events"] => detectAndLoad(text).events;

/** The wire type as a plain string: a stream carrying import-only frames is
 *  wider than the RunEvent union, which is the whole reason this file exists. */
const typeOf = (event: unknown): string => (event as { type: string }).type;

describe("what a written jsonl may contain", () => {
  it("names every frame that is ours rather than the wire's", () => {
    // The four socket-only frames the app has always built, plus the four
    // import-only kinds. A name added to the importer and forgotten here is a
    // line the Java reader drops without saying so.
    for (const type of [
      "provider_info",
      "workspace_info",
      "permission_mode_info",
      "session_resume",
      "task_reminder",
      "queue_operation",
      "queued_command",
      "edited_text_file",
    ]) {
      expect(NON_WIRE_TYPES.has(type), type).toBe(true);
    }
  });

  it("leaves an imported provider_info out of the download", () => {
    // The importer announces the model it read off the first assistant record
    // (claudeCode.ts announce()). Before this, the very first line of an
    // exported import was that announcement.
    const events = imported(ccHeavy);
    expect(events.some((e) => typeOf(e) === "provider_info")).toBe(true);
    expect(toJsonl(events)).not.toContain("provider_info");
  });

  it("writes the same lines the text tab calls the file", () => {
    const events = imported(ccHeavy);
    expect(toJsonl(events).trimEnd().split("\n")).toEqual(eventsToJsonl(events));
  });

  it("keeps the four import-only kinds out of the download", () => {
    const events = imported(ccNoConvo);
    // They are really in the stream: this is a filter, not an absence.
    for (const type of ["task_reminder", "queue_operation", "queued_command", "edited_text_file"]) {
      expect(
        events.some((e) => typeOf(e) === type),
        type,
      ).toBe(true);
    }
    const written = toJsonl(events);
    for (const type of ["task_reminder", "queue_operation", "queued_command", "edited_text_file"]) {
      expect(written, type).not.toContain(`"type":"${type}"`);
    }
  });

  it("still writes every wire frame it was handed", () => {
    // The filter must remove exactly the named types and nothing else, or an
    // export silently shortens a real session.
    const events = imported(ccNoConvo);
    const kept = toJsonl(events).trimEnd().split("\n");
    const expected = events.filter((e) => !NON_WIRE_TYPES.has(typeOf(e)));
    expect(kept.length).toBe(expected.length);
    expect(kept[0]).toBe(JSON.stringify(expected[0]));
  });

  it("derives no foreign record from a frame that is not a wire event", () => {
    // A REGRESSION PIN, not a red test: both foreign writers switch on a closed
    // list of wire types and fall through everything else, so they are clean
    // today. They are pinned because the next kind added to the importer is one
    // `default:` away from arriving in somebody else's format.
    const events = imported(ccNoConvo);
    for (const written of [toClaudeCodeJsonl(events), toVscodeAgentJsonl(events)]) {
      for (const type of NON_WIRE_TYPES) {
        expect(written, type).not.toContain(type);
      }
    }
  });
});
