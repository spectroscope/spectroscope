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

// run_end now reports the file's own stop reason, but that is one frame at the
// very end of a session. A reader looking at turn 214 still cannot see that
// THIS answer was cut off mid-sentence, and there is no other sign of it: the
// text simply stops.
describe("a turn the model did not finish", () => {
  it("says nothing about a turn that ended on its own terms", () => {
    for (const stop of ['"end_turn"', '"tool_use"', "null"]) {
      expect(readSourceNotes(`{"type":"assistant","message":{"stop_reason":${stop}}}`)).toEqual([]);
    }
  });

  it("says nothing about a transcript that records no stop reason at all", () => {
    expect(readSourceNotes('{"type":"assistant","message":{"role":"assistant"}}')).toEqual([]);
  });

  // 13 messages in the corpus end on max_tokens and 322 on stop_sequence. Both
  // mean the answer stopped for a reason outside the model's own ending.
  it("marks the turn when the answer ran into a limit", () => {
    expect(readSourceNotes('{"type":"assistant","message":{"stop_reason":"max_tokens"}}')).toEqual([
      { kind: "truncated", value: "max_tokens" },
    ]);
    expect(readSourceNotes('{"type":"assistant","message":{"stop_reason":"stop_sequence"}}')).toEqual([
      { kind: "truncated", value: "stop_sequence" },
    ]);
  });

  // A tool result quoting the words is not a stop reason.
  it("reads the message's own field, not the words wherever they appear", () => {
    expect(
      readSourceNotes(
        '{"type":"user","message":{"content":[{"type":"tool_result","content":"max_tokens"}]}}',
      ),
    ).toEqual([]);
  });
});

// 18 records in the corpus swap the model mid-message. The importer announces
// the NEW model (the record's own message.model already names it), so the
// change shows; what is lost is that it was a fallback and which model it left.
// The record's only content block is the fallback itself, so the turn otherwise
// renders empty.
describe("a model swapped under the run", () => {
  it("says nothing about an ordinary assistant line", () => {
    expect(
      readSourceNotes('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'),
    ).toEqual([]);
  });

  it("names the model it left and the model it landed on", () => {
    expect(
      readSourceNotes(
        '{"type":"assistant","message":{"content":[{"type":"fallback","from":{"model":"claude-fable-5"},"to":{"model":"claude-opus-5"}}]}}',
      ),
    ).toEqual([{ kind: "fallback", value: "claude-fable-5 → claude-opus-5" }]);
  });

  it("stays quiet on a fallback block that does not name both models", () => {
    expect(
      readSourceNotes('{"type":"assistant","message":{"content":[{"type":"fallback","to":{"model":"x"}}]}}'),
    ).toEqual([]);
    expect(
      readSourceNotes('{"type":"assistant","message":{"content":[{"type":"fallback","from":"a","to":"b"}]}}'),
    ).toEqual([]);
  });
});

// WHY IS IT SUDDENLY WRITING TESTS? (card 167, finding 7.) A reader of somebody
// else's session sees a long stretch of turns with no explanation, and the file
// says on every one of them that a skill was in charge, or that an MCP tool
// handed the instruction back three turns ago. Measured 2026-08-04 over the 167
// session transcripts in ~/.claude/projects: 19,595 records in 106 files carry
// attributionSkill, 28,952 in 113 carry attributionMcpServer, and the app drew
// none of it — the prefilter did not even name the fields, so the line was
// never parsed for them.
describe("what was driving the turn", () => {
  // The absent case first, as everywhere in this module: 61 of 167 session
  // files carry no attributionSkill at all.
  it("says nothing about a turn no skill was driving", () => {
    expect(readSourceNotes('{"type":"assistant","message":{"role":"assistant"}}')).toEqual([]);
  });

  it("names the skill verbatim, plugin prefix and all", () => {
    expect(readSourceNotes('{"type":"assistant","attributionSkill":"humanizer"}')).toEqual([
      { kind: "skill", value: "humanizer" },
    ]);
    expect(
      readSourceNotes('{"type":"assistant","attributionSkill":"superpowers:test-driven-development"}'),
    ).toEqual([{ kind: "skill", value: "superpowers:test-driven-development" }]);
  });

  // attributionPlugin is a substring of attributionSkill on all 13,069 session
  // records that carry it, and appears on none that lack a skill. A chip of its
  // own would put two chips on a turn that has one fact.
  it("stays quiet about the plugin, which the skill already spells out", () => {
    expect(readSourceNotes('{"type":"assistant","attributionPlugin":"superpowers"}')).toEqual([]);
    expect(
      readSourceNotes(
        '{"type":"assistant","attributionPlugin":"superpowers","attributionSkill":"superpowers:brainstorming"}',
      ),
    ).toEqual([{ kind: "skill", value: "superpowers:brainstorming" }]);
  });

  it("ignores a skill that is not a non-empty string", () => {
    expect(readSourceNotes('{"attributionSkill":""}')).toEqual([]);
    expect(readSourceNotes('{"attributionSkill":7}')).toEqual([]);
    expect(readSourceNotes('{"attributionSkill":{"name":"humanizer"}}')).toEqual([]);
  });

  // The pair is one fact: "computer" on its own says nothing, and the server
  // without the tool is half a sentence. Measured: the two appear together on
  // all 28,952 session records, and neither ever appears alone.
  it("joins the mcp server and its tool into one chip", () => {
    expect(
      readSourceNotes(
        '{"type":"assistant","attributionMcpServer":"Claude Browser","attributionMcpTool":"javascript_tool"}',
      ),
    ).toEqual([{ kind: "mcp", value: "Claude Browser:javascript_tool" }]);
  });

  it("names the server alone when that is all the line says", () => {
    expect(readSourceNotes('{"attributionMcpServer":"visualize"}')).toEqual([
      { kind: "mcp", value: "visualize" },
    ]);
  });

  // A tool with no server to belong to is not a chip: mcp__?__computer is not
  // a thing a reader can look up.
  it("says nothing about a tool with no server beside it", () => {
    expect(readSourceNotes('{"attributionMcpTool":"computer"}')).toEqual([]);
  });

  // attributionAgent is deliberately not read. Measured: 0 of 306,425 records
  // carrying it sit in a session transcript — it lives only in the sibling
  // agent-*.jsonl, and an agent-file import produces a single provider_info
  // frame with no row to hang a chip on.
  it("says nothing about attributionAgent, which no session transcript carries", () => {
    expect(readSourceNotes('{"type":"assistant","attributionAgent":"general-purpose"}')).toEqual([]);
  });

  it("wears both chips when the line carries both, driver before effort", () => {
    expect(
      readSourceNotes(
        '{"type":"assistant","effort":"high","attributionSkill":"loop","attributionMcpServer":"ccd_session","attributionMcpTool":"mark_chapter"}',
      ),
    ).toEqual([
      { kind: "skill", value: "loop" },
      { kind: "mcp", value: "ccd_session:mark_chapter" },
      { kind: "effort", value: "high" },
    ]);
  });

  it("reaches the index like every other note", () => {
    const index = sourceNoteIndex(['{"type":"user"}', '{"attributionSkill":"kanban-ai"}']);
    expect(index.get(1)).toEqual([{ kind: "skill", value: "kanban-ai" }]);
    expect(index.has(0)).toBe(false);
  });
});
