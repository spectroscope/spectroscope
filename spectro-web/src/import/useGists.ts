// One model-written line per transcript, fetched free and written on a press.
//
// The dialog can already say a transcript's size, model and agent counts without
// opening it. What it cannot say is what the session was ABOUT: the first prompt
// is often "read the card first", a pasted stack trace, or 4,000 characters of
// log. A gist is that missing line — and unlike everything else on the row it
// costs a model call, so it is a button and never a side effect of opening the
// dialog.
//
// The store is the server's, on disk, keyed by each file's size and mtime. That
// shape is the whole design: pressing again after adding transcripts asks about
// the new ones only, a transcript that has GROWN is asked about again because
// its old sentence describes a shorter run, and the answers survive a restart or
// the button becomes a tax the operator pays on every open.

import { useCallback, useEffect, useState } from "react";

export interface GistRow {
  path: string;
  text: string;
  /** The model that wrote it — a gist is a reading, and the reader matters. */
  model: string;
  /** True when the transcript has changed since the line was written. */
  stale: boolean;
}

export interface GistsState {
  /** By store-relative path. */
  byPath: ReadonlyMap<string, GistRow>;
  /** True while a press is in flight. */
  working: boolean;
  /** How many the last press actually wrote. */
  written: number | null;
  /** The provider's own words when it would not build ("set a key in Settings"). */
  error: string | null;
  /** Write the missing ones for these paths. */
  run: (paths: string[]) => void;
  /** Forget everything and write them all again — for a new model. */
  runAll: (paths: string[]) => void;
}

function index(rows: GistRow[]): Map<string, GistRow> {
  const out = new Map<string, GistRow>();
  for (const r of rows) if (typeof r?.path === "string" && typeof r?.text === "string") out.set(r.path, r);
  return out;
}

export function useGists(): GistsState {
  const [byPath, setByPath] = useState<Map<string, GistRow>>(new Map());
  const [working, setWorking] = useState(false);
  const [written, setWritten] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Free: what is already on disk, on open. No model, no transcript read.
  useEffect(() => {
    let alive = true;
    void fetch("/api/claude/transcripts/gists")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { gists?: GistRow[] } | null) => {
        if (alive && body?.gists) setByPath(index(body.gists));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const press = useCallback((paths: string[], all: boolean) => {
    if (paths.length === 0) return;
    setWorking(true);
    setError(null);
    setWritten(null);
    void fetch("/api/claude/transcripts/gists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, all }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { gists?: GistRow[]; written?: number; error?: string | null }) => {
        // `all` replaces the map; a press for the missing ones merges, because
        // the answer only carries the paths that were asked about.
        setByPath((was) => (all ? index(body.gists ?? []) : new Map([...was, ...index(body.gists ?? [])])));
        setWritten(typeof body.written === "number" ? body.written : 0);
        setError(body.error ?? null);
      })
      .catch(() => setError("failed"))
      .finally(() => setWorking(false));
  }, []);

  return {
    byPath,
    working,
    written,
    error,
    run: useCallback((paths: string[]) => press(paths, false), [press]),
    runAll: useCallback((paths: string[]) => press(paths, true), [press]),
  };
}

/**
 * The paths on screen that have no current gist — what the plain button costs.
 *
 * @param paths every path the dialog is showing
 * @param byPath what is stored
 * @return the ones a press would actually ask a model about
 */
export function missingGists(paths: string[], byPath: ReadonlyMap<string, GistRow>): string[] {
  return paths.filter((p) => {
    const g = byPath.get(p);
    return g === undefined || g.stale;
  });
}
