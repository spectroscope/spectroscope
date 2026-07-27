// The structured tool view (card 94): a tool call is not two JSON blobs, it is
// a SHAPE — a file being read, an edit, a listing, a command in a terminal.
// This module names that shape; the card renders it. Pure and DOM-free, so the
// mapping is unit-tested while the pixels stay in ToolCard.
//
// Honesty rule: a tool whose input does not carry the fields the shape needs
// falls back to `generic` (the raw pair). We never render an empty pretty card
// over a payload we did not understand — the model can send anything.

/** One tool call, described as what it actually is. */
export type ToolView =
  | { kind: "file"; path: string; range: string | null; body: string; lineCount: number }
  | { kind: "write"; path: string; content: string; result: string }
  | { kind: "edit"; path: string; before: string; after: string; result: string }
  | { kind: "listing"; path: string; entries: string[] }
  | { kind: "matches"; pattern: string; path: string | null; lines: string[] }
  | { kind: "command"; command: string; output: string; failed: boolean }
  | { kind: "image"; source: string | null; prompt: string | null; preview: string | null; result: string }
  | { kind: "skill"; name: string; body: string }
  | { kind: "mcp"; server: string; tool: string; input: unknown; output: string }
  | { kind: "agents"; children: SpawnedAgent[]; result: string }
  | { kind: "plan"; steps: PlanRow[] }
  | { kind: "web"; url: string | null; query: string | null; body: string }
  | { kind: "generic"; input: unknown; output: string };

/** One child of a fan-out. `label` is the short headline some vocabularies send
 *  next to the full task (Claude Code's `description`); null when there is none. */
export type SpawnedAgent = { type: string; task: string; label: string | null };

/** One plan step. `status` stays the English wire value (or null when the call
 *  omitted it) — the chrome translates, the data does not. */
export type PlanRow = { text: string; status: string | null };

/** The first of several string fields that is present — the same value travels
 *  under different names depending on which agent wrote the session
 *  (spectroscope says `path`, a VS Code export says `filePath`). */
function firstStr(input: unknown, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = str(input, key);
    if (value !== null) return value;
  }
  return null;
}

/** A string field of the input object, or null when absent/not a string. */
function str(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** A number field of the input object, or null. */
function num(input: unknown, key: string): number | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

/** Non-empty lines of a tool output — listings and searches are line-shaped. */
function lines(output: string): string[] {
  return output.split("\n").filter((l) => l.trim() !== "");
}

/** The array under the first of several keys, or null when none holds one. */
function arr(input: unknown, ...keys: string[]): unknown[] | null {
  if (typeof input !== "object" || input === null) return null;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Server and tool of a composed MCP name, splitting on the FIRST and SECOND
 * `__` only — a tool is free to carry underscores, single or double, in its own
 * name (`mcp__ccd_session__mark_chapter`, `mcp__srv__a__b`).
 *
 * @param name the tool's wire name
 * @return the two halves, or null when either is missing or empty
 */
function splitMcp(name: string): { server: string; tool: string } | null {
  const PREFIX = "mcp__";
  if (!name.startsWith(PREFIX)) return null;
  const sep = name.indexOf("__", PREFIX.length);
  if (sep < 0) return null;
  const server = name.slice(PREFIX.length, sep);
  const tool = name.slice(sep + 2);
  if (server === "" || tool === "") return null;
  return { server, tool };
}

/** A bundled demo asset (a scripted scenario's image), app-served as-is. */
const DEMO_PREFIX = "/demo/";

/** The image store's file-name contract, mirrored from the server's
 *  SessionsController.IMAGE_NAME — the endpoint answers 400 for anything else. */
const STORED_IMAGE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

/**
 * The path only when the browser can actually fetch it as an image.
 *
 * GET /api/images/{file} serves the content-addressed store and nothing else,
 * so a workspace file (view_image's usual argument) has no URL at all. Handing
 * one to an <img> would fire a guaranteed 400 and then blame the placeholder,
 * which reads as "the file is gone" instead of "this was never servable".
 *
 * @param path the path a tool named, as it named it
 * @return the same path when it is fetchable, else null
 */
function previewable(path: string | null): string | null {
  if (path === null) return null;
  if (path.startsWith(DEMO_PREFIX)) return path;
  const file = path.slice(path.lastIndexOf("/") + 1);
  return STORED_IMAGE.test(file) ? path : null;
}

/** generate_image's summary line names the file it stored. Anchored on the
 *  full known prefix so a reworded or failed result yields null rather than a
 *  wrong path: the value is read out of the output, never reconstructed. */
const GENERATED_PATH = /^Image generated with .*?\)?: (\S+) \(/;

/** The stored blob path of a finished generation, or null. */
function generatedPath(output: string): string | null {
  return GENERATED_PATH.exec(output)?.[1] ?? null;
}

/**
 * One fan-out child from an entry that carries a type and a task under any of
 * the known vocabularies.
 *
 * @param entry one `agents[]` element, or the whole input for the single-child tools
 * @return the child, or null when either half is missing (the caller then falls back)
 */
function spawnedAgent(entry: unknown): SpawnedAgent | null {
  const type = firstStr(entry, "type", "subagent_type");
  const task = firstStr(entry, "task", "prompt");
  if (type === null || task === null) return null;
  return { type, task, label: str(entry, "description") };
}

/**
 * One plan row from a step object of either vocabulary (`text` for update_plan,
 * `content` for TodoWrite).
 *
 * @param entry one element of the steps/todos array
 * @return the row, or null when it carries no text
 */
function planRow(entry: unknown): PlanRow | null {
  const text = firstStr(entry, "text", "content");
  if (text === null) return null;
  return { text, status: str(entry, "status") };
}

/**
 * Describe one tool call as its real shape.
 *
 * @param name    the tool's wire name
 * @param input   the call's input object (whatever the model sent)
 * @param output  the tool result, or undefined while the call is still pending
 * @param isError whether the result came back as an error
 * @return the view the card renders; `generic` whenever the shape is unclear
 */
export function describeTool(
  name: string,
  input: unknown,
  output: string | undefined,
  isError: boolean,
): ToolView {
  const out = output ?? "";
  const generic: ToolView = { kind: "generic", input, output: out };

  switch (name) {
    case "Read":
    case "read_file":
    case "view_file": {
      const path = firstStr(input, "path", "filePath", "file_path");
      if (path === null) return generic;
      const offset = num(input, "offset");
      const limit = num(input, "limit");
      const range =
        offset !== null
          ? limit !== null
            ? `lines ${offset}–${offset + limit - 1}`
            : `from line ${offset}`
          : null;
      return { kind: "file", path, range, body: out, lineCount: out === "" ? 0 : out.split("\n").length };
    }

    case "Write":
    case "create_file":
    case "write_file": {
      const path = firstStr(input, "path", "filePath", "file_path");
      const content = str(input, "content");
      if (path === null || content === null) return generic;
      return { kind: "write", path, content, result: out };
    }

    case "Edit":
    case "replace_string_in_file":
    case "edit_file": {
      const path = firstStr(input, "path", "filePath", "file_path");
      // The tool's wire names; both snake and camel are tolerated because the
      // model has been seen to send either.
      const before = str(input, "old_string") ?? str(input, "oldString");
      const after = str(input, "new_string") ?? str(input, "newString");
      if (path === null || before === null || after === null) return generic;
      return { kind: "edit", path, before, after, result: out };
    }

    case "list_dir": {
      const path = str(input, "path");
      if (path === null) return generic;
      return { kind: "listing", path, entries: lines(out) };
    }

    case "Glob":
    case "Grep":
    case "glob":
    case "grep": {
      const pattern = str(input, "pattern");
      if (pattern === null) return generic;
      return { kind: "matches", pattern, path: str(input, "path"), lines: lines(out) };
    }

    case "Bash":
    case "run_in_terminal":
    case "run_command": {
      const command = str(input, "command");
      if (command === null) return generic;
      return { kind: "command", command, output: out, failed: isError };
    }

    case "view_image": {
      const path = firstStr(input, "path", "filePath", "file_path");
      if (path === null) return generic;
      return { kind: "image", source: path, prompt: null, preview: previewable(path), result: out };
    }

    case "generate_image": {
      const prompt = str(input, "prompt");
      if (prompt === null) return generic;
      const source = generatedPath(out);
      return { kind: "image", source, prompt, preview: previewable(source), result: out };
    }

    case "Skill":
    case "use_skill": {
      const skill = firstStr(input, "name", "skill");
      if (skill === null) return generic;
      return { kind: "skill", name: skill, body: out };
    }

    case "spawn_agent":
    case "Task":
    case "Agent": {
      const child = spawnedAgent(input);
      if (child === null) return generic;
      return { kind: "agents", children: [child], result: out };
    }

    case "spawn_agents": {
      const batch = arr(input, "agents");
      if (batch === null || batch.length === 0) return generic;
      const children = batch.map(spawnedAgent);
      // One unreadable entry would misstate the fan-out's width.
      if (children.some((child) => child === null)) return generic;
      return { kind: "agents", children: children as SpawnedAgent[], result: out };
    }

    case "update_plan":
    case "TodoWrite": {
      const rows = arr(input, "steps", "todos");
      if (rows === null || rows.length === 0) return generic;
      const steps = rows.map(planRow);
      // A blank row would misreport the plan's length as much as its content.
      if (steps.some((step) => step === null)) return generic;
      return { kind: "plan", steps: steps as PlanRow[] };
    }

    case "web_fetch":
    case "WebFetch":
    case "browse_page":
    case "web_search":
    case "WebSearch": {
      const url = str(input, "url");
      const query = str(input, "query");
      if (url === null && query === null) return generic;
      return { kind: "web", url, query, body: out };
    }

    default: {
      const mcp = splitMcp(name);
      // Only the NAME is understood here: every MCP server owns its own input
      // schema, so the payload travels on unread rather than half-guessed.
      if (mcp !== null) return { kind: "mcp", server: mcp.server, tool: mcp.tool, input, output: out };
      return generic;
    }
  }
}
