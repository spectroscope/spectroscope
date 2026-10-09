// Card 466: the composer gear's tool groups, the pure half.
//
// The server owns the list. Its socket-only tool_groups_info frame names the
// seven groups in order, the tools each one holds in this session, and the
// groups that are switched off. Nothing here types a group or a tool name, so
// a group the server adds or a tool that joins a family shows up in the gear
// without a change on this side.

import type { ClientMessage } from "../events";
import type { WorkspaceInfo } from "./reducer";

/** One group as the server describes it. */
export interface ToolGroupInfo {
  /** The wire name, the same word the settings key and the frame use. */
  name: string;
  /** The tools this session carries in the group, in belt order. */
  tools: string[];
}

/** The whole frame, read into what the gear draws. */
export interface ToolGroupsInfo {
  /** The switched-off groups, by wire name. */
  off: string[];
  /** Every group, in the order the gear lists them. */
  groups: ToolGroupInfo[];
  /** Why the server could not save the last change into the local scope.
   *  Absent when it saved, or was not asked to. */
  saveError?: string;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Reads a tool_groups_info frame defensively. A frame without the two lists
 *  is no frame at all (null), so the gear keeps the last truth it had rather
 *  than drawing an empty section; a malformed entry inside an otherwise good
 *  frame is dropped and the rest is kept. */
export function parseToolGroupsInfo(raw: unknown): ToolGroupsInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as { off?: unknown; groups?: unknown; saveError?: unknown };
  if (!Array.isArray(frame.off) || !Array.isArray(frame.groups)) return null;
  const groups: ToolGroupInfo[] = [];
  for (const entry of frame.groups) {
    if (entry === null || typeof entry !== "object") continue;
    const group = entry as { name?: unknown; tools?: unknown };
    if (typeof group.name !== "string") continue;
    groups.push({ name: group.name, tools: strings(group.tools) });
  }
  const saveError = typeof frame.saveError === "string" && frame.saveError !== "" ? frame.saveError : null;
  return { off: strings(frame.off), groups, ...(saveError === null ? {} : { saveError }) };
}

/** The list the gear sends after one checkbox changed: the group flips, the
 *  result holds each name once, only names the server listed, in its order. */
export function toggleGroup(off: string[], name: string, order: string[]): string[] {
  const next = new Set(off);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return order.filter((group) => next.has(group));
}

/** The hint line under a group: the tools it would take out of the request. */
export function groupHint(group: ToolGroupInfo): string {
  return group.tools.join(", ");
}

/** Whether a change in the gear is saved. A session is pinned the moment a
 *  workspace frame says so, the connect-time one included: the folder is
 *  known before the first prompt, even though no run has resolved it. */
export function savesToolGroups(workspace: WorkspaceInfo | null): boolean {
  return workspace?.configured === true;
}

/** What one change in the gear does: the open session switches at once over
 *  the socket (the next run carries the new list). With `save`, the server
 *  also writes the list to the local settings file of the pinned folder, so
 *  the next session starts with it, and answers with the reason when it
 *  could not. The server writes it because before the first prompt the page
 *  has no session id to address the settings API with. */
export function switchToolGroups(
  off: string[],
  deps: {
    sendClient: (msg: ClientMessage) => boolean;
    save: boolean;
  },
): void {
  deps.sendClient({ type: "set_tool_groups_off", groups: off, save: deps.save });
}

/** The tools a request carries once the switched-off groups are left out,
 *  read from the server's own frame (the tools it lists under each group),
 *  so no group rule is repeated here. Without a frame nothing is dropped. */
export function withoutSwitchedOff<T extends { name: string }>(tools: T[], info: ToolGroupsInfo | null): T[] {
  if (info === null || info.off.length === 0) return tools;
  const hidden = new Set(
    info.groups.filter((group) => info.off.includes(group.name)).flatMap((group) => group.tools),
  );
  return tools.filter((tool) => !hidden.has(tool.name));
}
