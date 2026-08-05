// What each listed transcript contains, fetched per visible row and remembered
// under the file state it was read at.
//
// The listing and the facts are two calls on purpose. A directory walk answers
// in milliseconds; reading transcript bodies does not, and the owner's store is
// 1.37 GiB across 167 session files with the largest at 82 MiB. Folding both
// into one call would make the dialog wait for the slow half before it could
// draw the fast one, and a dialog that waits for an index is worse than one
// with no facts at all. So ImportDialog renders the list the moment the listing
// lands, and rows fill in behind it.
//
// Pure module: a loader goes in, a store comes out. No fetch, no React, so the
// batching and the invalidation can be tested without either.

/** One listing row, as much of it as the facts store needs. */
export interface FactsRowRef {
  path: string;
  size: number;
  modifiedAt: number;
}

/**
 * What the server folded out of one transcript.
 *
 * Unknown facts are absent, never a placeholder: `language` and `firstPrompt`
 * are missing when the transcript does not say, so the row renders a blank
 * instead of a dash that reads like a fact. An empty `models` is not an
 * unknown — it says the transcript records no model, which is different.
 */
export interface TranscriptFacts {
  path: string;
  /** Every model that spoke, in the order it first spoke. */
  models: string[];
  workflowCalls: number;
  /** Agent transcripts directly in the session's sidecar folder. */
  subagents: number;
  /**
   * Agent transcripts in the workflow run dirs below that. A different fact
   * than {@link subagents} — on the owner's store it is 85% of all agent
   * files — and a different fact than {@link workflowCalls}, which counts the
   * calls in the transcript body. Optional because a stage-1 server does not
   * send it, and absent means "did not say", not zero.
   */
  workflowAgents?: number;
  language?: string;
  firstPrompt?: string;
}

/**
 * The identity a fact is remembered under: which file, and what state it was in
 * when it was read.
 *
 * Path alone would pin the live transcript's first answer forever. Both halves
 * of the stamp are here for the reason the server keeps both — an append inside
 * one filesystem timestamp tick moves the size and not the clock, and the
 * transcript the operator is talking into right now is exactly that file.
 *
 * This is also the half of the requirement that stops a poll costing a read: a
 * re-listing that finds the same stamp finds the same key, and an already known
 * key is never asked about again.
 */
export function factsKey(row: FactsRowRef): string {
  return `${row.path}\u0000${row.modifiedAt}\u0000${row.size}`;
}

/** How a store reaches the server. */
export interface FactsStoreOptions {
  /** Folds a bounded batch of base-relative paths. May reject. */
  load: (paths: string[]) => Promise<TranscriptFacts[]>;
  /** The server's own cap, published by the facts endpoint. */
  maxBatch: number;
}

/** A store of transcript facts, keyed by file state. */
export interface FactsStore {
  /** Asks for anything in `rows` that is not already known or in flight. */
  request: (rows: FactsRowRef[]) => Promise<void>;
  /** What is known about this row right now, or undefined. */
  factsFor: (row: FactsRowRef) => TranscriptFacts | undefined;
  /** Called whenever new facts land. Returns its own unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Builds a facts store.
 *
 * Three states a key can be in, and the third is the one that is easy to miss:
 * known, in flight, or asked-and-answered-with-nothing. The server returns no
 * row for a path it refused — outside the store, not a transcript, deleted
 * since the listing — and without the third state the dialog would ask again
 * on every scroll for a file that is never going to answer.
 *
 * A rejected load is deliberately NOT that third state. An offline server or a
 * closing tab must leave the row blank and retriable, not permanently empty.
 */
export function createFactsStore({ load, maxBatch }: FactsStoreOptions): FactsStore {
  const known = new Map<string, TranscriptFacts>();
  /** Keys asked for and answered with no row. Asking again would not help. */
  const answeredEmpty = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();

  const announce = () => listeners.forEach((listener) => listener());

  const wanted = (rows: FactsRowRef[]) => {
    const keys = new Map<string, string>(); // key -> path, deduplicated in order
    for (const row of rows) {
      const key = factsKey(row);
      if (known.has(key) || answeredEmpty.has(key) || inFlight.has(key) || keys.has(key)) {
        continue;
      }
      keys.set(key, row.path);
    }
    return [...keys.entries()];
  };

  const fetchBatch = async (batch: [string, string][]) => {
    const paths = batch.map(([, path]) => path);
    try {
      const rows = await load(paths);
      const byPath = new Map(rows.map((facts) => [facts.path, facts]));
      let landed = false;
      for (const [key, path] of batch) {
        const facts = byPath.get(path);
        if (facts) {
          known.set(key, facts);
          landed = true;
        } else {
          // The server looked and had nothing to say about this path. Remember
          // the silence, or every scroll asks again.
          answeredEmpty.add(key);
        }
      }
      if (landed) {
        announce();
      }
    } catch {
      // Blank and retriable. Browsing someone else's store must not be able to
      // wedge the dialog into a state it cannot leave.
    } finally {
      for (const [key] of batch) {
        inFlight.delete(key);
      }
    }
  };

  return {
    async request(rows) {
      const pending = wanted(rows);
      if (pending.length === 0) {
        return;
      }
      // One batch at a time, deliberately. A filter sweep hands this the whole
      // listing — up to 300 rows, thirteen batches — and each batch is a batch
      // of full transcript reads on the server. Serial keeps that a queue
      // instead of thirteen concurrent store-walks, and the store announces
      // after every landed batch, so the screen still fills in as it goes.
      // Everything is marked in flight up front so a scroll during the sweep
      // does not re-ask for a row a later batch already owns.
      const batches: [string, string][][] = [];
      for (let at = 0; at < pending.length; at += maxBatch) {
        batches.push(pending.slice(at, at + maxBatch));
      }
      // The first batch starts NOW — synchronously, so its keys are in flight
      // before this function ever yields; the rest are chained behind it.
      let chain = fetchBatch(batches[0]);
      for (const [key] of batches[0]) {
        inFlight.set(key, chain);
      }
      for (const batch of batches.slice(1)) {
        const run = chain.then(() => fetchBatch(batch));
        for (const [key] of batch) {
          inFlight.set(key, run);
        }
        chain = run;
      }
      await chain;
    },

    factsFor(row) {
      return known.get(factsKey(row));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The facts endpoint's answer shape. */
interface FactsResponse {
  maxBatch?: unknown;
  facts?: unknown;
}

/** The server's cap when it did not publish one, or published nonsense. */
const FALLBACK_BATCH = 24;

/**
 * A loader over the real endpoint.
 *
 * Repeated `path` parameters rather than a POST body, because this is a read:
 * it stays a GET, so it is cacheable, replayable from the published API
 * collection, and covered by the same fence as its two neighbours without the
 * body cap having to have an opinion about it.
 */
export async function loadFactsFromServer(paths: string[]): Promise<TranscriptFacts[]> {
  const query = paths.map((path) => `path=${encodeURIComponent(path)}`).join("&");
  const response = await fetch(`/api/claude/transcripts/facts?${query}`);
  if (!response.ok) {
    throw new Error(`facts: ${response.status}`);
  }
  const body = (await response.json()) as FactsResponse;
  return Array.isArray(body.facts) ? (body.facts as TranscriptFacts[]) : [];
}

/**
 * The batch size the server published, clamped to something sane.
 *
 * Read from the answer rather than hardcoded so the client cannot drift past a
 * server that folds fewer, which would silently truncate every batch.
 */
export function batchSizeFrom(body: unknown): number {
  const published = (body as FactsResponse | null)?.maxBatch;
  return typeof published === "number" && published > 0 ? Math.floor(published) : FALLBACK_BATCH;
}
