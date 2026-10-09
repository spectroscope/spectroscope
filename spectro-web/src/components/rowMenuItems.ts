// Card 445: the menu at the right end of a stored session row, as data.
//
// The owner, 2026-09-25, with a picture of Claude's row menu: delete, rename
// and pin behind a three-dots button on every session. The items, their order
// and the keyboard rules live here, pure, so they are tested without a DOM;
// SessionRowMenu.tsx draws them.

import type { SessionMeta } from "../events";
import type { Lang } from "../i18n/i18n";
import { sessionDisplayTitle } from "./sessionRows";

/** What a row menu can do. */
export type RowMenuItemId = "pin" | "unpin" | "rename" | "suggest" | "bundle" | "delete";

/** One item as the menu draws it. */
export interface RowMenuEntry {
  id: RowMenuItemId;
  /** The i18n key of the item's word. */
  labelKey: string;
  /** Drawn in the danger colour. */
  danger: boolean;
  /** Shown but not usable. */
  disabled: boolean;
  /** The i18n key of the reason, shown as the item's hover, for a disabled item. */
  hintKey?: string;
}

/**
 * The items of one row's menu, in the order Claude's menu uses: pin, rename,
 * then delete last and apart.
 *
 * @param row.pinned    whether the session is pinned (pin becomes unpin)
 * @param row.hasTitle  whether the row has a title; only a row without one is
 *                      offered a suggestion (the old sessions, and a new one
 *                      whose suggestion did not come)
 * @param row.deletable false while a socket holds the session: deleting a file
 *                      a run is still appending to would leave the run writing
 *                      into a recreated one
 */
export function rowMenuItems(row: {
  pinned: boolean;
  hasTitle: boolean;
  deletable: boolean;
}): RowMenuEntry[] {
  const items: RowMenuEntry[] = [
    row.pinned
      ? { id: "unpin", labelKey: "sess.menu.unpin", danger: false, disabled: false }
      : { id: "pin", labelKey: "sess.menu.pin", danger: false, disabled: false },
    { id: "rename", labelKey: "sess.menu.rename", danger: false, disabled: false },
  ];
  if (!row.hasTitle)
    items.push({ id: "suggest", labelKey: "sess.menu.suggest", danger: false, disabled: false });
  // Card 473: the session with its wires and child sessions as one zip. It
  // only reads, so a session a socket holds can still be downloaded.
  items.push({ id: "bundle", labelKey: "sess.menu.bundle", danger: false, disabled: false });
  items.push(
    row.deletable
      ? { id: "delete", labelKey: "sess.menu.delete", danger: true, disabled: false }
      : {
          id: "delete",
          labelKey: "sess.menu.delete",
          danger: true,
          disabled: true,
          hintKey: "sess.menu.deleteLive",
        },
  );
  return items;
}

/**
 * What a key does in the open menu.
 *
 * @param key   the KeyboardEvent key
 * @param index the item with focus
 * @param count how many items there are
 * @return the item to focus next; "close" to close and give focus back to the
 *         three-dots button (Escape); "leave" to close and let focus move on
 *         (Tab); null for a key the focused item handles itself (Enter, Space)
 */
export function menuKeyStep(key: string, index: number, count: number): number | "close" | "leave" | null {
  switch (key) {
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "Escape":
      return "close";
    case "Tab":
      return "leave";
    default:
      return null;
  }
}

/**
 * What a key does in the rename field. Blur saves too; that is the field's
 * own event, not a key.
 */
export function renameIntent(key: string): "save" | "cancel" | null {
  if (key === "Enter") return "save";
  if (key === "Escape") return "cancel";
  return null;
}

/** What a rename field opened with. The list keeps it until the field closes. */
export interface RenameOpening {
  /** The session being renamed. */
  id: string;
  /** The text the row showed, which the field starts with. */
  shown: string;
  /** Whether that text was a title rather than the first prompt. */
  hasTitle: boolean;
}

/**
 * The note the list takes when Rename is picked. The field is compared with
 * this note when it closes, not with the row as it is then: a suggested title
 * can land on the row while the field is open, and a field the operator left
 * untouched still sends nothing.
 *
 * @param row  the row as it is when Rename is picked
 * @param lang the rail's language (an empty session's placeholder)
 */
export function renameOpening(row: SessionMeta, lang: Lang): RenameOpening {
  return { id: row.id, shown: sessionDisplayTitle(row, lang), hasTitle: (row.title ?? "").trim() !== "" };
}

/**
 * The title to send when the rename field closes, or null to send nothing.
 *
 * @param field.typed    what the field holds
 * @param field.shown    what the row showed when the field opened
 * @param field.hasTitle whether the row had a title (as opposed to showing its
 *                       first prompt)
 * @return the trimmed new title; "" to drop the title so the row falls back to
 *         the suggestion or the first prompt; null when nothing changed
 */
export function renameRequest(field: { typed: string; shown: string; hasTitle: boolean }): string | null {
  const typed = field.typed.trim();
  if (typed === "") return field.hasTitle ? "" : null;
  if (typed === field.shown.trim()) return null;
  return typed;
}

/**
 * Card 473: the bundle download of one stored session, for the row menu and
 * the archive bar alike.
 *
 * @param id the stored session's id
 * @return the endpoint and the file name the browser saves it as
 */
export function bundleLink(id: string): { href: string; download: string } {
  return { href: `/api/sessions/${encodeURIComponent(id)}/bundle`, download: `${id}.spectro.zip` };
}
