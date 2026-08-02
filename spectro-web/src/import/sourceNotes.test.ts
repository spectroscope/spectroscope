// What a transcript line says beyond the frames the importer builds from it.
// Every one of these fields is real, is currently invisible, and is a thing a
// person goes looking for. The rule for all of them: a field the file does not
// carry renders NOTHING. An empty chip on every session that predates the field
// would be worse than not having it, and this repo has refused one such column
// before, for that reason.
import { describe, expect, it } from "vitest";
import { readSourceNotes, sourceNoteIndex } from "./sourceNotes";

describe("the effort a turn was told to spend", () => {
  // Measured over 4496 real transcripts: 1396 carry effort, 3100 carry none at
  // all. Absent is the MAJORITY case, so it is the one pinned first.
  it("says nothing about a line that never recorded an effort", () => {
    expect(readSourceNotes('{"type":"assistant","message":{"role":"assistant"}}')).toEqual([]);
  });

  it("reads the effort off an assistant line that carries one", () => {
    expect(readSourceNotes('{"type":"assistant","effort":"xhigh","message":{}}')).toEqual([
      { kind: "effort", value: "xhigh" },
    ]);
  });

  // Five levels are in the corpus (xhigh 81008, max 12829, high 7133, medium
  // 275, low 124) and the next one is not ours to predict, so the word travels
  // verbatim instead of through a table that would drop an unknown level.
  it("takes the level verbatim, whatever the file names", () => {
    for (const level of ["max", "high", "medium", "low", "something-new"]) {
      expect(readSourceNotes(`{"effort":"${level}"}`)).toEqual([{ kind: "effort", value: level }]);
    }
  });

  it("refuses an effort that is not a word", () => {
    expect(readSourceNotes('{"effort":3}')).toEqual([]);
    expect(readSourceNotes('{"effort":""}')).toEqual([]);
    expect(readSourceNotes('{"effort":{"level":"high"}}')).toEqual([]);
  });

  // A line that does not parse is a line we know nothing about. The source pane
  // still shows it verbatim; a note would be a claim.
  it("says nothing about a line that is not JSON", () => {
    expect(readSourceNotes("not json at all")).toEqual([]);
    expect(readSourceNotes("")).toEqual([]);
  });
});

describe("the index over a whole file", () => {
  it("holds only the lines that carry something", () => {
    const index = sourceNoteIndex(['{"effort":"max"}', '{"type":"user"}', '{"effort":"low"}']);
    expect([...index.keys()]).toEqual([0, 2]);
    expect(index.get(0)).toEqual([{ kind: "effort", value: "max" }]);
  });

  it("has nothing to index for a session that was produced here", () => {
    expect(sourceNoteIndex(null).size).toBe(0);
    expect(sourceNoteIndex(undefined).size).toBe(0);
  });

  // The index is built once per import and read per row, so it must hand back
  // the SAME array every time: a fresh one would re-render every memoized row.
  it("hands back the same array on every read", () => {
    const index = sourceNoteIndex(['{"effort":"max"}']);
    expect(index.get(0)).toBe(index.get(0));
  });
});

// Roughly one in four "user" turns that carry the field was not written by the
// user (of 1342 in the corpus: human 914, task-notification 385, coordinator
// 43). Labelling a machine injection as a person is a factual error, which is
// this card's whole subject.
describe("who wrote a user turn", () => {
  it("says nothing about a transcript that predates the field", () => {
    expect(readSourceNotes('{"type":"user","message":{"role":"user","content":"hi"}}')).toEqual([]);
  });

  // The absent case and the human case must look the SAME on screen. Half the
  // corpus records no origin at all, so a "human" chip would claim, on every
  // older file, something the file never said.
  it("says nothing when the file says a person wrote it", () => {
    expect(readSourceNotes('{"type":"user","origin":{"kind":"human"}}')).toEqual([]);
  });

  it("names the machine when the file names one", () => {
    expect(readSourceNotes('{"type":"user","origin":{"kind":"task-notification"}}')).toEqual([
      { kind: "origin", value: "task-notification" },
    ]);
    expect(readSourceNotes('{"type":"user","origin":{"kind":"coordinator"}}')).toEqual([
      { kind: "origin", value: "coordinator" },
    ]);
  });

  // Same reason as the effort level: the next writer is not ours to predict,
  // and a table would silently drop it.
  it("carries a kind it has never seen verbatim", () => {
    expect(readSourceNotes('{"origin":{"kind":"scheduler"}}')).toEqual([
      { kind: "origin", value: "scheduler" },
    ]);
  });

  it("refuses an origin that is not the shape the file uses", () => {
    expect(readSourceNotes('{"origin":"task-notification"}')).toEqual([]);
    expect(readSourceNotes('{"origin":{}}')).toEqual([]);
    expect(readSourceNotes('{"origin":{"kind":7}}')).toEqual([]);
    expect(readSourceNotes('{"origin":null}')).toEqual([]);
  });
});
