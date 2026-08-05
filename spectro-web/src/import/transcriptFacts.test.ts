import { describe, expect, it, vi } from "vitest";
import { createFactsStore, factsKey, type TranscriptFacts } from "./transcriptFacts";

/** A listing row, as GET /api/claude/transcripts hands it over. */
function row(path: string, modifiedAt = 10, size = 100) {
  return { path, project: "p", file: path, size, modifiedAt };
}

function facts(path: string, over: Partial<TranscriptFacts> = {}): TranscriptFacts {
  return { path, models: [], workflowCalls: 0, subagents: 0, ...over };
}

describe("factsKey", () => {
  it("changes when the transcript grows", () => {
    expect(factsKey(row("a.jsonl", 10, 100))).not.toBe(factsKey(row("a.jsonl", 10, 200)));
  });

  it("changes when the transcript is touched at the same size", () => {
    expect(factsKey(row("a.jsonl", 10, 100))).not.toBe(factsKey(row("a.jsonl", 20, 100)));
  });

  it("is stable for a transcript that did not move", () => {
    expect(factsKey(row("a.jsonl", 10, 100))).toBe(factsKey(row("a.jsonl", 10, 100)));
  });
});

describe("createFactsStore", () => {
  it("asks the server only for the rows it was given", async () => {
    const load = vi.fn(async (paths: string[]) => paths.map((p) => facts(p)));
    const store = createFactsStore({ load, maxBatch: 24 });

    await store.request([row("a.jsonl"), row("b.jsonl")]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(["a.jsonl", "b.jsonl"]);
  });

  it("has nothing for a row it has not been asked about, rather than a placeholder", () => {
    const store = createFactsStore({ load: async () => [], maxBatch: 24 });

    expect(store.factsFor(row("a.jsonl"))).toBeUndefined();
  });

  it("serves a row it already knows without asking again", async () => {
    const load = vi.fn(async (paths: string[]) => paths.map((p) => facts(p, { subagents: 3 })));
    const store = createFactsStore({ load, maxBatch: 24 });

    await store.request([row("a.jsonl")]);
    await store.request([row("a.jsonl")]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(store.factsFor(row("a.jsonl"))?.subagents).toBe(3);
  });

  /**
   * The live session. A re-listing that finds the transcript unchanged must not
   * cost another read, and a re-listing that finds it grown must.
   */
  it("re-asks only for the transcript that actually moved", async () => {
    const load = vi.fn(async (paths: string[]) => paths.map((p) => facts(p)));
    const store = createFactsStore({ load, maxBatch: 24 });
    await store.request([row("live.jsonl", 10, 100), row("done.jsonl", 5, 50)]);
    load.mockClear();

    await store.request([row("live.jsonl", 11, 900), row("done.jsonl", 5, 50)]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(["live.jsonl"]);
  });

  it("drops the stale answer when a transcript is asked about under a new stamp", async () => {
    const load = vi.fn(async (paths: string[]) =>
      paths.map((p) => facts(p, { models: [`m${p.length}`], workflowCalls: 7 })),
    );
    const store = createFactsStore({ load, maxBatch: 24 });
    await store.request([row("a.jsonl", 10, 100)]);

    const grown = row("a.jsonl", 10, 500);
    expect(store.factsFor(grown)).toBeUndefined();
    await store.request([grown]);
    expect(store.factsFor(grown)?.workflowCalls).toBe(7);
  });

  it("never sends more paths in one call than the server folds", async () => {
    const load = vi.fn(async (paths: string[]) => paths.map((p) => facts(p)));
    const store = createFactsStore({ load, maxBatch: 3 });

    await store.request([1, 2, 3, 4, 5, 6, 7].map((n) => row(`s${n}.jsonl`)));

    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls.map((c) => c[0].length)).toEqual([3, 3, 1]);
  });

  /**
   * A filter sweep asks for all 300 rows at once. Thirteen parallel batches
   * would put thirteen concurrent full-store reads on a single-machine server;
   * one at a time keeps the sweep progressive — every landed batch announces —
   * without ever stacking reads.
   */
  it("runs the batches of one ask one after another, not all at once", async () => {
    let open = 0;
    let mostOpen = 0;
    const load = vi.fn(async (paths: string[]) => {
      open++;
      mostOpen = Math.max(mostOpen, open);
      await new Promise((r) => setTimeout(r, 0));
      open--;
      return paths.map((p) => facts(p));
    });
    const store = createFactsStore({ load, maxBatch: 2 });

    await store.request([1, 2, 3, 4, 5, 6].map((n) => row(`s${n}.jsonl`)));

    expect(load).toHaveBeenCalledTimes(3);
    expect(mostOpen).toBe(1);
  });

  it("does not ask twice for a row whose first ask is still in flight", async () => {
    let release: (v: TranscriptFacts[]) => void = () => {};
    const load = vi.fn(() => new Promise<TranscriptFacts[]>((r) => (release = r)));
    const store = createFactsStore({ load, maxBatch: 24 });

    const first = store.request([row("a.jsonl")]);
    const second = store.request([row("a.jsonl")]);
    release([facts("a.jsonl")]);
    await Promise.all([first, second]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tells its listeners once the facts have landed", async () => {
    const store = createFactsStore({ load: async (p) => p.map((x) => facts(x)), maxBatch: 24 });
    const heard = vi.fn();
    store.subscribe(heard);

    await store.request([row("a.jsonl")]);

    expect(heard).toHaveBeenCalled();
  });

  it("stops telling a listener that unsubscribed", async () => {
    const store = createFactsStore({ load: async (p) => p.map((x) => facts(x)), maxBatch: 24 });
    const heard = vi.fn();
    store.subscribe(heard)();

    await store.request([row("a.jsonl")]);

    expect(heard).not.toHaveBeenCalled();
  });

  /**
   * Browsing somebody else's store must not be able to break the dialog. A
   * failed ask leaves the row blank and lets a later ask try again, rather than
   * poisoning the row with an error state it can never leave.
   */
  it("leaves a row blank when the ask fails, and will try it again", async () => {
    const load = vi
      .fn<(paths: string[]) => Promise<TranscriptFacts[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([facts("a.jsonl", { subagents: 2 })]);
    const store = createFactsStore({ load, maxBatch: 24 });

    await store.request([row("a.jsonl")]);
    expect(store.factsFor(row("a.jsonl"))).toBeUndefined();

    await store.request([row("a.jsonl")]);
    expect(store.factsFor(row("a.jsonl"))?.subagents).toBe(2);
  });

  /**
   * A path the server refused (outside the store, gone since the listing) comes
   * back with no row at all. That must not leave the client asking for it on
   * every scroll.
   */
  it("does not re-ask for a path the server answered nothing about", async () => {
    const load = vi.fn(async () => []);
    const store = createFactsStore({ load, maxBatch: 24 });

    await store.request([row("gone.jsonl")]);
    await store.request([row("gone.jsonl")]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(store.factsFor(row("gone.jsonl"))).toBeUndefined();
  });
});
