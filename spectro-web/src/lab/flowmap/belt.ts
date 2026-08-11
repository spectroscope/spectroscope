// The agent hub's chip belt: what the map says this agent can reach for, and
// which of it is running right now.
//
// Card 146. The belt listed seven names, all of them the harness's own tools,
// and a `Workflow` — the call that hands a whole fan-out to a background task —
// matched none of them, so it lit nothing and read as an ordinary step. The
// counts are the reason that mattered: over ~/.claude/projects on 2026-08-11,
// 409 Workflow and 86 Monitor tool_use blocks across 109 of 5695 transcripts,
// against zero occurrences of any of the seven.
//
// The earlier count here said "408 `"name":"Workflow"` lines". That measured
// LINES containing the substring, not calls; two launches in one assistant
// message counted once. Parsing the blocks gives 409.
//
// A launch is therefore its OWN kind on the belt, not an eighth tool. What the
// agent runs itself and what it hands to a task it will only hear back from
// later are different claims, and the map is read for exactly that difference.

import { describeTool } from "../../components/toolViews";

/** The harness's own tool belt, plus the extension actions. */
export const TOOL_CHIPS = [
  "read_file",
  "write_file",
  "list_dir",
  "run_command",
  "use_skill",
  "call_mcp",
  "generate_image",
];

/**
 * The tools that hand work to a background task.
 *
 * The same two the trace's `workflow` chip answers to (TraceView's
 * BACKGROUND_TASK_TOOLS), and deliberately not a second rule of this view's
 * own: a belt that knew only `Workflow` would draw a `Monitor` launch as an
 * ordinary tool while the trace beside it drew it as a workflow. belt.test.ts
 * pins the two lists against each other so they cannot drift apart quietly.
 */
export const LAUNCH_CHIPS = ["Workflow", "Monitor"];

export interface BeltChip {
  /** The tool's wire name — what the chip prints. */
  name: string;
  /** `launch` = handed to a background task, not a step this agent takes. */
  kind: "tool" | "launch";
  /** This is the call in flight. */
  on: boolean;
}

/**
 * The belt, with the running tool lit.
 *
 * @param activeTool the wire name of the call in flight, null between calls
 * @return every chip in reading order, tools first
 */
export function agentBelt(activeTool: string | null): BeltChip[] {
  const chip = (name: string, kind: BeltChip["kind"]): BeltChip => ({
    name,
    kind,
    on: name === activeTool,
  });
  return [...TOOL_CHIPS.map((n) => chip(n, "tool")), ...LAUNCH_CHIPS.map((n) => chip(n, "launch"))];
}

/**
 * Why a launch has the phase list it has.
 *
 * - `declared` — the script travelled inline and named its phases.
 * - `silent` — the script is here and declares none.
 * - `elsewhere` — a saved name or a path: the script exists, this call is only
 *   a reference to it.
 * - `scriptless` — the launch has no script at all. A `Monitor` waits on a
 *   shell loop with its stop condition inside the command.
 * - `unknown` — nothing is in flight, or what is in flight is not a launch.
 */
export type LaunchScript =
  | { state: "declared"; phases: string[] }
  | { state: "silent" }
  | { state: "elsewhere" }
  | { state: "scriptless" }
  | { state: "unknown" };

/**
 * Read a launch's script the way the tool card reads it, and keep the reason
 * the answer came out the way it did.
 *
 * The four empty answers are four different facts and the map has to say which
 * one it means. Measured over ~/.claude/projects on 2026-08-11 by running this
 * reader across the corpus: of 495 launches, 358 declare phases and 137 do not
 * — but only 51 of those 137 are the by-name/by-path case. The other 86 are
 * `Monitor` calls, which carry a shell command and no script field at all, and
 * whose view never comes back as `workflow` because describeTool routes them
 * into the Bash/command case. Collapsing all 137 into one sentence sent the
 * reader of 86 of them hunting for a script that was never written.
 *
 * @param tool the call in flight (name + input), or null between calls
 * @return the launch's phase list together with the reason for it
 */
export function launchScript(tool: { name: string; input: unknown } | null): LaunchScript {
  if (tool === null || !LAUNCH_CHIPS.includes(tool.name)) return { state: "unknown" };
  const view = describeTool(tool.name, tool.input, undefined, false);
  if (view.kind !== "workflow") return { state: "scriptless" };
  if (view.phases.length > 0) return { state: "declared", phases: view.phases };
  return view.script === null ? { state: "elsewhere" } : { state: "silent" };
}

/** What the map prints instead of a phase list, one sentence per reason. */
export const LAUNCH_SCRIPT_NOTE: Record<Exclude<LaunchScript["state"], "declared">, string> = {
  silent: "the script is in this call and declares no phases",
  elsewhere: "the script is not in this call",
  scriptless: "this launch waits on a command, not a script",
  unknown: "the call is not in this view",
};
