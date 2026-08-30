// Card 326: which faces a frame offers is a function of WHERE THE SESSION CAME
// FROM, not of the frame alone.
//
// The owner's words: "Source muss NUR da sein wenn wir was importieren. das
// kann weg wenn wir einen spectro jsonl anschauen. und insight und wire kann
// weg wenn wir ein import von claude anschauen oder ?"
//
// There are two objects behind the confusion and they share names. THE FILE
// LINE is what the recorder wrote, and it only exists when a file was
// imported. OUR RunEvent is what the importer made of that line; Insight is
// its tree and Wire is its text. That gives FOUR origins, not two:
//
//   native            no file at all — a live socket, a stored session
//                     re-opened, a scenario, an entered fleet. Source can
//                     answer nothing.
//   spectroscope      an imported file our own writer produced. Measured over
//                     727 files and 73,331 frames: the file line and the wire
//                     line are byte-identical every single time, so Source is
//                     a second copy of Wire.
//   claude-code       a foreign record, with our reconstruction beside it.
//   vscode-agent      the same, measured: on a real 893-line export all
//                     849 frames differ between the file line and the wire
//                     line, so it is the foreign case exactly and follows
//                     claude-code rather than being left out because the
//                     owner happened to name Claude.
//
// Each origin is bitten on its own line below. Four expectations in one `it`
// would fall with one message and hide three of the four.
//
// WHAT THIS FILE DOES NOT PIN: where the origin comes from. `Replay` carries
// no `kind` today (App.tsx:168) and the import writes it into a display id
// (`import:<kind>:<label>`); threading a real field down to the detail panel
// is the card's plumbing, and deriving a behavioural switch from a formatted
// string is the class of defect state/traceFace.ts already argues against.

import { beforeEach, describe, expect, it } from "vitest";
import {
  TRACE_FACES,
  availableFace,
  currentTraceFace,
  facesFor,
  rowFace,
  setTraceFace,
  type TraceFace,
  type TraceOrigin,
} from "./traceFace";

/** An ordinary inbound frame, the shape most rows are. */
const ORDINARY = "text_delta";

/** The one frame type that already withdrew a face of its own (card 184): a
 *  recorded LLM exchange keeps its bytes in a sidecar, so no file line stands
 *  behind it and Source was never on offer for it. */
const EXCHANGE = "llm_exchange";

describe("the faces a native session offers", () => {
  // No file was imported. There is nothing for Source to be the source OF, and
  // the pane says exactly that today ("This session was produced here, so there
  // is no separate source"). A correct sentence is still a face the reader has
  // to click to learn nothing from.
  it("offers structured, insight and wire, and never source", () => {
    expect(facesFor(ORDINARY, "native" satisfies TraceOrigin)).toEqual(["structured", "insight", "wire"]);
  });
});

describe("the faces an imported spectroscope file offers", () => {
  // The file line IS the wire line, byte for byte — JSON.stringify(JSON.parse(
  // line)) === line for all 71,294 frames of ~/.spectro/sessions and all 2,031
  // of the archive. So Source is a duplicate of Wire, and a face nobody can
  // tell from its neighbour costs a reader a decision and returns nothing.
  it("offers structured, insight and wire, and drops the duplicate source", () => {
    expect(facesFor(ORDINARY, "spectroscope" satisfies TraceOrigin)).toEqual([
      "structured",
      "insight",
      "wire",
    ]);
  });
});

describe("the faces a Claude Code import offers", () => {
  // Here Source is the only face that shows what the RECORDER wrote; Insight
  // and Wire show our reconstruction of it. Source becomes the import's
  // version of them (owner) and the two go.
  it("offers structured and source, and drops insight and wire", () => {
    expect(facesFor(ORDINARY, "claude-code" satisfies TraceOrigin)).toEqual(["structured", "source"]);
  });
});

describe("the faces a VS Code agent import offers", () => {
  // Measured, not generalised: on the one real export on this machine
  // (893 lines, 850 frames) every one of the 849 frames that names a line has
  // a file line DIFFERENT from its wire line. Same case as claude-code.
  it("offers structured and source, and drops insight and wire", () => {
    expect(facesFor(ORDINARY, "vscode-agent" satisfies TraceOrigin)).toEqual(["structured", "source"]);
  });
});

describe("a frame type that withdraws a face of its own", () => {
  // The two withdrawals compose rather than fighting: the session says which
  // faces it can answer, the frame says which of those it can fill. Inside a
  // Claude import a recorded exchange has neither our tree (the session
  // withdrew it) nor a file line (the frame has none), and structured is what
  // is left. A face list that came back empty would leave the pane blank.
  it("leaves a recorded exchange in a Claude import with structured alone", () => {
    expect(facesFor(EXCHANGE, "claude-code" satisfies TraceOrigin)).toEqual(["structured"]);
  });

  it("still gives a recorded exchange in a native session its three", () => {
    expect(facesFor(EXCHANGE, "native" satisfies TraceOrigin)).toEqual(["structured", "insight", "wire"]);
  });
});

describe("the order the buttons stand in", () => {
  // A row's list is TRACE_FACES filtered, never re-ordered, so the toolbar
  // never reshuffles between two rows of the same session.
  it("keeps every offered list in the toolbar's own order", () => {
    for (const origin of ["native", "spectroscope", "claude-code", "vscode-agent"] as const) {
      for (const type of [ORDINARY, EXCHANGE]) {
        const offered = facesFor(type, origin);
        expect(offered, `${origin} / ${type}`).toEqual(TRACE_FACES.filter((f) => offered.includes(f)));
      }
    }
  });
});

// A face that disappears must not strand a reader who had it selected and
// saved. availableFace already answers this for card 184's withdrawal, and the
// three landings below are the ones this card's withdrawals produce. Nothing
// new is needed — which is a claim worth pinning rather than assuming, because
// "nearest neighbour to the left" was written when only `source` could go
// missing and `insight` had nothing to its left but `structured`.
describe("a reader whose saved face this session cannot answer", () => {
  beforeEach(() => {
    setTraceFace("structured");
  });

  it("lands on structured when wire is withdrawn by a Claude import", () => {
    expect(availableFace("wire", facesFor(ORDINARY, "claude-code"))).toBe("structured");
  });

  it("lands on structured when insight is withdrawn by a Claude import", () => {
    expect(availableFace("insight", facesFor(ORDINARY, "claude-code"))).toBe("structured");
  });

  it("lands on wire when source is withdrawn by a native session", () => {
    expect(availableFace("source", facesFor(ORDINARY, "native"))).toBe("wire");
  });

  it("lands somewhere real for EVERY saved face on EVERY origin", () => {
    // Walked over both vocabularies rather than over the four landings above:
    // a fifth face, or a fourth import kind, gets checked the day it arrives
    // instead of the day somebody remembers this file.
    for (const origin of ["native", "spectroscope", "claude-code", "vscode-agent"] as const) {
      const offered = facesFor(ORDINARY, origin);
      expect(offered.length, `${origin} offers nothing`).toBeGreaterThan(0);
      for (const saved of TRACE_FACES) {
        expect(offered, `${saved} on ${origin}`).toContain(availableFace(saved, offered));
      }
    }
  });

  // The stored master is a statement about what the READER wants, not about
  // what this file can show. Rewriting it on the way past would silently throw
  // their choice away the first time they open a foreign transcript.
  it("does not rewrite the saved master on the way past", () => {
    setTraceFace("wire");
    availableFace(rowFace(currentTraceFace(), null), facesFor(ORDINARY, "claude-code"));
    expect(currentTraceFace().face).toBe("wire");
  });

  it("puts the reader back on their own face in the next native session", () => {
    setTraceFace("wire");
    const inTheImport = availableFace(rowFace(currentTraceFace(), null), facesFor(ORDINARY, "claude-code"));
    expect(inTheImport).toBe("structured");
    const backHome: TraceFace = availableFace(
      rowFace(currentTraceFace(), null),
      facesFor(ORDINARY, "native"),
    );
    expect(backHome).toBe("wire");
  });
});
