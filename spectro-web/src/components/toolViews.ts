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
  | { kind: "image"; path: string; result: string }
  | { kind: "skill"; name: string; body: string }
  | { kind: "generic"; input: unknown; output: string };

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
    case "read_file":
    case "view_file": {
      const path = str(input, "path");
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

    case "write_file": {
      const path = str(input, "path");
      const content = str(input, "content");
      if (path === null || content === null) return generic;
      return { kind: "write", path, content, result: out };
    }

    case "edit_file": {
      const path = str(input, "path");
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

    case "glob":
    case "grep": {
      const pattern = str(input, "pattern");
      if (pattern === null) return generic;
      return { kind: "matches", pattern, path: str(input, "path"), lines: lines(out) };
    }

    case "run_command": {
      const command = str(input, "command");
      if (command === null) return generic;
      return { kind: "command", command, output: out, failed: isError };
    }

    case "view_image": {
      const path = str(input, "path");
      if (path === null) return generic;
      return { kind: "image", path, result: out };
    }

    case "use_skill": {
      const skill = str(input, "name");
      if (skill === null) return generic;
      return { kind: "skill", name: skill, body: out };
    }

    default:
      return generic;
  }
}
