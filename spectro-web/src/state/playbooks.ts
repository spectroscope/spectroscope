// The web store of the playbook module (card 481, spec P2).
//
// Two module stores read with useSyncExternalStore, the idiom of the other
// state files: the known playbook folders with the one pinned to the workspace,
// and the playbook last loaded. The server owns both facts (`~/.spectro/
// playbooks.json` and the folder on disk); this file only mirrors its answers.
//
// A refused call throws the server's readable message and leaves the stores as
// they were, except a refused load, which clears the loaded playbook: a graph
// from the folder before must not stand under the error of the folder now.

import { useSyncExternalStore } from "react";
import type { Topology } from "../stategraph/layout";

export interface PlaybookFoldersState {
  folders: string[];
  active: string | null;
}

export interface ModelRefWire {
  provider: string;
  model: string;
}

export type PlaybookNode =
  | {
      kind: "step";
      id: string;
      name: string;
      performer: "chat" | "child";
      skills: string[];
      model: string | null;
      privacy: "private" | "cheap";
      consumes: string[];
      produces: string[];
      nod: boolean;
    }
  | {
      kind: "decision";
      id: string;
      name: string;
      check: string;
      outcomes: string[];
      maxRounds: number | null;
    }
  | { kind: "end"; id: string; result: string };

export interface PlaybookArrow {
  from: string;
  to: string;
  on: string | null;
}

export interface LoadedPlaybook {
  /** Null when the reader refused the file: the findings say why, and nothing is drawn. */
  playbook: {
    id: string;
    name: string;
    description: string;
    start: string;
    nodes: PlaybookNode[];
    arrows: PlaybookArrow[];
    models: Record<string, { primary: ModelRefWire; fallbacks: ModelRefWire[] }>;
    documents: Record<string, { name: string; purpose: string; location: string; sections: string[] }>;
    /** The paths the playbook lists as its contents, per kind (card 485). */
    contents: {
      skills: string[];
      agents: string[];
      hooks: string[];
      commands: string[];
      workflows: string[];
    };
  } | null;
  /** Null exactly when `playbook` is. */
  topology: {
    entry: string;
    nodes: { id: string; label: string }[];
    edges: { from: string; to: string; kind: string; branch?: string }[];
  } | null;
  findings: { path: string; message: string }[];
  steps: {
    id: string;
    skills: { name: string; installed: boolean; disabled: boolean }[];
    model: { choice: string; provider: string; model: string; state: string; reason: string | null } | null;
  }[];
  dir: string;
}

/**
 * The tabs of the playbook pane (card 525): today's view, one per kind of
 * contents, the plugin import (card 526), the whole folder, and the
 * Spectrolyzr page.
 */
export type PaneTab =
  "playbook" | "skills" | "agents" | "hooks" | "commands" | "workflows" | "plugin" | "files" | "lyzr";

/** The tab the pane shows and the folder picked in it; null shows the folder pinned to the workspace. */
export interface PaneView {
  tab: PaneTab;
  picked: string | null;
}

const NO_FOLDERS: PlaybookFoldersState = { folders: [], active: null };
const FIRST_VIEW: PaneView = { tab: "playbook", picked: null };

let foldersState: PlaybookFoldersState = NO_FOLDERS;
let loadedState: LoadedPlaybook | null = null;
let paneState: PaneView = FIRST_VIEW;
const folderListeners = new Set<() => void>();
const paneListeners = new Set<() => void>();
const loadedListeners = new Set<() => void>();

function setFolders(next: PlaybookFoldersState): void {
  foldersState = next;
  for (const l of folderListeners) l();
}

function setLoaded(next: LoadedPlaybook | null): void {
  loadedState = next;
  for (const l of loadedListeners) l();
}

function subscribeFolders(cb: () => void): () => void {
  folderListeners.add(cb);
  return () => void folderListeners.delete(cb);
}

function subscribeLoaded(cb: () => void): () => void {
  loadedListeners.add(cb);
  return () => void loadedListeners.delete(cb);
}

function setPane(next: PaneView): void {
  paneState = next;
  for (const l of paneListeners) l();
}

function subscribePane(cb: () => void): () => void {
  paneListeners.add(cb);
  return () => void paneListeners.delete(cb);
}

/** The tab and the folder the playbook pane shows (card 525). */
export function usePaneView(): PaneView {
  return useSyncExternalStore(
    subscribePane,
    () => paneState,
    () => paneState,
  );
}

/** The pane's tab and folder right now, for code outside a component. */
export function paneView(): PaneView {
  return paneState;
}

/**
 * Show a tab of the pane. The pane disables its tabs while a draft or a file
 * has unsaved changes, so this does not check.
 *
 * @param tab the tab
 */
export function showTab(tab: PaneTab): void {
  if (paneState.tab !== tab) setPane({ ...paneState, tab });
}

/**
 * Show a folder in the pane, on the tab it has.
 *
 * @param dir the registered folder
 */
export function pickFolder(dir: string): void {
  if (paneState.picked !== dir) setPane({ ...paneState, picked: dir });
}

/**
 * Show a folder on a tab: after a new playbook (the Skills tab) and after an
 * imported ZIP (the Playbook tab).
 *
 * @param dir the registered folder
 * @param tab the tab
 */
export function showFolder(dir: string, tab: PaneTab): void {
  setPane({ tab, picked: dir });
}

/** The known playbook folders and the one pinned to the current workspace. */
export function usePlaybookFolders(): PlaybookFoldersState {
  return useSyncExternalStore(
    subscribeFolders,
    () => foldersState,
    () => foldersState,
  );
}

/** The playbook last loaded, or null when none is. */
export function useLoadedPlaybook(): LoadedPlaybook | null {
  return useSyncExternalStore(
    subscribeLoaded,
    () => loadedState,
    () => loadedState,
  );
}

/** The server's own words for a refusal, else the status. */
async function refusal(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => ({}));
  const message = (body as { message?: unknown }).message;
  return new Error(typeof message === "string" && message !== "" ? message : `HTTP ${res.status}`);
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function foldersOf(body: unknown): PlaybookFoldersState {
  const b = body as { folders?: unknown; active?: unknown };
  return {
    folders: Array.isArray(b.folders) ? b.folders.filter((f): f is string => typeof f === "string") : [],
    active: typeof b.active === "string" ? b.active : null,
  };
}

/**
 * Read the known folders and the pin for a workspace.
 *
 * @param workspace the workspace path the pin is looked up for
 */
export async function refreshFolders(workspace: string): Promise<void> {
  const res = await fetch(`/api/playbooks?workspace=${encodeURIComponent(workspace)}`);
  if (!res.ok) throw await refusal(res);
  setFolders(foldersOf(await res.json()));
}

/**
 * Register a folder that holds a playbook.json. The route answers the pin only
 * for a workspace it was given, and this call gives none, so the pin the store
 * already has stays.
 *
 * @param dir absolute path of the folder
 */
export async function registerFolder(dir: string): Promise<void> {
  const res = await fetch("/api/playbooks/folders", jsonInit("POST", { dir }));
  if (!res.ok) throw await refusal(res);
  setFolders({ folders: foldersOf(await res.json()).folders, active: foldersState.active });
}

/**
 * Pin a registered folder to a workspace.
 *
 * @param workspace the workspace path
 * @param dir the registered folder to pin
 */
export async function pinFolder(workspace: string, dir: string): Promise<void> {
  const res = await fetch("/api/playbooks/active", jsonInit("PUT", { workspace, dir }));
  if (!res.ok) throw await refusal(res);
  setFolders(foldersOf(await res.json()));
}

/**
 * Load a registered folder: the playbook, its drawing, the findings and the
 * resolution per step. A refused load clears the loaded playbook.
 *
 * @param dir the registered folder
 * @param workspace the workspace the skills and providers resolve against
 */
export async function loadPlaybook(dir: string, workspace: string): Promise<void> {
  const res = await fetch(
    `/api/playbooks/load?dir=${encodeURIComponent(dir)}&workspace=${encodeURIComponent(workspace)}`,
  );
  if (!res.ok) {
    setLoaded(null);
    throw await refusal(res);
  }
  setLoaded((await res.json()) as LoadedPlaybook);
}

/**
 * Copy a shipped playbook into a folder. The server refuses to overwrite and
 * answers 409 with the paths, which this returns instead of throwing, because
 * the picker shows them as a normal outcome. Any other refusal is `ok: false`
 * without paths. On success the folder joins the known list, since the server
 * registered it.
 *
 * @param id the bundled playbook id
 * @param dir the target folder
 */
export async function copyBundled(id: string, dir: string): Promise<{ ok: boolean; conflicts?: string[] }> {
  let res: Response;
  try {
    res = await fetch(`/api/playbooks/bundled/${encodeURIComponent(id)}/copy`, jsonInit("POST", { dir }));
  } catch {
    return { ok: false };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { dir?: unknown };
    noteFolder(typeof body.dir === "string" ? body.dir : dir);
    return { ok: true };
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { conflicts?: unknown };
    const conflicts = Array.isArray(body.conflicts)
      ? body.conflicts.filter((c): c is string => typeof c === "string")
      : [];
    return { ok: false, conflicts };
  }
  return { ok: false };
}

/**
 * Add a folder the server registered to the known list, once, and keep the
 * pin: the copy route registers what it writes and pins nothing (Spectrolyzr's
 * new playbook of card 515 relies on that too).
 *
 * @param dir the folder as the server answered it
 */
export function noteFolder(dir: string): void {
  if (!foldersState.folders.includes(dir)) {
    setFolders({ folders: [...foldersState.folders, dir], active: foldersState.active });
  }
}

/**
 * The server's topology as the layout engine's input. The branch name is the
 * server's, not the layout's; an edge kind other than conditional is direct.
 * A refused file has no topology and lays out as an empty graph.
 *
 * @param loaded a loaded playbook
 */
export function toWebTopology(loaded: LoadedPlaybook): Topology {
  const t = loaded.topology;
  if (t === null) return { entry: null, nodes: [], edges: [] };
  return {
    entry: t.entry,
    nodes: t.nodes.map((n) => ({ id: n.id, label: n.label })),
    edges: t.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind === "conditional" ? "conditional" : "direct",
    })),
  };
}

/** Test seam: forget the folders, the loaded playbook and the pane's tab and folder. */
export function __resetPlaybooks(): void {
  foldersState = NO_FOLDERS;
  loadedState = null;
  paneState = FIRST_VIEW;
  for (const l of folderListeners) l();
  for (const l of loadedListeners) l();
  for (const l of paneListeners) l();
}
