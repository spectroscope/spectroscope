// The web store of a playbook's contents (card 485, spec P6).
//
// One module store read with useSyncExternalStore, the idiom of the other
// state files: the list of what a playbook folder brings (skills, commands,
// hooks, agents, workflows), as the server's contents route answers it. The
// server owns every fact in it; this file mirrors the answer and carries the
// two writes, install and remove.
//
// An install or remove that the server refuses does not throw: the refusal is
// a normal outcome the confirmation dialog shows, so it comes back as a value.
// The one refusal that also moves the store is CHANGED, which means the folder
// changed since the list was shown: the list is read again for the same folder.

import { useSyncExternalStore } from "react";

export type ContentKind = "skill" | "command" | "hook" | "agent" | "workflow";
export type ContentState = "new" | "same" | "source-changed" | "copy-changed" | "taken" | "not-run";

export interface ContentItem {
  kind: ContentKind;
  name: string;
  source: string;
  sha256: string;
  state: ContentState;
  scope: "sessions" | "tool-calls" | "runs" | "none";
  bytes: number;
  /** Where the install would put it; null for agents and workflows. */
  target: string | null;
  /** The resolved command, for hooks only. */
  command: string | null;
  /** The full text of every hook file, for hooks only. */
  files: { path: string; text: string }[];
}

export interface ContentsPreview {
  playbook: string;
  dir: string;
  contentsHash: string;
  items: ContentItem[];
  promptChars: number;
  /** The settings layer whose hooks block is in force, null when none is. */
  hooksOrigin: string | null;
  findings: { path: string; message: string }[];
}

export type InstallFailure = {
  ok: false;
  status: number;
  reason: string;
  message: string;
  names: string[];
  leftover: string[];
};
export type InstallAnswer = { ok: true; installed: string[] } | InstallFailure;
export type RemoveAnswer = { ok: true; removed: string[]; kept: string[] } | InstallFailure;

let previewState: ContentsPreview | null = null;
/** The workspace the list was last read for, so a reload after CHANGED asks the same question. */
let lastWorkspace: string | null = null;
const listeners = new Set<() => void>();

function setPreview(next: ContentsPreview | null): void {
  previewState = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The contents last loaded, or null when none is. */
export function usePlaybookContents(): ContentsPreview | null {
  return useSyncExternalStore(
    subscribe,
    () => previewState,
    () => previewState,
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function postInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** A refused write as a value: the server's reason and words, else the status. */
async function failure(res: Response): Promise<InstallFailure> {
  const body = ((await res.json().catch(() => ({}))) as Record<string, unknown> | null) ?? {};
  const message =
    typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${res.status}`;
  return {
    ok: false,
    status: res.status,
    reason: typeof body.reason === "string" ? body.reason : "",
    message,
    names: strings(body.names),
    leftover: strings(body.leftover),
  };
}

function unreachable(error: unknown): InstallFailure {
  return {
    ok: false,
    status: 0,
    reason: "NETWORK",
    message: error instanceof Error ? error.message : "The request did not arrive.",
    names: [],
    leftover: [],
  };
}

/**
 * Read what a registered folder brings. A refused read clears the list and
 * throws the server's words, so a list from the folder before never stands
 * under the error of the folder now.
 *
 * @param dir the registered playbook folder
 * @param workspace the workspace whose settings layers decide the hooks origin, or null
 */
export async function loadContents(dir: string, workspace: string | null): Promise<void> {
  lastWorkspace = workspace;
  const query = `dir=${encodeURIComponent(dir)}${workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`}`;
  const res = await fetch(`/api/playbooks/contents?${query}`);
  if (!res.ok) {
    setPreview(null);
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(
      typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${res.status}`,
    );
  }
  setPreview((await res.json()) as ContentsPreview);
}

/**
 * Install what the list showed. The hash binds the click to that list.
 * A 409 with the reason CHANGED reads the list again for the same folder;
 * no other refusal does.
 *
 * @param dir the registered playbook folder
 * @param contentsHash the contents hash of the list the owner saw
 * @param hooks whether the owner ticked the hooks
 */
export async function installContents(
  dir: string,
  contentsHash: string,
  hooks: boolean,
): Promise<InstallAnswer> {
  let res: Response;
  try {
    res = await fetch("/api/playbooks/contents/install", postInit({ dir, contentsHash, hooks }));
  } catch (error) {
    return unreachable(error);
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { installed?: unknown };
    return { ok: true, installed: strings(body.installed) };
  }
  const refused = await failure(res);
  if (refused.status === 409 && refused.reason === "CHANGED") {
    await loadContents(dir, lastWorkspace).catch(() => undefined);
  }
  return refused;
}

/**
 * Remove what the install ledger records for the folder's playbook. Copies
 * edited after the install are kept and named.
 *
 * @param dir the registered playbook folder
 */
export async function removeContents(dir: string): Promise<RemoveAnswer> {
  let res: Response;
  try {
    res = await fetch("/api/playbooks/contents/remove", postInit({ dir }));
  } catch (error) {
    return unreachable(error);
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { removed?: unknown; kept?: unknown };
    return { ok: true, removed: strings(body.removed), kept: strings(body.kept) };
  }
  return failure(res);
}

/** The items whose source or installed copy differs from the install: source-changed or copy-changed. */
export function changedItems(preview: ContentsPreview): ContentItem[] {
  return preview.items.filter((i) => i.state === "source-changed" || i.state === "copy-changed");
}

/** Test seam: forget the loaded contents and the workspace. */
export function __resetPlaybookContents(): void {
  previewState = null;
  lastWorkspace = null;
  for (const l of listeners) l();
}
