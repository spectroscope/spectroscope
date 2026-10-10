// Card 483: undo and redo from the keyboard. A text field keeps its own undo,
// so the editor reads the keys only when the focus is elsewhere.

export type EditorKey = "undo" | "redo" | null;

const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * What a key press asks of the editor.
 *
 * @param e the key and its modifiers
 * @param target the focused element, or null when nothing has the focus
 * @return undo, redo, or null for a key the editor leaves alone
 */
export function editorKeyIntent(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  target: { tagName: string; isContentEditable: boolean } | null,
): EditorKey {
  if (target !== null && (FIELDS.has(target.tagName.toUpperCase()) || target.isContentEditable)) return null;
  if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}
