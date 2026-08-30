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

import { describeTool, type ToolView } from "../../components/toolViews";
import { CC_DISK_READ, CC_DISK_WRITE, SHELL_TOOLS } from "../labScene";

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
  /**
   * `launch` = handed to a background task, not a step this agent takes.
   * `foreign` = a call in flight that belongs to none of the chips above: the
   * belt draws it as its own chip, printing the wire name, rather than going
   * dark and reading as "nothing is running" (card 321).
   */
  kind: "tool" | "launch" | "foreign";
  /** This is the call in flight. */
  on: boolean;
}

/**
 * The payload the belt asks the classifier with.
 *
 * `describeTool` answers about a CALL, not about a name: every shaped arm of it
 * guards on the fields it needs and falls back to `generic` when they are
 * missing, which is the honesty rule of the tool card — never draw a pretty
 * card over a payload we did not understand. The belt is asking a different
 * question, "what shape does a call to this tool HAVE", and that question is
 * about the name alone. So it hands over a payload that satisfies every shape
 * and reads only the kind that comes back.
 *
 * These are FIELD names, not tool names — the thing this card exists to remove
 * is a second vocabulary of tools, and there is none here. One key per shape
 * the table below gives a chip to; the shapes it gives no chip to would answer
 * `generic` with an unsatisfied probe and `generic` maps to no chip either, so
 * the two answers coincide and nothing hangs on them.
 * `beltCoverage.test.tsx` demands that every chip-bearing shape stay reachable
 * through it, so a classifier that grows a new guarded field cannot quietly
 * drop a chip back into darkness.
 */
const NAME_PROBE = {
  path: "p",
  content: "c",
  old_string: "a",
  new_string: "b",
  pattern: "*",
  command: "c",
  name: "n",
};

/**
 * The shape a call to `tool` has, asked by name alone.
 *
 * @param tool the tool's wire name
 * @return the view kind `describeTool` gives that name
 */
export function viewKindOf(tool: string): ToolView["kind"] {
  return describeTool(tool, NAME_PROBE, undefined, false).kind;
}

/**
 * Which chip a shape belongs to, or null when this belt has no station for it.
 *
 * A `Record` over the WHOLE union on purpose: a new arm on `ToolView` is then a
 * compile error here rather than a chip that quietly goes dark, which is the
 * exact failure card 321 was written for.
 *
 * Two entries are judgements and say so:
 *
 * - `matches` (a glob or a grep) draws `list_dir`. It is the closest of the
 *   three disk verbs, not an exact one: a grep's answer is lines out of files.
 *   But it addresses the tree by PATTERN and never opens a file the caller
 *   named, and `read_file` would claim it did. The two share one arm of the
 *   classifier, so they share one chip whatever it is.
 * - `image` gets no chip of this belt's. The arm carries both a generated
 *   image and a picture READ off the disk, and lighting `generate_image` for
 *   the second would say a picture was made that was only looked at. Since the
 *   review round that is not the same as drawing nothing: a `view_image` in
 *   flight now wears the name chip below, like any other tool this belt has no
 *   chip for. `generate_image` itself is a chip label and is answered by name
 *   before any of this runs.
 */
export const CHIP_FOR_KIND: Record<ToolView["kind"], string | null> = {
  file: "read_file",
  write: "write_file",
  edit: "write_file",
  listing: "list_dir",
  matches: "list_dir",
  command: "run_command",
  skill: "use_skill",
  mcp: "call_mcp",
  image: null,
  agents: null,
  plan: null,
  task: null,
  question: null,
  web: null,
  workflow: null,
  generic: null,
};

/**
 * The remainder: names the MAP already routes to a station that the classifier
 * has no arm for at all.
 *
 * A mapping of STATIONS — three sets, three chips — and deliberately not of
 * tool names: every name comes out of the sets `labScene` exports and folds
 * with, so a name added there is covered here the moment it is added. The
 * native disk verbs are absent because they ARE chip labels and are answered by
 * name; these three sets are the imported vocabulary the fold learnt.
 *
 * What it carries today is exactly one name, and it is why this step exists:
 * the fold routes it to the disk, the classifier has never heard of it, and
 * without this it would draw as a call with no station while the disk beside it
 * spins.
 */
const STATION_CHIP: [ReadonlySet<string>, string][] = [
  [CC_DISK_READ, "read_file"],
  [CC_DISK_WRITE, "write_file"],
  [SHELL_TOOLS, "run_command"],
];

/**
 * The chip a running tool lights, or null when this belt has none for it.
 *
 * The order is the whole answer and each step is asked for a reason:
 *
 * 1. a launch name FIRST, because one of them sits inside the classifier's
 *    command arm and would otherwise be drawn as an ordinary shell call;
 * 2. this belt's own labels, because two of them would otherwise fall through
 *    everything below, for two different reasons: `call_mcp` has no arm in the
 *    classifier at all (the mcp shape is reached by the `mcp__` wire prefix,
 *    never by that name), and `generate_image` has an arm whose guard the probe
 *    below does not satisfy, so asked by name it answers `generic`. Measured
 *    2026-08-30: narrowing this step to `call_mcp` alone drops the
 *    `generate_image` chip;
 * 3. the classifier, which is the point of the card: one place already answers
 *    "what is this call", and the trace, the chat card and this belt read it;
 * 4. the fold's own station sets, for the names it routes that the classifier
 *    does not know.
 *
 * @param tool the wire name of the call in flight
 * @return the label of the chip to light, or null for a tool with no chip
 */
function chipFor(tool: string): string | null {
  if (LAUNCH_CHIPS.includes(tool)) return tool;
  if (TOOL_CHIPS.includes(tool)) return tool;
  // `?? null` is load-bearing, not defensive noise: a kind the table has no key
  // for reads back as `undefined`, and `undefined !== null` would return it as
  // though it were a chip — lighting nothing AND skipping the honesty chip,
  // because that one guards on `lit === null`. beltOffUnion.test.ts mocks the
  // classifier into answering off the union and demands this.
  const byShape = CHIP_FOR_KIND[viewKindOf(tool)] ?? null;
  if (byShape !== null) return byShape;
  for (const [names, chip] of STATION_CHIP) if (names.has(tool)) return chip;
  return null;
}

/**
 * The belt, with the running tool lit.
 *
 * Card 321. It used to light a chip by `name === activeTool`, an exact match
 * against the seven labels below — so an imported Claude Code transcript, which
 * spells none of them, lit nothing at all. Measured over ~/.claude/projects on
 * 2026-08-30 (6.2 GB, 106 folders): of 292,465 `tool_use` blocks in 135
 * distinct names, 794 matched — 0.27%, and all of them one of the two launch
 * verbs. Zero of the seven occur anywhere in the corpus.
 *
 * A tool the belt has no chip for gets a chip of its own, printing its wire
 * name, rather than leaving the belt dark: 18,300 of those blocks (6.3%)
 * resolve to no chip even now, and "running something with no chip of its own"
 * is a different fact from "running nothing".
 *
 * 947 of those 18,300 never reach this function at all, and the number is kept
 * honest rather than rounded: `Task` and `Agent` are the importer's SPAWN
 * verbs (claudeCode.ts, `isSpawnTool`), so they leave a transcript as
 * `agent_spawn` and never as a `tool_call`. What an imported session can
 * actually put on this chip is the other 17,353 — 5.9%.
 *
 * @param activeTool the wire name of the call in flight, null between calls
 * @return every chip in reading order, tools first; the running tool's own
 *         chip last when it belongs to none of them
 */
export function agentBelt(activeTool: string | null): BeltChip[] {
  const lit = activeTool === null ? null : chipFor(activeTool);
  const chip = (name: string, kind: BeltChip["kind"]): BeltChip => ({
    name,
    kind,
    on: name === lit,
  });
  const belt = [...TOOL_CHIPS.map((n) => chip(n, "tool")), ...LAUNCH_CHIPS.map((n) => chip(n, "launch"))];
  if (activeTool !== null && lit === null) belt.push({ name: activeTool, kind: "foreign", on: true });
  return belt;
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
