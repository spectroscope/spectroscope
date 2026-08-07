// The install half of the settings skill manager (card 182), as a store rather
// than component state. Two reasons, and neither is taste:
//
// The rules worth pinning here are rules, not markup — one install at a time,
// a refusal is SAID rather than swallowed, and a refusal does not reload the
// list (a reload after a failed copy would redraw the row as if something had
// happened). Out here they are pinned in node like the rest of this tree.
//
// And it is the house pattern: state/stepper.ts, state/imageViewer.ts,
// state/sendQueue.ts. A React context would have wrapped App's whole render to
// share four fields (card 179 measured that at 1,241 re-indented JSX lines).

import { useSyncExternalStore } from "react";

/** A shelf row: one skill the artifact carries, not one it has installed. */
export interface CatalogueRow {
  id: string;
  /** The leaf folder — also the destination folder inside the pack. */
  name: string;
  /** The pack it belongs to; the agent calls the skill `<pack>:<name>`. */
  pack: string;
  description: string;
  licence: string;
  repo: string;
  commit: string;
  files: number;
  bytes: number;
  installed: boolean;
}

/** Why an install ended badly, in the shape the panel needs to say it. */
export interface InstallRefusal {
  id: string;
  /** The server's own sentence, or the status when it sent none. */
  reason: string;
  /** 409 gets a translated line of its own; everything else prints the reason. */
  status: number;
}

export interface InstallState {
  /** The catalogue id being copied right now, or null. */
  pending: string | null;
  /** The last refusal, cleared when the next install starts. */
  refused: InstallRefusal | null;
}

const IDLE: InstallState = { pending: null, refused: null };

let state: InstallState = IDLE;
const listeners = new Set<() => void>();

function set(next: InstallState): void {
  state = next;
  listeners.forEach((notify) => notify());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The panel's read side. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Fresh state — every test starts from it, and so does a remounted panel. */
export function resetInstallState(): void {
  set(IDLE);
}

export function installState(): InstallState {
  return state;
}

/**
 * The one call in this panel that may not fail quietly. The toggle and the
 * delete answer a failure with `.catch(load)`, which is honest enough because
 * the reload tells the truth anyway; a refused install has a REASON — the name
 * is taken, the licence would not read, the copy is over the ceiling — and
 * without it the press reads as a copy that silently did nothing.
 *
 * @param row     the catalogue row whose button was pressed
 * @param reload  re-read the list; called on success only
 * @returns whether the skill was installed
 */
export async function installSkill(row: CatalogueRow, reload: () => void): Promise<boolean> {
  if (state.pending !== null) {
    // One at a time. Two copies into the same skills root would race on the
    // staging directory, and the second would answer 409 for a reason that has
    // nothing to do with what the user pressed.
    return false;
  }
  set({ pending: row.id, refused: null });
  try {
    const response = await fetch("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: row.id }),
    });
    if (response.ok) {
      set(IDLE);
      reload();
      return true;
    }
    const body: unknown = await response.json().catch(() => ({}));
    const message = (body as { message?: string }).message;
    set({
      pending: null,
      refused: {
        id: row.id,
        reason: message ?? String(response.status),
        status: response.status,
      },
    });
    // Deliberately no reload: nothing changed on disk, and redrawing the list
    // after a refusal is how a failure comes to look like a success.
    return false;
  } catch (unreachable: unknown) {
    set({
      pending: null,
      refused: {
        id: row.id,
        reason: unreachable instanceof Error ? unreachable.message : String(unreachable),
        status: 0,
      },
    });
    return false;
  }
}

/**
 * The REST path of an installed skill. A packed skill lives one directory
 * deeper and is displayed as `<pack>:<skill>` — a colon is not a path
 * separator, so the pack travels as its own segment rather than as part of an
 * encoded name.
 *
 * @param pack   the pack folder, null for a top-level skill
 * @param folder the skill's own folder
 * @returns the path under /api/skills, each segment encoded
 */
export function skillPath(pack: string | null, folder: string): string {
  const segments = pack === null ? [folder] : [pack, folder];
  return `/api/skills/${segments.map(encodeURIComponent).join("/")}`;
}
