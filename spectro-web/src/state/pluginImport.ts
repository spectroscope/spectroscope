// Card 526: the store behind the Plugin tab of the playbook pane.
//
// It holds the Claude Code plugins the server found in this home (GET
// /api/playbooks/plugin-sources), by label only, and the answer of the last
// import (POST /api/playbooks/import-plugin): what was copied, what was there
// already, and what the playbook format left out. The server decides every
// mapping and every refusal; a refusal keeps its reason code for reasonText.
// After an import the pane reads the folder again and turns to Skills.

import { useSyncExternalStore } from "react";
import { refreshBundle } from "./bundleEditor";
import { showTab } from "./playbooks";

/** The kinds a plugin import takes, in the order the tab shows them. */
export type PluginKind = "skills" | "agents" | "commands" | "hooks";
export const PLUGIN_KINDS: readonly PluginKind[] = ["skills", "agents", "commands", "hooks"];

/** One plugin as the server lists it. */
export interface PluginRow {
  root: "cache" | "marketplace";
  marketplace: string;
  name: string;
  version: string;
  description: string;
  /** How many of each kind the plugin carries. */
  kinds: Record<PluginKind, number>;
  /** True when the plugin carries MCP servers, which are never copied. */
  mcp: boolean;
  /** False when the plugin has no LICENSE; the server copies nothing of it then. */
  licensed: boolean;
}

/** The answer of an import, with the plugin it came from. */
export interface PluginReport {
  dir: string;
  /** The plugin's name and version, as the report's title shows them. */
  plugin: string;
  imported: { skills: string[]; agents: string[]; commands: string[]; hooks: string[]; scripts: string[] };
  already: string[];
  dropped: { path: string; field: string | null; reason: string }[];
  droppedHooks: { event: string; matcher: string | null; command: string | null; reason: string }[];
  notCopied: string[];
}

export interface PluginImportState {
  /** The folder the rows were read for. */
  dir: string | null;
  rows: PluginRow[] | null;
  /** The last refusal, with its reason code and the server's sentence. */
  error: { reason: string; message: string } | null;
  busy: boolean;
  report: PluginReport | null;
}

const INITIAL: PluginImportState = { dir: null, rows: null, error: null, busy: false, report: null };

let state: PluginImportState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<PluginImportState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** React hook: the Plugin tab's state. */
export function usePluginImport(): PluginImportState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The state right now, for code outside a component. */
export function pluginImportState(): PluginImportState {
  return state;
}

/** The key of a row: its root, marketplace, name and version. */
export function pluginKey(row: PluginRow): string {
  return `${row.root}:${row.marketplace}:${row.name}:${row.version}`;
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => ({}));
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function refusal(status: number, body: Record<string, unknown>): { reason: string; message: string } {
  const reason =
    typeof body.reason === "string" && body.reason !== "" ? body.reason : status === 404 ? "hidden" : "";
  const message = typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${status}`;
  return { reason, message };
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Read the plugins of this home for a registered folder.
 *
 * @param dir the registered playbook folder
 */
export async function loadPluginSources(dir: string): Promise<void> {
  if (state.dir !== dir) set({ dir, rows: null, error: null });
  let res: Response;
  try {
    res = await fetch(`/api/playbooks/plugin-sources?dir=${encodeURIComponent(dir)}`);
  } catch (e) {
    set({ error: { reason: "", message: e instanceof Error ? e.message : String(e) } });
    return;
  }
  const body = await bodyOf(res);
  if (state.dir !== dir) return;
  if (!res.ok) {
    set({ rows: null, error: refusal(res.status, body) });
    return;
  }
  set({ rows: list<PluginRow>(body.plugins), error: null });
}

/**
 * Copy the chosen kinds of a plugin into the folder. On success the report
 * keeps the answer, the folder is read again and the pane turns to Skills; a
 * refusal stays on the Plugin tab with its reason.
 *
 * @param dir       the registered playbook folder
 * @param workspace the workspace of the pane
 * @param row       the plugin, as listed
 * @param kinds     the ticked kinds
 * @return true when the server copied
 */
export async function importPlugin(
  dir: string,
  workspace: string | null,
  row: PluginRow,
  kinds: PluginKind[],
): Promise<boolean> {
  set({ busy: true, error: null });
  let res: Response;
  try {
    res = await fetch("/api/playbooks/import-plugin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dir,
        plugin: { root: row.root, marketplace: row.marketplace, name: row.name, version: row.version },
        kinds,
      }),
    });
  } catch (e) {
    set({ busy: false, error: { reason: "", message: e instanceof Error ? e.message : String(e) } });
    return false;
  }
  const body = await bodyOf(res);
  if (!res.ok) {
    set({ busy: false, error: refusal(res.status, body) });
    return false;
  }
  const imported = (body.imported ?? {}) as Record<string, unknown>;
  set({
    busy: false,
    report: {
      dir,
      plugin: row.version === "" ? row.name : `${row.name} ${row.version}`,
      imported: {
        skills: list(imported.skills),
        agents: list(imported.agents),
        commands: list(imported.commands),
        hooks: list(imported.hooks),
        scripts: list(imported.scripts),
      },
      already: list(body.already),
      dropped: list(body.dropped),
      droppedHooks: list(body.droppedHooks),
      notCopied: list(body.notCopied),
    },
  });
  await refreshBundle(dir, workspace);
  showTab("skills");
  return true;
}

/** Close the report of the last import. */
export function closeReport(): void {
  set({ report: null });
}

/** Test seam: forget the rows and the report. */
export function __resetPluginImport(): void {
  state = INITIAL;
  for (const l of listeners) l();
}
