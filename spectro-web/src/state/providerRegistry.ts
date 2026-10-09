// The provider registry as the web sees it (playbook concept, P1): one list
// of rows from GET /api/providers, replaced wholesale by every answer, and a
// POST that asks the server to check one provider, the local kind, or all.
// The server derives the state; this module never second-guesses it.

import { useSyncExternalStore } from "react";

export type ProviderKind = "cloud" | "local" | "builtin";
export type ProviderState = "needs-key" | "needs-download" | "configured" | "reachable" | "failed";

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  state: ProviderState;
  /** Presence only, never a value. */
  keyPresent: boolean;
  endpoint: string | null;
  models: string[];
  live: boolean;
  reason: string | null;
  /** Epoch milliseconds of the last check, 0 when none ran. */
  checkedAt: number;
}

let rows: ProviderRow[] = [];
const listeners = new Set<() => void>();

function adopt(next: ProviderRow[]): void {
  rows = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The rows as of the last answer; empty before the first one. */
export function providerRows(): ProviderRow[] {
  return rows;
}

export function rowFor(id: string): ProviderRow | undefined {
  return rows.find((r) => r.id === id);
}

export function useProviderRows(): ProviderRow[] {
  return useSyncExternalStore(subscribe, providerRows, providerRows);
}

function isRow(x: unknown): x is ProviderRow {
  return typeof x === "object" && x !== null && typeof (x as ProviderRow).id === "string";
}

async function take(response: Response): Promise<void> {
  if (!response.ok) return;
  const body = (await response.json()) as { providers?: unknown };
  if (Array.isArray(body.providers)) adopt(body.providers.filter(isRow));
}

/** GET: presence plus the last stored checks, no request to any provider. */
export async function refreshProviders(): Promise<void> {
  try {
    await take(await fetch("/api/providers"));
  } catch {
    // keep what we have: a lost read must not blank the picker
  }
}

/** POST: the server checks the target and answers with every row. */
export async function checkProviders(target: "all" | "local" | string): Promise<void> {
  try {
    await take(await fetch(`/api/providers/check?provider=${encodeURIComponent(target)}`, { method: "POST" }));
  } catch {
    // same rule as above
  }
}

/** Test only. */
export function __resetProviderRegistry(): void {
  rows = [];
}
