// The queue stands above the main agent (card 331).
//
// THE OWNER'S ASK, verbatim: "können wir noch eine queue hier machen also über
// der LLM oder eben da, wo der connector vom agenten andockt (zumindest vom
// main agent) also gerne für den main agent ein neuen connector punkt oben
// statt links an der seite … und da einen queue anzeigen mit den aktuell noch
// nicht dequeuten kommandos?"
//
// WHY THE DEPTH IS A RUNNING SUBTRACTION AND NEVER A MATCHED LIST. Re-measured
// 2026-09-01 over every Claude Code transcript on this machine — 342 session
// files, up from the 67 the card was written against, and the argument got
// STRONGER with the data:
//
//   queue-operation lines      15,477   (card: 6,177)
//   carrying no content at all  5,287 = 34.2 %   (card: 30.2 %)
//   of the 10,190 that do, repeated texts  6,751
//   the most frequent text appears            59×   (card: 12×)
//   enqueue 7,745 − dequeue 4,029 − remove 3,703 =  13
//
// A third of the operations name nothing, two thirds of the named ones share
// their text with another, and the frame carries NO ID. So a dequeue can retire
// DEPTH and can never honestly retire a named row: pairing by text would guess,
// and a guess that looks like a fact is the defect this house keeps finding.
// The final 13 is the arithmetic sanity check — a running subtraction over the
// whole corpus lands just above zero, which is what a queue should do.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { queueView } from "./queueDepth";

const T = 1700000000000;
const ev = (o: Record<string, unknown>): RunEvent => o as unknown as RunEvent;
const op = (operation: string, content?: string): RunEvent =>
  ev({ type: "queue_operation", operation, ...(content ? { content } : {}), ts: T });

describe("the depth is a running subtraction, exact at every step", () => {
  it("counts enqueue up and dequeue down, AT EACH MOMENT and not only at the end", () => {
    // Card criterion 1, and the "at each moment" is the whole point: a fold that
    // summed the totals would also answer 1 here and be wrong in between.
    const seq = [op("enqueue", "a"), op("enqueue", "b"), op("dequeue")];
    expect(seq.map((_, i) => queueView(seq.slice(0, i + 1)).depth)).toEqual([1, 2, 1]);
  });

  it("treats remove as a departure too", () => {
    // `remove` is 3,703 of the 15,477 measured operations — a quarter of them.
    // A fold that only knew enqueue and dequeue would drift upward forever.
    const seq = [op("enqueue"), op("enqueue"), op("remove"), op("dequeue")];
    expect(seq.map((_, i) => queueView(seq.slice(0, i + 1)).depth)).toEqual([1, 2, 1, 0]);
  });

  it("never goes below zero, because a transcript can open mid-queue", () => {
    // An imported file may start after the enqueue it dequeues. A negative depth
    // would be a number no reader can act on.
    expect(queueView([op("dequeue"), op("dequeue")]).depth).toBe(0);
  });

  it("ignores everything that is not a queue operation", () => {
    const noise = ev({ type: "text_delta", agentId: "main", text: "enqueue", ts: T });
    expect(queueView([op("enqueue"), noise, op("enqueue")]).depth).toBe(2);
  });
});

describe("a named command is named, an unnamed one is counted", () => {
  it("prints the text it has and counts the ones it does not", () => {
    // Criterion 2, two separate facts. 34.2 % of real operations carry no
    // content; a node that silently showed two of three entries would teach the
    // reader to trust a list that is missing a third of itself.
    const view = queueView([op("enqueue", "run the tests"), op("enqueue"), op("enqueue", "deploy")]);
    expect(view.named).toEqual(["run the tests", "deploy"]);
    expect(view.unnamed).toBe(1);
    expect(view.depth).toBe(3);
  });

  it("says how many it cannot name even when it can name none", () => {
    const view = queueView([op("enqueue"), op("enqueue")]);
    expect(view.named).toEqual([]);
    expect(view.unnamed).toBe(2);
  });
});

describe("no command is matched to a dequeue by its text", () => {
  it("retires depth without claiming to know WHICH of two identical texts left", () => {
    // Criterion 3, the bite the card names. Two identical texts enqueued, one
    // dequeued: the honest answer is a depth of 1 and a refusal to say which.
    // Measured justification: 6,751 of 10,190 texts repeat and one appears 59
    // times, on a frame with no id.
    const view = queueView([op("enqueue", "same"), op("enqueue", "same"), op("dequeue")]);
    expect(view.depth).toBe(1);
    // It must NOT have removed one of the two rows: the names it can still show
    // are both, and the count of what it cannot pair is stated instead.
    expect(view.named).toEqual(["same", "same"]);
    expect(view.retired).toBe(1);
  });

  it("keeps the same shape when the dequeue carries the text too", () => {
    // A dequeue that happens to carry content is not permission to pair —
    // that is exactly the guess criterion 3 forbids.
    const view = queueView([op("enqueue", "same"), op("enqueue", "same"), op("dequeue", "same")]);
    expect(view.depth).toBe(1);
    expect(view.named).toEqual(["same", "same"]);
  });
});

describe("an empty queue is not a missing node", () => {
  it("answers zero for a run that queued nothing", () => {
    const view = queueView([]);
    expect(view.depth).toBe(0);
    expect(view.everQueued).toBe(false);
  });

  it("answers zero for a queue that emptied again, and says it once had one", () => {
    // Criterion 4's second case: a node that disappeared when the queue drained
    // would tell the reader the run never queued anything.
    const view = queueView([op("enqueue", "a"), op("dequeue")]);
    expect(view.depth).toBe(0);
    expect(view.everQueued).toBe(true);
  });
});
