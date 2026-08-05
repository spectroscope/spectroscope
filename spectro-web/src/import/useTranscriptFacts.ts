// Wiring only. Every decision this hook appears to make lives in
// transcriptFacts.ts, which is pure and tested: what a row is keyed by, when a
// row is re-asked, how a batch is cut, what happens to a path the server
// refused. There is no jsdom in this project's gate, so a hook cannot be tested
// here; keeping it this thin is what makes that acceptable.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createFactsStore,
  loadFactsFromServer,
  type FactsRowRef,
  type TranscriptFacts,
} from "./transcriptFacts";

/** The server's cap. Overridden by whatever the endpoint publishes on first answer. */
const DEFAULT_BATCH = 24;

/**
 * Transcript facts for the rows the dialog is showing.
 *
 * The contract the next stage relies on: `factsFor` answers undefined until the
 * facts land, and the caller renders a blank for undefined rather than waiting.
 * The list is never blocked on this hook — it is drawn from the listing, and
 * these arrive underneath it.
 *
 * @param maxBatch the server's published cap, when the caller already knows it
 * @returns `request` to ask for a set of visible rows, and `factsFor` to read one
 */
export function useTranscriptFacts(maxBatch: number = DEFAULT_BATCH) {
  const store = useRef<ReturnType<typeof createFactsStore> | null>(null);
  if (store.current === null) {
    store.current = createFactsStore({ load: loadFactsFromServer, maxBatch });
  }
  // A counter, not the facts themselves: the store owns them, and copying the
  // map into state on every batch would re-render every row for one arrival.
  const [landed, setLanded] = useState(0);

  useEffect(() => store.current!.subscribe(() => setLanded((n) => n + 1)), []);

  const request = useCallback((rows: FactsRowRef[]) => {
    void store.current!.request(rows);
  }, []);

  const factsFor = useCallback(
    (row: FactsRowRef): TranscriptFacts | undefined => store.current!.factsFor(row),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- landed is the signal that the store moved
    [landed],
  );

  return { request, factsFor };
}
