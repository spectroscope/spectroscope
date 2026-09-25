// Card 416: how a run_command input says rtk rewrote it.
//
// RtkFilter.apply (spectro-core) rewrites the model's shell line above the
// permission gate. The rewritten input keeps every field of the model's, puts
// the line that runs into `command`, and adds the model's line and the
// rewriter's name beside it. Only run_command is ever rewritten (RtkFilter.TOOL).
// rtkRewrite.drift.test.ts reads these names off the Java constants.

/** The one tool rtk rewrites. */
export const RTK_TOOL = "run_command";
/** The line that runs, before and after a rewrite. */
export const RTK_COMMAND_FIELD = "command";
/** The line the model wrote, present only on a rewritten call. */
export const RTK_ORIGINAL_FIELD = "originalCommand";
/** Who changed the line, present only on a rewritten call. */
export const RTK_REWRITER_FIELD = "rewrittenBy";

/** A rewritten call's two lines and who rewrote it. */
export interface RtkRewrite {
  /** The line the tool ran. */
  command: string;
  /** The line the model wrote. */
  original: string;
  /** The rewriter's name as the input carries it. */
  rewrittenBy: string;
}

/**
 * The rewrite an input carries, or null when it carries none.
 *
 * @param name  the tool's wire name
 * @param input the call's input, of any shape
 * @return the two lines and the rewriter, or null for any other tool, for an
 *         input missing one of the three text fields, and for two equal lines
 */
export function rtkRewriteOf(name: string, input: unknown): RtkRewrite | null {
  if (name !== RTK_TOOL || typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  const command = fields[RTK_COMMAND_FIELD];
  const original = fields[RTK_ORIGINAL_FIELD];
  const rewrittenBy = fields[RTK_REWRITER_FIELD];
  if (typeof command !== "string" || typeof original !== "string" || typeof rewrittenBy !== "string")
    return null;
  if (command === original) return null;
  return { command, original, rewrittenBy };
}
