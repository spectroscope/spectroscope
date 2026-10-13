// The web store of a playbook's contents (card 485, spec P6).
//
// One module store read with useSyncExternalStore, the idiom of the other
// state files: the list of what a playbook folder brings (skills, commands,
// hooks, agents, workflows), as the server's contents route answers it. The
// server owns every fact in it; this file mirrors the answer and writes
// nothing. The server has no install or remove route (owner, 2026-10-13).

import { useSyncExternalStore } from "react";

export type ContentKind = "skill" | "command" | "hook" | "agent" | "workflow";
/** A skill, command, hook or agent is in the playbook; a workflow runs or is not run. */
export type ContentState = "in-playbook" | "not-run" | "runnable";

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

let previewState: ContentsPreview | null = null;
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

/**
 * Read what a registered folder brings. A refused read clears the list and
 * throws the server's words, so a list from the folder before never stands
 * under the error of the folder now.
 *
 * @param dir the registered playbook folder
 * @param workspace the workspace whose settings layers decide the hooks origin, or null
 * @returns the list as the server answered it, which the store now holds
 */
export async function loadContents(dir: string, workspace: string | null): Promise<ContentsPreview> {
  const query = `dir=${encodeURIComponent(dir)}${workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`}`;
  const res = await fetch(`/api/playbooks/contents?${query}`);
  if (!res.ok) {
    setPreview(null);
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(
      typeof body.message === "string" && body.message !== "" ? body.message : `HTTP ${res.status}`,
    );
  }
  const read = (await res.json()) as ContentsPreview;
  setPreview(read);
  return read;
}

/** Test seam: forget the loaded contents. */
export function __resetPlaybookContents(): void {
  previewState = null;
  for (const l of listeners) l();
}
