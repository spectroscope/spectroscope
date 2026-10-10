// Card 493: the Local mode switch of the composer gear, the pure half.
//
// The server owns the switch. Its socket-only local_mode_info frame says
// whether the switch is on and what each of its rows holds: the value the
// chat holds, the value Local mode writes, whether the two differ, and the
// floor of a number. Nothing here types a preset value, so a value the
// server changes shows up in the gear without a change on this side.

import type { ClientMessage } from "../events";

/** One row of the switch as the server describes it. */
export interface LocalModeRow {
  /** The settings key the row holds. */
  key: string;
  /** The value the chat holds now. */
  value: unknown;
  /** The value Local mode writes. */
  preset: unknown;
  /** Whether the value differs from the preset. */
  changed: boolean;
  /** The lowest number the key takes, or null when it has no floor. */
  floor: number | null;
}

/** The whole frame, read into what the gear draws. */
export interface LocalModeInfo {
  on: boolean;
  rows: LocalModeRow[];
  /** Why the server could not write the switch into the local file. */
  saveError?: string;
}

/** Whether the chat's model can call tools, as the server found out. */
export interface ToolUseAnswer {
  toolUse: "yes" | "no" | "unknown";
  source: string;
}

/** Reads a local_mode_info frame defensively. A frame without the switch or
 *  the rows is no frame at all (null), so the gear keeps the last truth; a
 *  malformed row inside a good frame is dropped and the rest is kept. */
export function parseLocalModeInfo(raw: unknown): LocalModeInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const frame = raw as { on?: unknown; rows?: unknown; saveError?: unknown };
  if (typeof frame.on !== "boolean" || !Array.isArray(frame.rows)) return null;
  const rows: LocalModeRow[] = [];
  for (const entry of frame.rows) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as {
      key?: unknown;
      value?: unknown;
      preset?: unknown;
      changed?: unknown;
      floor?: unknown;
    };
    if (typeof row.key !== "string") continue;
    rows.push({
      key: row.key,
      value: row.value ?? null,
      preset: row.preset ?? null,
      changed: row.changed === true,
      floor: typeof row.floor === "number" ? row.floor : null,
    });
  }
  const saveError = typeof frame.saveError === "string" && frame.saveError !== "" ? frame.saveError : null;
  return { on: frame.on, rows, ...(saveError === null ? {} : { saveError }) };
}

type Send = (msg: ClientMessage) => boolean;

/** Switches Local mode on or off for the open chat. */
export function switchLocalMode(on: boolean, send: Send): void {
  send({ type: "set_local_mode", on });
}

/** Changes one value of the switch. */
export function editLocalModeValue(key: string, value: unknown, send: Send): void {
  send({ type: "set_local_mode", values: { [key]: value } });
}

/** Brings one row back to the value Local mode writes. */
export function resetLocalModeValue(key: string, send: Send): void {
  send({ type: "set_local_mode", reset: [key] });
}

/** A row's value as the gear prints it: a list joined with commas, an unset
 *  value as nothing. */
export function formatRowValue(row: LocalModeRow): string {
  const value = row.value;
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** What a typed number becomes: the value, or the reason it is refused. */
export type RowInput =
  { ok: true; value: number } | { ok: false; problem: { key: string; params: Record<string, string> } };

/** Parses a number typed into a row against its floor. */
export function parseRowInput(text: string, floor: number | null): RowInput {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, problem: { key: "wsg.lm.wholeNumber", params: {} } };
  const value = Number(trimmed);
  if (floor !== null && value < floor) {
    return { ok: false, problem: { key: "wsg.lm.belowFloor", params: { floor: String(floor) } } };
  }
  return { ok: true, value };
}

/** Where the gear asks whether the chat's model can call tools. */
export function toolUseUrl(provider: string, model: string): string {
  return `/api/models/tool-use?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`;
}

/** Reads the server's answer; anything else is no answer. */
export function parseToolUse(raw: unknown): ToolUseAnswer | null {
  if (raw === null || typeof raw !== "object") return null;
  const answer = raw as { toolUse?: unknown; source?: unknown };
  if (answer.toolUse !== "yes" && answer.toolUse !== "no" && answer.toolUse !== "unknown") return null;
  return { toolUse: answer.toolUse, source: typeof answer.source === "string" ? answer.source : "" };
}
