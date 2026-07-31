// Which optional columns the trace shows (owner 2026-07-27) — a tiny external
// store à la disclosure.ts / toolView.ts, persisted to localStorage.
//
//   host  — the network counterpart of the frame (api.anthropic.com, …)
//   model — the model serving the frame's run
//
// Both are ON out of the box: they answer "who did I talk to" and "with which
// model", which is the whole point of the wire view. Switching one off is a
// reading choice for narrow windows, so it persists like the lenses do — and a
// stored choice beats the default.

import { useSyncExternalStore } from "react";

export interface TraceColumns {
  host: boolean;
  model: boolean;
}

export type TraceColumn = keyof TraceColumns;

export const TRACE_COLUMNS: TraceColumn[] = ["host", "model"];

export const DEFAULT_TRACE_COLUMNS: TraceColumns = { host: true, model: true };

const KEY = "spectroscope:trace.columns";

/** Visible for tests: the stored record, column by column. A value that is not
 *  a boolean (foreign writer, half-written record) leaves that column at its
 *  default instead of guessing the reader meant "off". */
export function parseTraceColumns(raw: string | null): TraceColumns {
  if (raw === null) return { ...DEFAULT_TRACE_COLUMNS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_TRACE_COLUMNS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_TRACE_COLUMNS };
  }
  const rec = parsed as Record<string, unknown>;
  const pick = (c: TraceColumn): boolean =>
    typeof rec[c] === "boolean" ? (rec[c] as boolean) : DEFAULT_TRACE_COLUMNS[c];
  return { host: pick("host"), model: pick("model") };
}

function readSaved(): TraceColumns {
  try {
    return parseTraceColumns(localStorage.getItem(KEY));
  } catch {
    /* no localStorage (tests) — default */
  }
  return { ...DEFAULT_TRACE_COLUMNS };
}

let columns: TraceColumns = readSaved();
const listeners = new Set<() => void>();

export function setTraceColumn(column: TraceColumn, on: boolean): void {
  if (columns[column] === on) return;
  // A fresh object per change, the same one between changes — the snapshot
  // identity is what useSyncExternalStore compares.
  columns = { ...columns, [column]: on };
  try {
    localStorage.setItem(KEY, JSON.stringify(columns));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentTraceColumns(): TraceColumns {
  return columns;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): TraceColumns {
  return columns;
}

export function useTraceColumns(): TraceColumns {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** What a session actually has to show in each optional column. */
export interface TraceColumnData {
  host: boolean;
  model: boolean;
}

/**
 * Which columns to render: the reader's choice, minus the ones this session has
 * no data for.
 *
 * A VS Code agent export carries neither host nor model — the format does not
 * record them — and a pre-0.4.0 archive carries no model. Holding a column open
 * for a session that will never fill it spends the reader's horizontal space on
 * a colonnade of dashes. Hiding it is not hiding information: there is none.
 *
 * The reader's OFF always wins, so this can only ever take a column away, never
 * put one back that was switched off by hand.
 *
 * @param chosen the persisted preference
 * @param present whether the session has any value at all in each column
 * @return the columns to render
 */
export function effectiveTraceColumns(chosen: TraceColumns, present: TraceColumnData): TraceColumns {
  return { host: chosen.host && present.host, model: chosen.model && present.model };
}

/**
 * Whether a column is worth offering at all, scanned once over the rows.
 *
 * @param rows anything carrying an optional host and model
 * @return which columns have at least one non-empty value
 */
export function traceColumnData(
  rows: readonly { host?: string | null; model?: string | null }[],
): TraceColumnData {
  let host = false;
  let model = false;
  for (const r of rows) {
    if (!host && typeof r.host === "string" && r.host.trim() !== "") host = true;
    if (!model && typeof r.model === "string" && r.model.trim() !== "") model = true;
    if (host && model) break;
  }
  return { host, model };
}
