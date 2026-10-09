// Card 483: the playbook editor's store. The draft document is the only state
// and lives above the pane, so a segment switch keeps it (a reload loses an
// unsaved draft). React Flow and the panels only report intents; each one is
// a command, `apply` makes the next document, the history keeps the last 50.
//
// After every change the draft goes to the server's validator, debounced, and
// the newest answer wins by sequence number. The server is the authority on
// findings; the save route validates again. One idiom, the same as the other
// stores: module state, an immutable snapshot, `useSyncExternalStore`.

import { useSyncExternalStore } from "react";
import { apply, type Command } from "../playbook/editor/commands";
import { outcomesOf, type PlaybookDoc, type Selection, arrowKey } from "../playbook/editor/doc";
import { canRedo, canUndo, push, redo, startHistory, undo, type History } from "../playbook/editor/history";
import type { LoadedPlaybook } from "./playbooks";

export interface EditorViewWire {
  loaded: LoadedPlaybook;
  document: PlaybookDoc | null;
  diskHash: string;
  canonical: boolean;
  editable: boolean;
  outcomes: Record<string, string[]>;
  choices: { choice: string; provider: string; model: string; state: string; reason: string | null }[];
}

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "refused"; findings: { path: string; message: string }[] }
  | { kind: "changed"; diskHash: string }
  | { kind: "failed"; message: string };

export interface EditorState {
  open: boolean;
  dir: string | null;
  workspace: string | null;
  history: History<PlaybookDoc> | null;
  saved: PlaybookDoc | null;
  baseHash: string | null;
  view: EditorViewWire | null;
  /** The newest check sequence that was answered and the newest that was sent; checking while sent is ahead. */
  viewSeq: number;
  sentSeq: number;
  selection: Selection;
  save: SaveState;
  dirty: boolean;
  canonical: boolean;
  /** The reason key of the last refused command (`pbe.renameTaken`, ...), null after the next accepted one. */
  refused: string | null;
}

export const CHECK_DEBOUNCE_MS = 150;

const INITIAL: EditorState = {
  open: false,
  dir: null,
  workspace: null,
  history: null,
  saved: null,
  baseHash: null,
  view: null,
  viewSeq: 0,
  sentSeq: 0,
  selection: null,
  save: { kind: "idle" },
  dirty: false,
  canonical: true,
  refused: null,
};

let state: EditorState = INITIAL;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every open, close, reset and view load, so an answer for a draft that is gone is dropped. */
let epoch = 0;
/** Bumped by every view load before its fetch, so the newest load wins when several overlap. */
let loadSeq = 0;

interface Seams {
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}
let seams: Seams = {};

function doFetch(url: string, init?: RequestInit): Promise<Response> {
  return (seams.fetch ?? globalThis.fetch)(url, init);
}

function startTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return (seams.setTimeout ?? globalThis.setTimeout)(fn, ms);
}

function stopTimer(t: ReturnType<typeof setTimeout>): void {
  (seams.clearTimeout ?? globalThis.clearTimeout)(t);
}

function cancelCheck(): void {
  if (timer !== null) stopTimer(timer);
  timer = null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function set(patch: Partial<EditorState>): void {
  const next = { ...state, ...patch };
  const present = next.history?.present ?? null;
  next.dirty = present !== null && next.saved !== null && !deepEqual(present, next.saved);
  next.canonical = next.view ? next.view.canonical : true;
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** React hook: the editor state. */
export function useEditorState(): EditorState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** The editor state right now, for code outside a component. */
export function editorState(): EditorState {
  return state;
}

function query(dir: string, workspace: string | null): string {
  const ws = workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`;
  return `dir=${encodeURIComponent(dir)}${ws}`;
}

async function refusal(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => ({}));
  const message = (body as { message?: unknown }).message;
  return new Error(typeof message === "string" && message !== "" ? message : `HTTP ${res.status}`);
}

/** The server's outcome rules against the web twin, over the same draft. A difference is a drawing bug. */
function compareOutcomes(draft: PlaybookDoc | null, view: EditorViewWire): void {
  if (!draft) return;
  const seen = new Set<string>();
  const differ: string[] = [];
  for (const node of draft.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const server = view.outcomes[node.id];
    if (!server) continue;
    const web = outcomesOf(draft, node);
    if (server.length !== web.length || server.some((o, i) => o !== web[i])) differ.push(node.id);
  }
  if (differ.length > 0) console.error("playbook editor: outcome rules differ", differ);
}

function keepSelection(sel: Selection, doc: PlaybookDoc): Selection {
  if (sel === null) return null;
  if (sel.kind === "node") return doc.nodes.some((n) => n.id === sel.id) ? sel : null;
  return doc.arrows.some((a) => arrowKey(a) === sel.key) ? sel : null;
}

/**
 * Read the file on disk as an editor view into the store. `open` stays as it
 * is and no history is started. A draft with unsaved changes is never
 * replaced, and only the newest load of several overlapping ones is applied.
 * An open, clean editor whose reloaded view is not editable is closed.
 *
 * @param dir the registered playbook folder
 * @param workspace the workspace skills and providers resolve against
 */
export async function loadView(dir: string, workspace: string | null): Promise<void> {
  await load(dir, workspace);
}

/** The body of loadView. Answers whether this call's view went into the store. */
async function load(dir: string, workspace: string | null): Promise<boolean> {
  if (state.open && state.dirty) return false;
  const seq = ++loadSeq;
  const res = await doFetch(`/api/playbooks/draft?${query(dir, workspace)}`);
  if (!res.ok) throw await refusal(res);
  const view = (await res.json()) as EditorViewWire;
  if (seq !== loadSeq) return false;
  if (state.open && state.dirty) return false;
  cancelCheck();
  epoch++;
  compareOutcomes(view.document, view);
  const editable = view.editable && view.document !== null;
  set({
    dir,
    workspace,
    view,
    saved: view.document,
    baseHash: view.diskHash,
    viewSeq: 0,
    sentSeq: 0,
    save: { kind: "idle" },
    refused: null,
    ...(state.open
      ? editable
        ? { history: startHistory(view.document as PlaybookDoc) }
        : { open: false, history: null, selection: null }
      : {}),
  });
  return true;
}

/**
 * Open the editor on a folder's file. A view that is not editable leaves the
 * editor closed; the view says why.
 *
 * @param dir the registered playbook folder
 * @param workspace the workspace skills and providers resolve against
 */
export async function openEditor(dir: string, workspace: string | null): Promise<void> {
  if (!(await load(dir, workspace))) return;
  const view = state.view;
  if (!view || !view.editable || !view.document) return;
  set({ open: true, history: startHistory(view.document), selection: null });
}

/** Close the editor. Refused while the draft has unsaved changes. */
export function closeEditor(): void {
  if (state.dirty) return;
  cancelCheck();
  epoch++;
  set({ open: false, history: null, selection: null, save: { kind: "idle" }, refused: null });
}

function scheduleCheck(): void {
  cancelCheck();
  timer = startTimer(() => {
    timer = null;
    void sendCheck();
  }, CHECK_DEBOUNCE_MS);
}

async function sendCheck(): Promise<void> {
  const h = state.history;
  const dir = state.dir;
  if (!h || dir === null) return;
  const draft = h.present;
  const seq = state.sentSeq + 1;
  const mine = epoch;
  set({ sentSeq: seq });
  let view: EditorViewWire | null = null;
  try {
    const res = await doFetch(`/api/playbooks/draft?${query(dir, state.workspace)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (res.ok) view = (await res.json()) as EditorViewWire;
  } catch {
    view = null;
  }
  if (mine !== epoch || seq < state.viewSeq) return;
  if (view === null) {
    // The check did not answer: checking is over, the view stays what it was.
    set({ viewSeq: seq });
    return;
  }
  compareOutcomes(draft, view);
  set({ view, viewSeq: seq });
}

function change(next: History<PlaybookDoc>, selection: Selection): void {
  set({ history: next, selection, save: { kind: "idle" }, refused: null });
  scheduleCheck();
}

/**
 * Apply one command to the draft. A command with nothing to do records no
 * history entry; a refused one records the reason in `refused`.
 *
 * @param cmd the command
 */
export function dispatch(cmd: Command): void {
  const h = state.history;
  if (!h) return;
  const out = apply(h.present, state.selection, cmd);
  if (out.refused !== null) {
    set({ refused: out.refused });
    return;
  }
  if (out.doc === h.present) {
    set({ selection: out.selection, refused: null });
    return;
  }
  change(push(h, out.doc), out.selection);
}

/** Step back one command. */
export function undoEdit(): void {
  const h = state.history;
  if (!h || !canUndo(h)) return;
  const next = undo(h);
  change(next, keepSelection(state.selection, next.present));
}

/** Step forward one command. */
export function redoEdit(): void {
  const h = state.history;
  if (!h || !canRedo(h)) return;
  const next = redo(h);
  change(next, keepSelection(state.selection, next.present));
}

/**
 * Select a node or an arrow, or nothing.
 *
 * @param sel the selection
 */
export function select(sel: Selection): void {
  set({ selection: sel });
}

/**
 * Write the draft to disk through the save route. The history stays. The
 * server refuses with the findings (400) or because the file changed (409).
 */
export async function saveEdit(): Promise<void> {
  const h = state.history;
  const dir = state.dir;
  if (!h || dir === null || state.baseHash === null) return;
  if (state.save.kind === "saving") return;
  const draft = h.present;
  const mine = epoch;
  set({ save: { kind: "saving" } });
  try {
    const res = await doFetch(`/api/playbooks/file?${query(dir, state.workspace)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseHash: state.baseHash, playbook: draft }),
    });
    if (mine !== epoch) return;
    const body: unknown = await res.json().catch(() => ({}));
    if (res.ok) {
      const view = body as EditorViewWire;
      compareOutcomes(draft, view);
      const seq = state.sentSeq + 1;
      set({
        view,
        saved: draft,
        baseHash: view.diskHash,
        sentSeq: seq,
        viewSeq: seq,
        save: { kind: "idle" },
      });
      if (state.history && state.history.present !== draft) scheduleCheck();
      return;
    }
    if (res.status === 400 && Array.isArray((body as { findings?: unknown }).findings)) {
      set({
        save: {
          kind: "refused",
          findings: (body as { findings: { path: string; message: string }[] }).findings,
        },
      });
      return;
    }
    if (res.status === 409) {
      set({ save: { kind: "changed", diskHash: String((body as { diskHash?: unknown }).diskHash ?? "") } });
      return;
    }
    const message = (body as { message?: unknown }).message;
    set({
      save: {
        kind: "failed",
        message: typeof message === "string" && message !== "" ? message : `HTTP ${res.status}`,
      },
    });
  } catch (e) {
    if (mine !== epoch) return;
    set({ save: { kind: "failed", message: e instanceof Error ? e.message : String(e) } });
  }
}

/** Throw the draft away: back to the saved document, history cleared. */
export function revertEdit(): void {
  if (!state.saved || !state.history) return;
  cancelCheck();
  epoch++;
  set({
    history: startHistory(state.saved),
    selection: null,
    save: { kind: "idle" },
    refused: null,
    sentSeq: 0,
    viewSeq: 0,
  });
}

/** Test seams: replace fetch and the timers. */
export function __setEditorSeams(s: Seams): void {
  seams = { ...seams, ...s };
}

/** Test seam: forget everything, including the seams. */
export function __resetPlaybookEditor(): void {
  cancelCheck();
  epoch++;
  loadSeq++;
  seams = {};
  state = INITIAL;
  for (const l of listeners) l();
}
