// Card 326: the RULE behind the four face lists, walked over the whole
// vocabulary instead of typed out a second time.
//
// The file next to this one bites each of the four origins on its own line,
// which is what stops four cases falling with one message. This one exists for
// the opposite failure: a hand-written list of four origins guarded by a test
// that types the same four is two copies of one lie, and the day a fifth
// import format lands the list is silently one short. So everything here walks
// TRACE_ORIGINS and derives from the predicate.
//
// The predicate is deliberately in the form import/contextRecording.ts already
// uses for exactly this shape of question (`recordsSystemPrompt(kind)`): one
// named sentence about a format, answered per kind, so the compiler can be
// asked whether every kind has an answer.
//
// THE BUILDER'S OWN BITE, which this file cannot perform for them: add a
// FOURTH ImportKind to import/detect.ts, run `npx tsc -b`, and demand red from
// the predicate's exhaustiveness AND red from the walk below. If either stays
// green the rule is a hand list with a loop drawn around it.

import { describe, expect, it } from "vitest";
import { TRACE_FACES, TRACE_ORIGINS, facesFor, facesOf, readsForeignRecord } from "./traceFace";

describe("the origin vocabulary", () => {
  // Four cases, and the fourth is the one the owner's two sentences skip: a
  // session with no file at all. A vocabulary that only knew the three import
  // kinds would have no answer for a live socket, which is most of the app.
  it("has an entry for a session with no imported file", () => {
    expect(TRACE_ORIGINS).toContain("native");
  });

  it("has an entry for every format the importer reads", () => {
    for (const kind of ["spectroscope", "claude-code", "vscode-agent"]) {
      expect(TRACE_ORIGINS, kind).toContain(kind);
    }
  });

  it("names each origin once", () => {
    expect(new Set(TRACE_ORIGINS).size).toBe(TRACE_ORIGINS.length);
  });
});

describe("which origins read a foreign record", () => {
  // The one sentence the whole card turns on: is the file behind these frames
  // somebody ELSE'S record, so that our RunEvent is a reconstruction of it?
  it("says no for a session this app produced", () => {
    expect(readsForeignRecord("native")).toBe(false);
  });

  it("says no for an imported file our own writer wrote", () => {
    expect(readsForeignRecord("spectroscope")).toBe(false);
  });

  it("says yes for a Claude Code transcript", () => {
    expect(readsForeignRecord("claude-code")).toBe(true);
  });

  it("says yes for a VS Code agent export", () => {
    expect(readsForeignRecord("vscode-agent")).toBe(true);
  });
});

describe("the face list every origin gets", () => {
  // Derived from the predicate, per origin, so the lists cannot drift from the
  // sentence that produced them.
  it("offers source exactly where the record is foreign", () => {
    for (const origin of TRACE_ORIGINS) {
      expect(facesOf(origin).includes("source"), origin).toBe(readsForeignRecord(origin));
    }
  });

  it("offers our own two readings exactly where the record is ours", () => {
    for (const origin of TRACE_ORIGINS) {
      const ours = !readsForeignRecord(origin);
      expect(facesOf(origin).includes("insight"), `insight on ${origin}`).toBe(ours);
      expect(facesOf(origin).includes("wire"), `wire on ${origin}`).toBe(ours);
    }
  });

  it("offers structured whatever the origin is", () => {
    // The one surface that survives every withdrawal, and the reason nothing
    // becomes unreachable: describeEvent returned something for all 69,002
    // frames of the 364 measured Claude Code transcripts.
    for (const origin of TRACE_ORIGINS) {
      expect(facesOf(origin), origin).toContain("structured");
    }
  });

  it("leaves no face nobody can reach any more", () => {
    // A face withdrawn from every origin is dead code wearing a button, and
    // the i18n dictionary would keep holding two words for it.
    for (const face of TRACE_FACES) {
      expect(
        TRACE_ORIGINS.some((origin) => facesOf(origin).includes(face)),
        `${face} is offered by no origin at all`,
      ).toBe(true);
    }
  });

  it("keeps the toolbar's own order", () => {
    for (const origin of TRACE_ORIGINS) {
      const offered = facesOf(origin);
      expect(offered, origin).toEqual(TRACE_FACES.filter((f) => offered.includes(f)));
    }
  });
});

describe("what a row offers against what its session can answer", () => {
  // Two withdrawals, one composition: the session's list is the ceiling and a
  // frame type can only take further faces off it. A row that offered a face
  // its session cannot answer would be a button onto an empty pane.
  it("never lets a row offer a face its session withdrew", () => {
    for (const origin of TRACE_ORIGINS) {
      const session = facesOf(origin);
      for (const type of ["text_delta", "tool_call", "llm_exchange", "llm_request", "llm_response"]) {
        for (const face of facesFor(type, origin)) {
          expect(session, `${face} on ${type} / ${origin}`).toContain(face);
        }
      }
    }
  });

  it("gives an ordinary frame everything its session can answer", () => {
    for (const origin of TRACE_ORIGINS) {
      expect(facesFor("text_delta", origin), origin).toEqual(facesOf(origin));
    }
  });
});
