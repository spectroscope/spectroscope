// The queue-while-running model (card 78 #3): messages typed during a run wait
// as chips and auto-send when the run ends. Pure list logic — the drain timing
// lives in App; these pins keep ids stable and removal exact.

import { describe, expect, it } from "vitest";
import { enqueue, removeQueued, type QueuedMessage } from "./sendQueue";

const att = { name: "a.png", mediaType: "image/png", dataBase64: "aa==", sizeBytes: 2 };

describe("sendQueue", () => {
  it("enqueues in order and keeps the attachment snapshot", () => {
    let q: QueuedMessage[] = [];
    q = enqueue(q, "first", [att]);
    q = enqueue(q, "second");
    expect(q.map((m) => m.text)).toEqual(["first", "second"]);
    expect(q[0].attachments).toEqual([att]);
    expect(q[1].attachments).toBeUndefined();
  });

  it("assigns monotonically increasing ids, stable across removals", () => {
    let q: QueuedMessage[] = [];
    q = enqueue(q, "a");
    q = enqueue(q, "b");
    const idB = q[1].id;
    q = removeQueued(q, q[0].id);
    q = enqueue(q, "c");
    // c's id must NOT collide with b's surviving id after a's removal.
    expect(q.map((m) => m.id)).toEqual([idB, idB + 1]);
  });

  it("removes exactly the given id and tolerates unknown ids", () => {
    let q: QueuedMessage[] = [];
    q = enqueue(q, "a");
    q = enqueue(q, "b");
    q = enqueue(q, "c");
    q = removeQueued(q, q[1].id);
    expect(q.map((m) => m.text)).toEqual(["a", "c"]);
    expect(removeQueued(q, 999)).toEqual(q);
  });

  it("ignores blank text", () => {
    expect(enqueue([], "   ")).toEqual([]);
  });
});
