// Card 604: the row labels of the files timeline. The label column is as wide
// as LABEL_CHARS characters of its monospace font (LABEL_CHARS_NARROW below
// 720 px, files.css), and a label is fitted to that many characters here, so
// the stylesheet never has to cut one. The full path is the row's title.
// `clip` cuts a text at its end, for the call lines and titles of the tab.
// `toolOf` and `lineOf` are what the tab prints for a call's tool and line.

import { t, type Lang } from "../i18n/i18n";
import type { FileCall } from "./fold";

/** Characters a row label may take in the wide layout; files.css sizes the column to match. */
export const LABEL_CHARS = 32;
/** Characters a row label may take at 720 px and below; files.css sizes the column to match. */
export const LABEL_CHARS_NARROW = 18;

/**
 * A label in at most `max` characters. The file name stays whole and the
 * folders before it give way from the front, whole folders only
 * ("…/session/SessionConnection.java"). A file name longer than `max` on its
 * own is cut in its middle and keeps its extension. A folder label keeps its
 * trailing slash.
 */
export function fitLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const slash = label.endsWith("/") ? "/" : "";
  const body = label.slice(0, label.length - slash.length);
  const cut = body.lastIndexOf("/");
  const name = body.slice(cut + 1) + slash;
  if (cut >= 0 && name.length + 2 <= max) {
    let kept = name;
    for (const dir of body.slice(0, cut).split("/").reverse()) {
      const next = `${dir}/${kept}`;
      if (next.length + 2 > max) break;
      kept = next;
    }
    return `…/${kept}`;
  }
  return name.length <= max ? name : middle(name, max);
}

/** A text in at most `max` characters: cut at its end, the last one an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A name cut in its middle to `max` characters, its extension (and a folder's slash) kept. */
function middle(name: string, max: number): string {
  const ext = /(\.[^./]{1,10})?\/?$/.exec(name)?.[0] ?? "";
  const room = max - 1 - ext.length;
  if (room < 2) return `${name.slice(0, max - 1)}…`;
  const stem = name.slice(0, name.length - ext.length);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(stem.length - tail) : ""}${ext}`;
}

/** A call's tool as the tab prints it: its name, or the entry of a Copilot file snapshot in the reader's language. */
export function toolOf(lang: Lang, call: FileCall): string {
  return call.snapshot !== undefined ? t(lang, "filesTab.snapshot.entry") : call.tool;
}

/** A call's line as the tab prints it: a command after `$`, a snapshot after its entry. */
export function lineOf(lang: Lang, call: FileCall): string {
  if (call.snapshot !== undefined) return `${t(lang, "filesTab.snapshot.entry")} ${call.line}`;
  return call.shell ? `$ ${call.line}` : call.line;
}

/** A snapshot file's lines: `+added −removed`. */
export const linesText = (lines: { added: number; removed: number }): string =>
  `+${lines.added} \u2212${lines.removed}`;
