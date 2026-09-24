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
  /** Which root carries it (card 410): only a user-root copy may be taken out
   *  from the shelf. Absent from a server older than the field. */
  root?: "user" | "project" | null;
}

/** Why an install ended badly, in the shape the panel needs to say it. */
export interface InstallRefusal {
  id: string;
  /** The server's own sentence, or the status when it sent none. */
  reason: string;
  /** 409 gets a translated line of its own; everything else prints the reason. */
  status: number;
  /** For a set's refused id: the root that already carries it, when the server said. */
  root?: "user" | "project";
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
  if (running()) {
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

// ---- card 410: a pack as one set ------------------------------------------------------

export type SetAction = "install" | "remove";

/** A refused set: which pack, which button, and every id the server named. */
export interface PackRefusal {
  pack: string;
  action: SetAction;
  status: number;
  refused: InstallRefusal[];
  /** Ids the server could not take back after the failure: still installed
   *  after a set install, out of the root after a set remove. Absent when
   *  nothing stayed behind. */
  leftover?: string[];
  /** For a set remove with a leftover: the folder those skills wait in. */
  holding?: string;
}

export interface PackState {
  /** The pack whose install or remove button is running, or null. */
  pending: { pack: string; action: SetAction } | null;
  /** The last refused set, cleared when the next set starts. */
  refused: PackRefusal | null;
}

const PACKS_IDLE: PackState = { pending: null, refused: null };

let packs: PackState = PACKS_IDLE;

function setPacks(next: PackState): void {
  packs = next;
  listeners.forEach((notify) => notify());
}

/** The shelf's read side for the set buttons. */
export function usePackState(): PackState {
  return useSyncExternalStore(
    subscribe,
    () => packs,
    () => packs,
  );
}

export function resetPackState(): void {
  setPacks(PACKS_IDLE);
}

export function packState(): PackState {
  return packs;
}

/**
 * Install every row of a set in ONE request (card 410: the pack's install
 * button). The server checks every id before it writes and takes back what it
 * copied when a later copy fails. A refusal keeps the id and reason of each
 * refused skill for the shelf to print, and does not reload, for the same
 * reason a single refusal does not. The exception is a failure whose
 * take-back left copies behind: the server names them under `leftover`, the
 * refusal keeps them, and the list is read again because the disk changed.
 *
 * @param pack   the pack the button belongs to, for the refusal line
 * @param rows   the rows to install, usually the pack's missing ones
 * @param reload re-read the list; called on success, and after a failure the
 *               server could not take back
 * @returns whether the set was installed
 */
export function installSet(
  pack: string,
  rows: readonly CatalogueRow[],
  reload: () => void,
): Promise<boolean> {
  return runSet("install", pack, rows, reload);
}

/**
 * Remove every row of a set in ONE request (card 410: the pack's remove
 * button), all or nothing on the server as well.
 *
 * @param pack   the pack the button belongs to
 * @param rows   the rows to remove: user-root copies
 * @param reload re-read the list; called on success, and after a failure the
 *               server could not put back
 * @returns whether the set was removed
 */
export function removeSet(pack: string, rows: readonly CatalogueRow[], reload: () => void): Promise<boolean> {
  return runSet("remove", pack, rows, reload);
}

async function runSet(
  action: SetAction,
  pack: string,
  rows: readonly CatalogueRow[],
  reload: () => void,
): Promise<boolean> {
  if (rows.length === 0 || running()) {
    return false;
  }
  setPacks({ pending: { pack, action }, refused: null });
  const refuse = (status: number, refused: InstallRefusal[], extra: Partial<PackRefusal> = {}): false => {
    setPacks({ pending: null, refused: { pack, action, status, refused, ...extra } });
    return false;
  };
  try {
    const response = await fetch(
      action === "install" ? "/api/skills/install-set" : "/api/skills/remove-set",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills: rows.map((row) => row.id) }),
      },
    );
    if (response.ok) {
      setPacks(PACKS_IDLE);
      reload();
      return true;
    }
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      refused?: unknown;
      leftover?: unknown;
      holding?: unknown;
    };
    const named = Array.isArray(body.refused) ? body.refused.map(refusalOf) : [];
    const leftover = Array.isArray(body.leftover) ? body.leftover.map(String) : [];
    const extra: Partial<PackRefusal> = {};
    if (leftover.length > 0) extra.leftover = leftover;
    if (leftover.length > 0 && typeof body.holding === "string") extra.holding = body.holding;
    refuse(
      response.status,
      named.length > 0
        ? named
        : [{ id: pack, reason: body.message ?? String(response.status), status: response.status }],
      extra,
    );
    // A leftover means the disk did change, so the list is read again; with
    // none, nothing changed and the list stays as it is.
    if (leftover.length > 0) reload();
    return false;
  } catch (unreachable: unknown) {
    return refuse(0, [
      {
        id: pack,
        reason: unreachable instanceof Error ? unreachable.message : String(unreachable),
        status: 0,
      },
    ]);
  }
}

/** One entry of the server's `refused` list, in the shape the shelf prints. */
function refusalOf(entry: unknown): InstallRefusal {
  const e = (typeof entry === "object" && entry !== null ? entry : {}) as {
    skill?: unknown;
    status?: unknown;
    message?: unknown;
    root?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : 0;
  const refusal: InstallRefusal = {
    id: String(e.skill ?? ""),
    reason: typeof e.message === "string" ? e.message : String(status),
    status,
  };
  if (e.root === "user" || e.root === "project") refusal.root = e.root;
  return refusal;
}

// ---- card 410: a row's off switch -------------------------------------------------------

/** The catalogue id a row's off switch is removing, or null. */
let removing: string | null = null;

function setRemoving(next: string | null): void {
  removing = next;
  listeners.forEach((notify) => notify());
}

/** The shelf's read side for a row's removal. */
export function useRowRemoval(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => removing,
    () => removing,
  );
}

export function rowRemoval(): string | null {
  return removing;
}

export function resetRowRemoval(): void {
  setRemoving(null);
}

/** Whether a copy, a set or a row's removal is running: each of them waits for the others. */
function running(): boolean {
  return state.pending !== null || packs.pending !== null || removing !== null;
}

/**
 * Remove one catalogue skill through the single DELETE (card 410: a row's off
 * switch). It keeps the one-at-a-time line the copies keep: while it runs no
 * install, set or other removal starts, so a set cannot list a skill this call
 * is deleting. The answer is not read; the reload shows what the disk holds,
 * the way the installed list's delete does.
 *
 * @param row    the installed catalogue row whose switch was turned off
 * @param reload re-read the list; called once the DELETE has answered or failed
 * @returns false when something else was running and nothing was sent
 */
export async function removeSkill(row: CatalogueRow, reload: () => void): Promise<boolean> {
  if (running()) {
    return false;
  }
  setRemoving(row.id);
  try {
    await fetch(skillPath(row.pack, row.name), { method: "DELETE" });
  } catch {
    // unreachable: the reload below says what is on disk
  }
  setRemoving(null);
  reload();
  return true;
}
