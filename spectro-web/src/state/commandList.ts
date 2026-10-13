// Card 554: the chat's commands, as the server serves them.
//
// One list in spectro-core (resources/commands/commands.json) makes the
// terminal's /help, the web chat's /help, the slash picker and the Skills and
// Commands page. The web fetches it from GET /api/commands (owner, option A)
// once, when the composer first mounts, and again after a reconnect. Fix
// round 3: a request counts as failed after COMMANDS_TIMEOUT_MS, and Enter on
// a held draft asks again after a failure.
//
// Criterion 8h: until the list has arrived the picker says the commands are
// loading, and a draft that starts with a slash is held in the composer. A
// /clear typed in the first second must not reach the model as a prompt.
//
// German help texts are not in the list: they live in the web dictionary as
// cmd.<id>.help, and commandHelp.drift.test.ts holds the dictionary to the list.

import { useEffect, useSyncExternalStore } from "react";
import type { ViewMode } from "./viewMode";

/** One command, as GET /api/commands answers it (CommandList.Command). */
export interface CommandRow {
  /** Unique; names the help key cmd.<id>.help. */
  id: string;
  /** The first word, without the slash. */
  name: string;
  /** Other whole spellings without the slash, one or two words each. */
  aliases: string[];
  /** The second word, or null for a command of one word. */
  sub: string | null;
  /** True for a command that takes words after it; the picker writes it into the draft. */
  takesArgs: boolean;
  /** chat, playbook, codegraph or skills. */
  group: string;
  /** Where it works: web, repl or both. */
  surfaces: string;
  /** Listed in developer mode only; typing it works in every mode. */
  developerOnly: boolean;
  /** False for a row another card builds: no face lists or runs it yet. */
  wired: boolean;
  help: { en: string };
}

/** Never asked · in flight · answered · the last request failed. */
export type CommandListStatus = "idle" | "loading" | "ready" | "failed";

interface State {
  status: CommandListStatus;
  /** Null until the first answer; a reload keeps the rows it had. */
  rows: readonly CommandRow[] | null;
}

let state: State = { status: "idle", rows: null };
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const wake of [...listeners]) wake();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One row of the answer, read defensively: a row without an id or a name is
 * dropped, an absent list of aliases reads as none, an absent `wired` as true.
 *
 * @param raw one element of the answer
 * @returns the row, or null when it cannot be one
 */
export function rowOf(raw: unknown): CommandRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "" || typeof r.name !== "string" || r.name === "") return null;
  const help = r.help as { en?: unknown } | undefined;
  return {
    id: r.id,
    name: r.name,
    aliases: Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === "string") : [],
    sub: typeof r.sub === "string" && r.sub !== "" ? r.sub : null,
    takesArgs: r.takesArgs === true,
    group: typeof r.group === "string" ? r.group : "chat",
    surfaces: typeof r.surfaces === "string" ? r.surfaces : "both",
    developerOnly: r.developerOnly === true,
    wired: r.wired !== false,
    help: { en: typeof help?.en === "string" ? help.en : "" },
  };
}

/** Card 554 fix round 3: how long a request may stay unanswered before it counts as failed. */
export const COMMANDS_TIMEOUT_MS = 10_000;

/** The request whose answer counts; an older one that answers late is ignored. */
let generation = 0;

function fetchRows(): void {
  const mine = ++generation;
  set({ status: "loading", rows: state.rows });
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("timeout"));
    }, COMMANDS_TIMEOUT_MS);
  });
  Promise.race([fetch("/api/commands", { signal: abort.signal }), timeout])
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: unknown) => {
      if (mine !== generation) return;
      const rows = Array.isArray(body) ? body.map(rowOf).filter((r): r is CommandRow => r !== null) : [];
      set({ status: "ready", rows });
    })
    .catch(() => {
      if (mine === generation) set({ status: "failed", rows: state.rows });
    })
    .finally(() => clearTimeout(timer));
}

/** Fetches the list unless it is in flight or already here. A failed request is tried again. */
export function loadCommands(): void {
  if (state.status === "loading" || state.status === "ready") return;
  fetchRows();
}

/** Fetches the list again (after a reconnect); the rows it had stay until the answer. */
export function reloadCommands(): void {
  if (state.status === "loading") return;
  fetchRows();
}

/** The rows now, or null while none have arrived. Read at call time. */
export function commandRows(): readonly CommandRow[] | null {
  return state.rows;
}

/** Where the list stands now. */
export function commandListStatus(): CommandListStatus {
  return state.status;
}

const snapshot = (): State => state;

/**
 * The list and its status. Mounting asks for the list once, so the composer
 * has it before the first slash.
 */
export function useCommandList(): { rows: readonly CommandRow[] | null; status: CommandListStatus } {
  const now = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    loadCommands();
  }, []);
  return now;
}

/**
 * For App: fetch the list again each time the socket opens (the first connect
 * and every reconnect), as the settings are pulled again.
 *
 * @param connection the socket's status word; "open" asks
 */
export function useCommandsOnConnect(connection: string): void {
  useEffect(() => {
    if (connection === "open") reloadCommands();
  }, [connection]);
}

/**
 * The rows the web chat offers: the web's and both faces', only the wired
 * ones, and outside developer mode not the developer rows.
 *
 * @param rows the list
 * @param mode the window's mode; absent lists the developer rows too
 * @returns the rows in list order
 */
export function webCommands(rows: readonly CommandRow[], mode?: ViewMode): CommandRow[] {
  return rows.filter(
    (row) =>
      (row.surfaces === "web" || row.surfaces === "both") &&
      row.wired &&
      (mode === undefined || mode === "developer" || !row.developerOnly),
  );
}

/** Test seam: the rows as if the server had answered, or null for none yet. */
export function __setCommandRows(rows: readonly CommandRow[] | null): void {
  generation++;
  set({ status: rows === null ? "idle" : "ready", rows });
}

/** Test seam: back to never asked; a request still out no longer counts. */
export function __resetCommandList(): void {
  generation++;
  state = { status: "idle", rows: null };
}
