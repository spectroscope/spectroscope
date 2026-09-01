// The queue's seat, and the promise that nothing else moves for it (card 331).
//
// Criterion 7, and it is the one that makes this card safe to add to a map the
// owner already reads. Every other station on this surface was placed once and
// frozen; a new node that nudged the agent, the user or the OS band would be a
// regression dressed as a feature. The bite is the card's own: fold a run WITH
// a queue and one WITHOUT, and demand every other seat is identical.
//
// The seat is DERIVED from the agent's, not typed. `agent` is the topmost seat
// in COMMON (y150; the next is `user` at y380 and the OS band at y748), so the
// space above it is free — but a literal `y: 20` would be a number nobody could
// re-derive when the agent moves. QUEUE_SEAT reads the agent's y and subtracts.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";

const T = 1700000000000;
const ev = (o: Record<string, unknown>): RunEvent => o as unknown as RunEvent;
const runStart = ev({
  type: "run_start",
  runId: "r1",
  agentId: "main",
  prompt: "hi",
  provider: "anthropic",
  ts: T,
});
const enqueue = ev({ type: "queue_operation", operation: "enqueue", content: "later", ts: T });

function flowOf(events: RunEvent[]) {
  const scene = events.reduce(advanceScene, initialScene());
  return sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "m" });
}

/** Every seat except the queue's own, as `id@x,y` — the comparison surface. */
const seatsExceptQueue = (events: RunEvent[]): string[] =>
  flowOf(events)
    .nodes.filter((n) => n.id !== "queue")
    .map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`)
    .sort();

describe("the queue takes a seat of its own and moves nobody", () => {
  it("leaves every other seat identical whether a run queued or not", () => {
    const without = seatsExceptQueue([runStart]);
    // Worthless if it is empty or one-sided: a comparison of two empty lists
    // passes and proves nothing.
    expect(without.length).toBeGreaterThan(3);
    expect(seatsExceptQueue([runStart, enqueue])).toEqual(without);
  });

  it("sits ABOVE the main agent, which is what the owner asked for", () => {
    const flow = flowOf([runStart, enqueue]);
    const queue = flow.nodes.find((n) => n.id === "queue");
    const agent = flow.nodes.find((n) => n.id === "agent");
    expect(queue, "the node exists once a run has queued").toBeDefined();
    expect(agent).toBeDefined();
    expect(queue!.position.y).toBeLessThan(agent!.position.y);
  });

  it("shares the agent's column, so the edge drops straight onto its top handle", () => {
    const flow = flowOf([runStart, enqueue]);
    const queue = flow.nodes.find((n) => n.id === "queue")!;
    const agent = flow.nodes.find((n) => n.id === "agent")!;
    expect(queue.position.x).toBe(agent.position.x);
  });
});

describe("the edge docks on the top handle, and only on the main agent", () => {
  it("uses the `t` handle that handles.tsx already gives every card", () => {
    // Criterion 6: no new handle is added. `handles.tsx:18` already declares
    // ["t", Position.Top]; this card draws an edge nobody had drawn.
    const edge = flowOf([runStart, enqueue]).edges.find((e) => e.source === "queue");
    expect(edge, "the queue is connected to something").toBeDefined();
    expect(edge!.target).toBe("agent");
    expect(edge!.targetHandle).toBe("t");
  });

  it("connects to no subagent, because a subagent has no queue in this data", () => {
    const spawn = ev({ type: "agent_spawn", agentId: "w1", parentId: "main", task: "t", ts: T });
    const edges = flowOf([runStart, spawn, enqueue]).edges.filter((e) => e.source === "queue");
    expect(edges).toHaveLength(1);
    expect(edges[0].target).toBe("agent");
  });
});

describe("an empty queue is not a missing node — with one criterion narrowed", () => {
  it("draws nothing for a run that never queued", () => {
    // ⚠️ THIS NARROWS CRITERION 4, DELIBERATELY, AND SAYS SO.
    //
    // Card 331 asks that "a run that queued nothing renders the node saying so,
    // the same way every other station does". Card 326 — written after it and
    // now `done` — decided the opposite convention for exactly this class of
    // face, on the owner's own words: "Source muss NUR da sein wenn wir was
    // importieren. das kann weg … das verwirrt sonst nur."
    //
    // `queue_operation` is IMPORT_ONLY (wire/nonWire.ts), so on a native run
    // this node could only ever say "this format cannot record a queue" — which
    // is the empty face card 326 removed. The younger decision wins, and the
    // card carries the narrowing rather than the code carrying a quiet
    // disagreement with its own acceptance criteria.
    //
    // What is NOT narrowed is criterion 4's second half, pinned below: a queue
    // that drained still renders, at zero. Disappearing when it empties would
    // tell the reader the run never queued.
    expect(flowOf([runStart]).nodes.find((n) => n.id === "queue")).toBeUndefined();
  });

  it("stays drawn at zero once a queue has drained", () => {
    const dequeue = ev({ type: "queue_operation", operation: "dequeue", ts: T });
    const flow = flowOf([runStart, enqueue, dequeue]);
    const queue = flow.nodes.find((n) => n.id === "queue");
    expect(queue, "a drained queue still says zero rather than vanishing").toBeDefined();
    expect((queue!.data as { depth: number }).depth).toBe(0);
  });
});
