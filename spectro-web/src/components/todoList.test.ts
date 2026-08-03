// The todo list an imported transcript carries (card 141), read as a list.
//
// House test style: pure logic only, no DOM (the repo has none). The markup is
// covered by the TypeScript build and by the live pass; what can drift is the
// reading of somebody else's item shape, and that is all this file pins.
//
// Every count below was measured over the 4,554 transcripts in ~/.claude/
// projects, 30,780 items in total, and the numbers decide the rules:
//   id, subject, description, status, blocks, blockedBy   30,780 (all)
//   activeForm                                            29,177 (94.8%)
//   owner                                                    350  (1.1%)
//   blocks NON-EMPTY                                          678  (2.2%)
//   blockedBy NON-EMPTY                                       668  (2.2%)
//   statuses: completed 24,791 / pending 4,346 / in_progress 1,643, nothing else
//   subject == description                                    171  (0.6%)
// So blocks and blockedBy are present and empty on 97.8% of items: rendering
// them unconditionally would print "blocks" with nothing after it thirty
// thousand times, which is the blank cell card 139 refused.

import { describe, expect, it } from "vitest";
import { readTodoItems, statusLabel, todoCounts, todoSummary } from "./todoList";

/** One item in the shape the corpus really has. */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    subject: "Read the census",
    description: "Count the fields on every task_reminder item",
    activeForm: "Reading the census",
    status: "completed",
    blocks: [],
    blockedBy: [],
    ...over,
  };
}

describe("readTodoItems", () => {
  it("reads every item as its subject and its status", () => {
    const items = readTodoItems([
      item({ id: "1", subject: "one", status: "completed" }),
      item({ id: "2", subject: "two", status: "in_progress" }),
      item({ id: "3", subject: "three", status: "pending" }),
    ]);
    expect(items?.map((i) => [i.id, i.subject, i.status])).toEqual([
      ["1", "one", "completed"],
      ["2", "two", "in_progress"],
      ["3", "three", "pending"],
    ]);
  });

  it("keeps the description, which is the whole reason the plan shape was refused", () => {
    // planRow reads only `text`; an item arriving through it would lose the
    // sentence that says what the task actually is (toolViews.ts:1189).
    const items = readTodoItems([item({ description: "Count the fields" })]);
    expect(items?.[0].description).toBe("Count the fields");
  });

  it("says the description once when it is the subject again", () => {
    // 171 of 30,780 items repeat themselves. Printing the same sentence twice
    // under itself is noise, not evidence.
    const items = readTodoItems([item({ subject: "same", description: "same" })]);
    expect(items?.[0].description).toBeUndefined();
  });

  it("carries no field the item left empty", () => {
    const items = readTodoItems([item({ blocks: [], blockedBy: [] })]);
    expect(items?.[0].blocks).toBeUndefined();
    expect(items?.[0].blockedBy).toBeUndefined();
    expect(items?.[0].owner).toBeUndefined();
  });

  it("carries blocks and blockedBy when the item really is tied to another", () => {
    const items = readTodoItems([item({ blocks: ["7"], blockedBy: ["3", "4"] })]);
    expect(items?.[0].blocks).toEqual(["7"]);
    expect(items?.[0].blockedBy).toEqual(["3", "4"]);
  });

  it("puts activeForm only on the item that is running", () => {
    // activeForm is the present-tense caption the client shows while an item is
    // in flight. On a finished item it describes an activity that has stopped,
    // and it differs from the subject on 99.8% of items, so on all 24,791
    // completed ones it would be a second title in another tense.
    const items = readTodoItems([
      item({ status: "in_progress", activeForm: "Reading the census" }),
      item({ status: "completed", activeForm: "Reading the census" }),
      item({ status: "pending", activeForm: "Reading the census" }),
    ]);
    expect(items?.map((i) => i.activeForm)).toEqual(["Reading the census", undefined, undefined]);
  });

  it("carries the owner when one is named", () => {
    const items = readTodoItems([item({ owner: "handbook-agent" })]);
    expect(items?.[0].owner).toBe("handbook-agent");
  });

  it("refuses the whole list when one item has nothing to show", () => {
    // The escape hatch that keeps "nothing is dropped" true: a prettier
    // rendering may not swallow an item it cannot draw. Refusing returns the
    // caller to the raw shape, where every field is still on screen.
    expect(readTodoItems([item(), { id: "2", status: "pending" }])).toBeNull();
    expect(readTodoItems([item(), item({ subject: "" })])).toBeNull();
    expect(readTodoItems([item(), item({ status: "" })])).toBeNull();
  });

  it("refuses anything that is not a list of items", () => {
    expect(readTodoItems(undefined)).toBeNull();
    expect(readTodoItems("todo")).toBeNull();
    expect(readTodoItems([1, 2])).toBeNull();
    expect(readTodoItems([])).toBeNull();
  });
});

describe("todoCounts", () => {
  it("counts by status in the lifecycle's order, whatever order the file has", () => {
    const items = readTodoItems([
      item({ status: "completed" }),
      item({ status: "pending" }),
      item({ status: "completed" }),
      item({ status: "in_progress" }),
      item({ status: "completed" }),
    ]);
    expect(todoCounts(items ?? [])).toEqual([
      { status: "pending", n: 1 },
      { status: "in_progress", n: 1 },
      { status: "completed", n: 3 },
    ]);
  });

  it("names no status the list does not have", () => {
    const items = readTodoItems([item({ status: "completed" })]);
    expect(todoCounts(items ?? [])).toEqual([{ status: "completed", n: 1 }]);
  });

  it("keeps a status it has never heard of, after the ones it knows", () => {
    // The corpus has exactly three today. A fourth must not fall off the count.
    const items = readTodoItems([
      item({ status: "blocked" }),
      item({ status: "completed" }),
      item({ status: "cancelled" }),
      item({ status: "blocked" }),
    ]);
    expect(todoCounts(items ?? [])).toEqual([
      { status: "completed", n: 1 },
      { status: "blocked", n: 2 },
      { status: "cancelled", n: 1 },
    ]);
  });
});

describe("todoSummary", () => {
  it("reads as counts in both languages, not as json", () => {
    const items =
      readTodoItems([
        item({ status: "completed" }),
        item({ status: "completed" }),
        item({ status: "in_progress" }),
        item({ status: "pending" }),
      ]) ?? [];
    expect(todoSummary(items, "en")).toBe("1 open · 1 running · 2 done");
    expect(todoSummary(items, "de")).toBe("1 offen · 1 in Arbeit · 2 fertig");
  });

  it("counts in words that survive a plural", () => {
    // Found live, in German. The plan panel's badge says "läuft …" and that is
    // right for ONE step that is running; as a count "2 läuft …" is not a
    // German sentence. A count needs its own word, so the badge keeps the
    // status label and the summary uses the counting one.
    const many = readTodoItems([item({ status: "in_progress" }), item({ status: "in_progress" })]) ?? [];
    expect(todoSummary(many, "de")).toBe("2 in Arbeit");
    expect(todoSummary(many, "en")).toBe("2 running");
  });

  it("counts a status it has no word for by its wire name", () => {
    const odd = readTodoItems([item({ status: "blocked" })]) ?? [];
    expect(todoSummary(odd, "de")).toBe("1 blocked");
  });

  it("says nothing about a list it cannot read", () => {
    expect(todoSummary([], "en")).toBe("");
  });
});

describe("statusLabel lives here now, and still answers for the plan", () => {
  // One vocabulary for the three wire statuses. It was in PlanTab, which is a
  // component: a second copy for the trace is how two words for one status
  // start. PlanTab imports it from here and its own test still reads it there.
  it("translates the three wire statuses", () => {
    expect([statusLabel("pending"), statusLabel("in_progress"), statusLabel("completed")]).toEqual([
      "open",
      "running …",
      "done",
    ]);
    expect(statusLabel("completed", "de")).toBe("fertig");
  });

  it("passes an unknown status through unchanged", () => {
    expect(statusLabel("blocked")).toBe("blocked");
  });
});
