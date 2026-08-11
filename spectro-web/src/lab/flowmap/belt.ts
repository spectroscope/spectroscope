// The agent hub's chip belt: what the map says this agent can reach for, and
// which of it is running right now.
//
// Card 146. The belt listed seven names, all of them the harness's own tools,
// and a `Workflow` — the call that hands a whole fan-out to a background task —
// matched none of them, so it lit nothing and read as an ordinary step. The
// counts are the reason that mattered: over ~/.claude/projects on 2026-08-11,
// 408 `"name":"Workflow"` lines across 82 of 5686 transcripts and 86 `Monitor`,
// against zero occurrences of any of the seven.
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
 * The phases a launch in flight DECLARES — read off the script it was called
 * with, through the same reader the tool card uses, so there is no second
 * parser to disagree with the first.
 *
 * Declared is all this can ever be. The phases are the script's own header; the
 * agents that would run them live in other runs with other event streams, and
 * nothing in this session says a phase finished. A launch given by saved name
 * or by path returns nothing at all: that script is not here, and a phase list
 * invented for it would be the map describing content it never saw.
 *
 * @param tool the call in flight (name + input), or null between calls
 * @return the declared phase names in script order, empty when none are readable
 */
export function declaredPhases(tool: { name: string; input: unknown } | null): string[] {
  if (tool === null || !LAUNCH_CHIPS.includes(tool.name)) return [];
  const view = describeTool(tool.name, tool.input, undefined, false);
  return view.kind === "workflow" ? view.phases : [];
}
