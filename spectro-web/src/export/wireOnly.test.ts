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
import ccFollowup from "../import/fixtures/cc-followup.jsonl?raw";
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
    // The ones the app builds for its own screen, plus the ones an import
    // reads. Written out by hand on purpose, so removing one goes red here;
    // ADDING one is what wireOnly.drift.test.ts catches, by reading
    // SessionConnection and the RunEvent union off disk. This list alone missed
    // otlp_export and the two fleet frames for exactly as long as it was the
    // only check.
    for (const type of [
      "provider_info",
      "workspace_info",
      "permission_mode_info",
      "session_resume",
      "otlp_export",
      "fleet_roster",
      "fleet_event",
      // `llm_exchange` is deliberately NOT in this list any more. Card 184 leg 3
      // gave the sealed union a type for it, so a session file can hold it and a
      // reopened session can say that a model was called — which is the whole
      // point of the leg. Removing a name here is meant to be a decision, and
      // this is the decision.
      //
      // Leg 2 (card 184): the call leaving, and the moment it closed. Both stay
      // socket-only announcements like provider_info, and llm_response is not
      // even that — it is built in this browser out of the closing frame, so no
      // session file has ever held either of them.
      "llm_request",
      "llm_response",
      "user_message",
      "task_reminder",
      "queue_operation",
      "queued_command",
      "edited_text_file",
      "tool_result_detail",
      "agent_detail",
      "ground_info",
      "attachment_image",
      // Card 212's two socket-only frames: the live set, and the refusal that
      // says a session id belongs to another socket. Both describe the server
      // now, not this session's history.
      "live_sessions",
      "session_busy",
      // Card 261's heartbeat answer. The transport swallows it at the socket
      // boundary, so no writer will ever see one — it is named here because
      // this list is where "may a file hold this" is answered, and for a
      // heartbeat the answer is no.
      "pong",
      // Card 267's goal frame: what this session is FOR, and the command that
      // decides it. A property of the session right now, not a line of its
      // history — the VERDICT is history and rides the union as `goal_check`,
      // so exactly one of the pair belongs here.
      "goal_info",
    ]) {
      expect(NON_WIRE_TYPES.has(type), type).toBe(true);
    }
    // Twenty-two: eighteen, plus card 212's two, plus card 261's `pong` and
    // card 267's `goal_info`. The number is asserted so the set cannot grow or
    // shrink by accident — only on purpose, with the reason written above.
    //
    // This literal is what caught the merge of the two waves. 261 and 267 were
    // built on separate branches and each raised the count from 20 to 21 for
    // its own frame, so the merge produced a set of 22 asserted to be 21 — with
    // no conflict marker anywhere, because the two edits were textually
    // identical. The compiler had nothing to say either. This guard was the
    // only thing that noticed, which is the whole argument for keeping a bare
    // number in a test.
    expect(NON_WIRE_TYPES.size).toBe(22);
  });

  it("keeps a user turn read out of a transcript out of the download", () => {
    // user_message is a ClientMessage, never a RunEvent — the browser's own
    // outbound frame. The importer emits it inbound for every prompt of a
    // transcript after the first, because run_start has room for exactly one.
    //
    // It is honest on screen and unwritable in a file, exactly like the four
    // card-141 kinds: the Java reader would raise InvalidTypeIdException on the
    // line and SessionStore would drop it as torn, without a word. The wire
    // contract has no slot for user text mid-run — run_start.prompt is the only
    // place a prompt lives — and events.ts is shared with the Java core and the
    // Python edition, so inventing one here is not ours to do.
    const events = imported(ccFollowup);
    expect(events.some((e) => typeOf(e) === "user_message")).toBe(true);
    expect(toJsonl(events)).not.toContain("user_message");
    expect(NON_WIRE_TYPES.has("user_message")).toBe(true);
  });

  it("leaves the three frames a live socket adds out of the download", () => {
    // The gate was written for an IMPORT and missed the live case entirely.
    // With an OTLP endpoint configured (card 137) the server mirrors every
    // export back to the UI, and with a hub attached it mirrors the roster and
    // every fleet frame; ws.ts buffers whatever parses and App appends the
    // whole batch, so all three sit in the array the export menu is handed.
    // Written out, each is a line the Java reader takes for torn and discards.
    // wireOnly.drift.test.ts holds the list against SessionConnection itself.
    const live = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
      {
        type: "otlp_export",
        sessionId: "s",
        endpoint: "http://localhost:3000/api/public/otel",
        spans: 4,
        ok: true,
        ts: 2,
      },
      { type: "fleet_roster", nodes: [{ id: "a", topic: "t", alive: true }], ts: 3 },
      { type: "fleet_event", frame: { seq: 1, topic: "t" }, ts: 4 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 5 },
    ] as unknown as Parameters<typeof toJsonl>[0];
    const written = toJsonl(live);
    for (const type of ["otlp_export", "fleet_roster", "fleet_event"]) {
      expect(written, type).not.toContain(`"type":"${type}"`);
    }
    expect(written.trimEnd().split("\n")).toHaveLength(2);
    // The text tab has to call the same file the same thing.
    expect(eventsToJsonl(live)).toHaveLength(2);
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

// Card 179: an imported picture must never reach a written file.
//
// It is the heaviest import-only frame by far — the median transcript that has
// pictures holds 1.17 MB of base64, and the largest single block in the store is
// 2.29 MB — so a leak here would not be a cosmetic one. It rides in the fold
// because the bytes are already resident and no endpoint could serve a file the
// picker handed over from outside the store; it stays out of every export for
// the same reason `tool_result_detail` does: it is the importer's reading, not
// the wire's record.
describe("an imported picture stays in the browser", () => {
  const withShots = [
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "text", text: "look at this" },
        ],
      },
      uuid: "u1",
      timestamp: "2026-08-05T10:00:00.000Z",
    }),
  ].join("\n");

  it("emits the frame on import", () => {
    expect(imported(withShots).map(typeOf)).toContain("attachment_image");
  });

  it("and no writer carries it, in any of the three formats", () => {
    const events = imported(withShots);
    for (const written of [toJsonl(events), toClaudeCodeJsonl(events), toVscodeAgentJsonl(events)]) {
      expect(written).not.toContain("attachment_image");
      // And not the payload either, which is the part that would actually hurt.
      expect(written).not.toContain("iVBORw0KGgo=");
    }
  });
});
