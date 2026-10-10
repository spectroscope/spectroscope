// Card 512: the native folder chooser for the path fields of the Playbook
// segment. One request for the pane's path field and the wizard's two folder
// fields: POST /api/pick-workspace, the endpoint the folder chip in the header
// uses (WorkspacePickController). It answers 200 with the path, 204 on a
// cancel, 409 while another dialog is open and 501 where the platform has no
// dialog. A pick only fills the field; a note per field says what went wrong,
// and it lives here so a static render can read it.

import { useSyncExternalStore } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "./lang";

/** The fields that carry a Choose button, each with a note of its own. */
export type PickSlot = "pane" | "lyzrDir" | "lyzrPlaybook";

/** The i18n key of a slot's note, or null for none. */
type NoteKey = "pick.busy" | "pick.paste" | null;

let notes: Record<PickSlot, NoteKey> = { pane: null, lyzrDir: null, lyzrPlaybook: null };
const listeners = new Set<() => void>();

function setNote(slot: PickSlot, key: NoteKey): void {
  if (notes[slot] === key) return;
  notes = { ...notes, [slot]: key };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * Open the native folder dialog and hand a picked path to the field.
 *
 * @param slot  the field whose note this pick sets
 * @param apply puts the picked path into the field; not called on a cancel or a failure
 */
export async function chooseFolder(slot: PickSlot, apply: (path: string) => void): Promise<void> {
  setNote(slot, null);
  try {
    const res = await fetch("/api/pick-workspace", { method: "POST" });
    if (res.status === 200) {
      const { path } = (await res.json()) as { path?: unknown };
      if (typeof path === "string" && path !== "") apply(path);
      else setNote(slot, "pick.paste");
    } else if (res.status === 409) {
      setNote(slot, "pick.busy");
    } else if (res.status !== 204) {
      setNote(slot, "pick.paste");
    }
  } catch {
    setNote(slot, "pick.paste");
  }
}

/** The note of a slot in the current language, or null. */
export function usePickNote(slot: PickSlot): string | null {
  const lang = useLang();
  const key = useSyncExternalStore(
    subscribe,
    () => notes[slot],
    () => notes[slot],
  );
  return key === null ? null : t(lang, key);
}

/** Test seam: clear every note. */
export function __resetFolderPick(): void {
  notes = { pane: null, lyzrDir: null, lyzrPlaybook: null };
  for (const l of listeners) l();
}
