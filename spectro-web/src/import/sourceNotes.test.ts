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
