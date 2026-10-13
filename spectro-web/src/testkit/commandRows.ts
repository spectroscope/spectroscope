// Card 554: the command list as the server would serve it, read off the core
// resource by relative path, the way modeLeveling.test.ts reads levels.json.
// Test-only: nothing under src/ imports this module except *.test.* files.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rowOf, type CommandRow } from "../state/commandList";

/** The path of the one list, from the repository root. */
export const COMMANDS_JSON = "spectro-core/src/main/resources/commands/commands.json";

/** The raw rows of the core list, as written in the file. */
export function rawCoreCommands(): Record<string, unknown>[] {
  const path = fileURLToPath(new URL(`../../../${COMMANDS_JSON}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
}

/** The core list read the way the web reads GET /api/commands. */
export function coreCommandRows(): CommandRow[] {
  return rawCoreCommands()
    .map(rowOf)
    .filter((r): r is CommandRow => r !== null);
}
