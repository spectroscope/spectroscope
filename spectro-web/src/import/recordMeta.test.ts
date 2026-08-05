// The imported record, opened out for the structured face. Every assertion
// here is about one of the module's three rules: absent says nothing, present
// travels verbatim, and unnamed still arrives.
import { describe, expect, it } from "vitest";
import { INLINE_CHARS, readRecordMeta, type MetaRow } from "./recordMeta";
import ccSplit from "./fixtures/cc-split-message.jsonl?raw";
import ccLinear from "./fixtures/cc-linear.jsonl?raw";

const groupsOf = (line: string): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  for (const g of readRecordMeta(line)) {
    out[g.path] = Object.fromEntries(g.rows.map((r) => [r.key, r.value]));
  }
  return out;
};

/** The content group's rows with their block marking intact, which is the half
 *  `groupsOf` throws away and the half that decides how a row is painted. */
const contentRows = (line: string): MetaRow[] =>
  readRecordMeta(line).find((g) => g.path === "message.content")?.rows ?? [];

const lines = (raw: string): string[] => raw.split(/\r?\n/).filter((l) => l.trim());

describe("readRecordMeta", () => {
  const assistant = groupsOf(lines(ccSplit)[1]);

  it("reads the request and the response ids the frames never carried", () => {
    expect(assistant[""].requestId).toBe("req_1");
    expect(assistant["message"].id).toBe("msg_1");
  });

  it("reads the attribution a turn was written under", () => {
    // The one thing nothing in the app could answer: which skill produced this.
    expect(assistant[""].attributionSkill).toBe("chris-skills:chris-criticism");
  });

  it("reads where the run stood", () => {
    expect(assistant[""].cwd).toBe("/Users/you/proj");
    expect(assistant[""].gitBranch).toBe("main");
    expect(assistant[""].version).toBe("2.1.219");
  });

  it("keeps a recorded null, because a reported nothing is an answer", () => {
    // stop_reason: null is "this message reported no ending", which is not the
    // same as a message from before the field existed.
    expect(assistant["message"].stop_reason).toBe("null");
  });

  it("says nothing at all about a field the line does not carry", () => {
    // This piece has no attributionPlugin and no cache fields. An empty row
    // would claim the file answered.
    expect(assistant[""]).not.toHaveProperty("attributionPlugin");
    expect(assistant).not.toHaveProperty("message.usage");
  });

  it("leaves the four token counts to the usage frame", () => {
    const last = groupsOf(lines(ccSplit)[3]);
    expect(last["message.usage"]).toEqual({ service_tier: "standard" });
  });

  it("never repeats the conversation the frames already show", () => {
    expect(assistant["message"]).not.toHaveProperty("content");
    expect(assistant["message"]).not.toHaveProperty("role");
    expect(assistant[""]).not.toHaveProperty("timestamp");
  });
});

// The owner's report: "beim structured view eines turn start sieht man jetzt
// alle parameter aber das wichtige … message.content[0].thinking ist nicht
// dabei". The Source face prints that field under its own label, so the two
// faces of one line disagreed about whether the thought exists.
describe("readRecordMeta over the content blocks", () => {
  const thinking = lines(ccSplit)[1];
  const answer = lines(ccSplit)[2];
  const call = lines(ccSplit)[3];

  it("prints the thinking of the block that carries it, verbatim", () => {
    expect(groupsOf(thinking)["message.content"]["[0].thinking"]).toBe(
      "I should look at git status before saying anything.",
    );
  });

  it("names every block by its type, so the shape of the response is on screen", () => {
    expect(groupsOf(thinking)["message.content"]["[0].type"]).toBe("thinking");
    expect(groupsOf(answer)["message.content"]["[0].type"]).toBe("text");
    expect(groupsOf(call)["message.content"]["[0].type"]).toBe("tool_use");
  });

  it("marks the thought as language and the signature as bytes", () => {
    // Two markings because the pane says two different sentences over them,
    // exactly as the source pane does: one is read, the other is opened.
    const rows = contentRows(thinking);
    expect(rows.find((r) => r.key === "[0].thinking")?.block).toBe("text");
    expect(rows.find((r) => r.key === "[0].signature")).toEqual({
      key: "[0].signature",
      value: "AAAAsignature",
      block: "hidden",
    });
  });

  it("names the answer and its size and does not print it a second time", () => {
    // "Let me check." is 13 characters. The text_delta frames below this panel
    // carry the words; printing them here would make the structured face a
    // second chat.
    const content = groupsOf(answer)["message.content"];
    expect(content["[0].text"]).toBe("[13 characters]");
    expect(JSON.stringify(content)).not.toContain("Let me check");
  });

  it("counts one character as one character", () => {
    const one = groupsOf(JSON.stringify({ message: { content: [{ type: "text", text: "x" }] } }));
    expect(one["message.content"]["[0].text"]).toBe("[1 character]");
  });

  it("holds a tool result's output back the same way, and by the same rule", () => {
    // A tool_result block's `content` is the tool's whole output, which is why
    // the record-level `toolUseResult` is held back too.
    const result = groupsOf(lines(ccSplit)[4])["message.content"];
    expect(result["[0].type"]).toBe("tool_result");
    expect(result["[0].content"]).toBe("[5 characters]");
    expect(result["[0].tool_use_id"]).toBe("t1");
  });

  it("names a block-list answer by its shape, never reprinting the words", () => {
    // Real tool_result blocks routinely carry `content` as a small list —
    // measured, 20,085 of 152,172 in the corpus are array-shaped, 2,123 of
    // them under the inline ceiling. Small or not, the words inside are the
    // tool card's words, so the shape is all this panel says.
    const listy = groupsOf(
      JSON.stringify({
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t9", content: [{ type: "text", text: "the words" }] },
          ],
        },
      }),
    );
    expect(listy["message.content"]["[0].content"]).toBe("[1 item]");
    expect(JSON.stringify(listy)).not.toContain("the words");
  });

  it("names a block-list answer past the inline ceiling the same way", () => {
    const long = { type: "text", text: "w".repeat(INLINE_CHARS * 2) };
    const listy = groupsOf(
      JSON.stringify({ message: { content: [{ type: "tool_result", content: [long, long] }] } }),
    );
    expect(listy["message.content"]["[0].content"]).toBe("[2 items]");
  });

  it("says nothing about an answer whose block list is empty", () => {
    // The same rule render() applies everywhere: an empty value is not an
    // answer, and "[0 items]" would be a row about nothing.
    const empty = groupsOf(
      JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t9", content: [] }] } }),
    );
    expect(empty["message.content"]).toEqual({ "[0].type": "tool_result", "[0].tool_use_id": "t9" });
  });

  it("paints a long unnamed string as a block, so the pane's ceiling applies", () => {
    // The fall-through row is a plain <dd> with no ceiling of its own; a
    // future block shape with a 200,000-character string field would bypass
    // the cap every named run of words already gets. Past the inline ceiling
    // the value stays whole and the marking hands it to the pane that caps.
    const long = "s".repeat(200_000);
    const rows = contentRows(JSON.stringify({ message: { content: [{ type: "future", note: long }] } }));
    const row = rows.find((r) => r.key === "[0].note");
    expect(row?.value).toHaveLength(200_000);
    expect(row?.block).toBe("text");
  });

  it("keeps a short unnamed string inline, unmarked", () => {
    const rows = contentRows(
      JSON.stringify({ message: { content: [{ type: "reasoning_summary", summary: "short" }] } }),
    );
    expect(rows.find((r) => r.key === "[0].summary")).toEqual({ key: "[0].summary", value: "short" });
  });

  it("lets every other field of a block through, unnamed ones included", () => {
    const content = groupsOf(call)["message.content"];
    expect(content["[0].name"]).toBe("Bash");
    expect(content["[0].input"]).toBe('{"command":"git status --short"}');
    const future = groupsOf(
      JSON.stringify({ message: { content: [{ type: "reasoning_summary", summary: "short" }] } }),
    );
    expect(future["message.content"]).toEqual({
      "[0].type": "reasoning_summary",
      "[0].summary": "short",
    });
  });

  it("keeps the file's own index, so a second block is [1] and not a new list", () => {
    // Measured over ~/.claude/projects: 83,211 records carry a thinking block
    // at index 0 and three carry one at index 1. The index is the file's.
    const two = groupsOf(
      JSON.stringify({
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "thinking", thinking: "second", signature: "s" },
          ],
        },
      }),
    );
    expect(two["message.content"]).toEqual({
      "[0].type": "text",
      "[0].text": "[2 characters]",
      "[1].type": "thinking",
      "[1].thinking": "second",
      "[1].signature": "s",
    });
  });

  it("produces no thinking row for a record that did not think", () => {
    const rows = contentRows(call);
    expect(rows.map((r) => r.key)).not.toContain("[0].thinking");
    expect(rows.every((r) => r.value !== "")).toBe(true);
  });

  it("produces no thinking row for a thinking block with nothing in it", () => {
    // Measured: the shortest thinking in the corpus is 0 characters. An empty
    // row would claim the model thought and the app lost it.
    const empty = groupsOf(JSON.stringify({ message: { content: [{ type: "thinking", thinking: "" }] } }));
    expect(empty["message.content"]).toEqual({ "[0].type": "thinking" });
  });

  it("says nothing about a body that is not a list of blocks", () => {
    // A user record stores its prompt as a plain string, and that string IS the
    // conversation: run_start and user_message carry it.
    expect(groupsOf(lines(ccSplit)[0])).not.toHaveProperty("message.content");
    expect(readRecordMeta(lines(ccSplit)[0]).map((g) => g.path)).toEqual([""]);
  });

  it("carries a long thought whole and leaves the ceiling to the pane", () => {
    // Measured over 83,214 blocks: median 296 characters, p99 8,625, longest
    // 67,984 — one single block past the source pane's 65,536. The pane stops
    // painting and names both numbers; the value in the row is never cut, or
    // the copy would hand over a file the reader believes is complete.
    const long = "t".repeat(200_000);
    const rows = contentRows(
      JSON.stringify({ message: { content: [{ type: "thinking", thinking: long }] } }),
    );
    expect(rows.find((r) => r.key === "[0].thinking")?.value).toHaveLength(200_000);
  });

  it("lets a field nobody named through rather than swallowing it", () => {
    // The point of the fall-through: a client that invents a field tomorrow
    // reaches the reader without this module being edited first.
    const meta = groupsOf(
      JSON.stringify({ type: "assistant", somethingNew: "a value", message: { role: "assistant" } }),
    );
    expect(meta[""].somethingNew).toBe("a value");
  });

  it("prints a small object whole and names a big one by its shape", () => {
    const small = groupsOf(JSON.stringify({ type: "user", origin: { kind: "hook" } }));
    expect(small[""].origin).toBe('{"kind":"hook"}');
    const big = groupsOf(
      JSON.stringify({ type: "system", hookInfos: [{ blob: "x".repeat(INLINE_CHARS * 2) }] }),
    );
    expect(big[""].hookInfos).toBe("[1 item]");
  });

  it("drops an empty value rather than printing an empty row", () => {
    const meta = groupsOf(JSON.stringify({ type: "user", slug: "", agentId: [], cwd: {} }));
    expect(meta[""]).toEqual({ type: "user" });
  });

  it("returns nothing for a line that is not a JSON object", () => {
    expect(readRecordMeta("not json at all")).toEqual([]);
    expect(readRecordMeta('"a bare string"')).toEqual([]);
    expect(readRecordMeta("[1,2,3]")).toEqual([]);
  });

  it("has nothing to add to a record that is only the conversation", () => {
    // cc-linear predates every one of these fields; its user record carries a
    // role, a content and a uuid and nothing else worth a row.
    const first = groupsOf(lines(ccLinear)[0]);
    expect(first[""]).toEqual({ type: "user", uuid: "u1" });
  });
});

describe("readRecordMeta over a whole real-shaped file", () => {
  it("has something to say about every record of a modern transcript", () => {
    // The claim this module is built on: a modern record carries fields the
    // frames never showed. If some line came back empty, that line is one the
    // reader still cannot see into.
    const empty = lines(ccSplit).filter((l) => readRecordMeta(l).length === 0);
    expect(empty).toEqual([]);
  });

  it("groups only the paths a record actually has something to say about", () => {
    // The user record's message holds a role and a content and nothing else,
    // and both of those ARE the conversation — so there is no message group,
    // rather than an empty one with a heading over no rows.
    expect(readRecordMeta(lines(ccSplit)[0]).map((g) => g.path)).toEqual([""]);
    expect(readRecordMeta(lines(ccSplit)[3]).map((g) => g.path)).toEqual([
      "",
      "message",
      "message.content",
      "message.usage",
    ]);
  });
});
