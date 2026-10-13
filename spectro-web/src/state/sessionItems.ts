// Card 558: the skills, commands and agents of the session in view, as the
// server reads them for its next turn.
//
// The socket-only frame session_items carries them: the picked playbook whose
// items are in the list (or null, also for "No playbook"), and one row per
// item with its effective name, its name in its source, the source
// (workspace, playbook or user) and the namespace a doubled name is put
// under. The server sends it after every playbook_info, after a folder change
// once the page has it, and when the page asks with get_session_items.
//
// Pure: the reducer folds the frame, the slash picker and the Skills and
// Commands page read it.

import type { SkillOption } from "./slashCommands";
import { t, type Lang } from "../i18n/i18n";

export type SessionItemKind = "skill" | "command" | "agent";
export type SessionItemSource = "workspace" | "playbook" | "user";

/** One item of the session. */
export interface SessionItem {
  kind: SessionItemKind;
  /** The effective name: what /name writes and what the model calls. */
  name: string;
  /** The name in its source. */
  plain: string;
  source: SessionItemSource;
  /** The word a doubled name is put under: workspace, user or the playbook's id. */
  namespace: string;
  description: string;
}

/** The session's items, from session_items. */
export interface SessionItems {
  /** The picked playbook whose items are in the list; null when there is none. */
  playbook: { dir: string; id: string; name: string } | null;
  items: SessionItem[];
}

const KINDS: readonly SessionItemKind[] = ["skill", "command", "agent"];
const SOURCES: readonly SessionItemSource[] = ["workspace", "playbook", "user"];

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * A session_items frame, or null when it cannot be read. A row of an unknown
 * kind or source is left out rather than guessed.
 *
 * @param frame the frame as it came off the socket
 */
export function parseSessionItems(frame: unknown): SessionItems | null {
  const f = frame as { playbook?: unknown; items?: unknown };
  if (!Array.isArray(f.items)) return null;
  const items: SessionItem[] = [];
  for (const raw of f.items as unknown[]) {
    const r = raw as Record<string, unknown>;
    const kind = str(r.kind) as SessionItemKind | null;
    const source = str(r.source) as SessionItemSource | null;
    const name = str(r.name);
    if (kind === null || !KINDS.includes(kind) || source === null || !SOURCES.includes(source)) continue;
    if (name === null || name === "") continue;
    items.push({
      kind,
      name,
      plain: str(r.plain) ?? name,
      source,
      namespace: str(r.namespace) ?? source,
      description: str(r.description) ?? "",
    });
  }
  const p = f.playbook as { dir?: unknown; id?: unknown; name?: unknown } | null | undefined;
  const dir = p === null || p === undefined ? null : str(p.dir);
  const playbook =
    dir === null || p === null || p === undefined
      ? null
      : { dir, id: str(p.id) ?? "", name: str(p.name) ?? str(p.id) ?? "" };
  return { playbook, items };
}

/**
 * The slash items of the session: its skills and commands, as the picker
 * lists them. An agent is not a slash item. The folder is the part after the
 * last colon, the half a reader remembers.
 *
 * @param items the session's items
 */
export function slashItems(items: SessionItems): SkillOption[] {
  return items.items
    .filter((i) => i.kind !== "agent")
    .map((i) => ({
      name: i.name,
      folder: i.name.slice(i.name.lastIndexOf(":") + 1),
      pack: null,
      description: i.description,
      disabled: false,
      kind: i.kind as "skill" | "command",
      source: i.source,
      sourceName: i.source === "playbook" ? (items.playbook?.name ?? i.namespace) : undefined,
    }));
}

/**
 * The items of the session in view: the live socket's, or a woken stored
 * session's while it can be continued; null for anything else (an archive,
 * an import), which then has no session to ask.
 */
export function sessionItemsOf(at: {
  viewingLive: boolean;
  liveItems: SessionItems | null;
  continuable: boolean;
  wokenItems: SessionItems | null;
}): SessionItems | null {
  if (at.viewingLive) return at.liveItems;
  return at.continuable ? at.wokenItems : null;
}

/**
 * Whether the page should ask the server for the session's items now: the
 * picker or the page is open, none have arrived, and none were asked for yet.
 */
export function wantsItems(open: boolean, items: SessionItems | null, asked: boolean): boolean {
  return open && items === null && !asked;
}

/**
 * The label of an item's source: the playbook's name for a playbook item,
 * else the source in words.
 *
 * @param item the item, or a picker row made from one
 * @param lang the page language
 */
export function sourceLabel(item: { source?: SessionItemSource; sourceName?: string }, lang: Lang): string {
  if (item.source === "playbook") return item.sourceName ?? t(lang, "slash.src.playbook");
  return t(lang, item.source === "workspace" ? "slash.src.workspace" : "slash.src.user");
}

/** The order the Skills and Commands page lists the kinds and the sources in. */
export const ITEM_KINDS = KINDS;
export const ITEM_SOURCES = SOURCES;
