// The shape rule, and the cases it must refuse.
//
// The rule is read off the records. No test here passes a filename, because the
// reader takes none: the corpus measurement that carries this module found
// 4,687 files where the shape rule fires and 4,687 where the name rule fires,
// the same 4,687, with zero disagreements either way. The names corroborate the
// shape and never decide it, so a renamed file, a copy on a desktop or a
// transcript some other client writes is read for what it holds.
import { describe, expect, it } from "vitest";
import ccStandalone from "./fixtures/cc-standalone-subagent.jsonl?raw";
import ccSubagent from "./fixtures/cc-subagent.jsonl?raw";
import ccOrphan from "./fixtures/cc-orphan-sidechain.jsonl?raw";
import { readSubagentTranscript } from "./subagentFile";

const parse = (text: string): unknown[] =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

describe("readSubagentTranscript", () => {
  it("names the agent a wholly-sidechain file names", () => {
    const found = readSubagentTranscript(parse(ccStandalone));
    expect(found?.agentId).toBe("a0b476c3c018");
  });

  it("carries the parent session and the agent kind verbatim", () => {
    const found = readSubagentTranscript(parse(ccStandalone));
    expect(found?.sessionId).toBe("902488ae-c4cf-49ef-a57c-cd914740bee2");
    expect(found?.attributionAgent).toBe("general-purpose");
  });

  it("refuses a file that holds one record outside the sidechain", () => {
    // cc-subagent.jsonl is the joined case: a session with a Task in it. Its
    // sidechain records have an owner IN THE FILE, and reading it as a
    // standalone transcript would reparent the whole session under the child.
    expect(readSubagentTranscript(parse(ccSubagent))).toBeNull();
  });

  it("refuses a main transcript that merely carries an orphan", () => {
    expect(readSubagentTranscript(parse(ccOrphan))).toBeNull();
  });

  it("refuses a file that names two agents, rather than picking one", () => {
    const two = [
      { type: "user", isSidechain: true, agentId: "one", message: { content: "a" } },
      { type: "assistant", isSidechain: true, agentId: "two", message: { content: [] } },
    ];
    expect(readSubagentTranscript(two)).toBeNull();
  });

  it("refuses a file that names no agent at all", () => {
    const none = [
      { type: "user", isSidechain: true, message: { content: "a" } },
      { type: "assistant", isSidechain: true, message: { content: [] } },
    ];
    expect(readSubagentTranscript(none)).toBeNull();
  });

  it("refuses an empty list", () => {
    expect(readSubagentTranscript([])).toBeNull();
    expect(readSubagentTranscript([null, 7, "x"])).toBeNull();
  });

  it("omits a session the file does not agree on, rather than picking one", () => {
    // Two ids means the file cannot say which session this agent ran under, and
    // a bar that named one of them would be reading a coin toss out loud.
    const split = [
      { type: "user", isSidechain: true, agentId: "a", sessionId: "s1", message: { content: "a" } },
      { type: "assistant", isSidechain: true, agentId: "a", sessionId: "s2", message: { content: [] } },
    ];
    const found = readSubagentTranscript(split);
    expect(found?.agentId).toBe("a");
    expect(found?.sessionId).toBeUndefined();
  });

  it("omits a kind the file never wrote down", () => {
    const bare = [{ type: "user", isSidechain: true, agentId: "a", message: { content: "a" } }];
    const found = readSubagentTranscript(bare);
    expect(found?.agentId).toBe("a");
    expect(found?.attributionAgent).toBeUndefined();
    expect(found?.sessionId).toBeUndefined();
  });
});
