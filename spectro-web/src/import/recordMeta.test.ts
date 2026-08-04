// The imported record, opened out for the structured face. Every assertion
// here is about one of the module's three rules: absent says nothing, present
// travels verbatim, and unnamed still arrives.
import { describe, expect, it } from "vitest";
import { INLINE_CHARS, readRecordMeta } from "./recordMeta";
import ccSplit from "./fixtures/cc-split-message.jsonl?raw";
import ccLinear from "./fixtures/cc-linear.jsonl?raw";
import ccCompaction from "./fixtures/cc-compaction.jsonl?raw";

const groupsOf = (line: string): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  for (const g of readRecordMeta(line)) {
    out[g.path] = Object.fromEntries(g.rows.map((r) => [r.key, r.value]));
  }
  return out;
};

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
    expect(readRecordMeta(lines(ccSplit)[3]).map((g) => g.path)).toEqual(["", "message", "message.usage"]);
  });
});

// The compaction's own numbers. The frame carries the count of what went and
// the size of the summary; the four facts beside them — why it fired, how big
// the context was before and after, how long it took — are the record's, and
// they reach the reader here, under the frame the record produced. Without a
// group of their own compactMetadata renders as one `{trigger, preTokens, …}`
// shape, because it runs well past INLINE_CHARS.
describe("readRecordMeta (compaction boundary)", () => {
  const boundary = groupsOf(lines(ccCompaction)[4]);

  it("opens the compaction's numbers into rows of their own", () => {
    expect(boundary["compactMetadata"]).toMatchObject({
      trigger: "auto",
      preTokens: "999135",
      postTokens: "18831",
      durationMs: "155566",
      cumulativeDroppedTokens: "703967",
    });
  });

  it("lets the survivor lists fall through, and names a real one by its shape", () => {
    // Short enough to print whole in the fixture; a real boundary preserves 29
    // to 32 uuids and runs far past INLINE_CHARS, where the block is named
    // instead — the module's own rule, applied one level in.
    expect(boundary["compactMetadata"].preservedMessages).toContain('"allUuids":["a3"]');
    const real = groupsOf(
      JSON.stringify({
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "auto",
          preservedMessages: {
            anchorUuid: "x",
            uuids: [],
            allUuids: Array.from({ length: 30 }, (_, i) => `uuid-${i}-padded-to-look-real`),
          },
        },
      }),
    );
    expect(real["compactMetadata"].preservedMessages).toBe("{anchorUuid, uuids, allUuids}");
  });

  it("says nothing for a number the boundary did not record", () => {
    const second = groupsOf(lines(ccCompaction)[7]);
    expect(second["compactMetadata"].trigger).toBe("manual");
    expect(second["compactMetadata"]).not.toHaveProperty("cumulativeDroppedTokens");
  });

  it("does not repeat the block as a shape on the record itself", () => {
    expect(boundary[""]).not.toHaveProperty("compactMetadata");
    expect(boundary[""].subtype).toBe("compact_boundary");
  });
});
