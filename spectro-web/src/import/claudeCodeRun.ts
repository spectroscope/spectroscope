// Card 291: a whole recorded run — the session stream plus its subagent
// sidecars — imported as ONE stream.
//
// A Claude Code session directory holds `<session>.jsonl` plus, per child,
// `subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`. The meta names the
// `tool_use` id the spawn rode in on (`toolUseId`), and that id IS the child's
// agent id in the parent's stream — measured on the reference run, 9 of 9
// metas matched a `tool_use` in the main file. The single-file importer
// already reads each of these files on its own (card 152 reads a pure
// sidechain file as one agent's transcript, and deliberately leaves
// `run_start.parentId` off because the owner lives in another file). This
// coordinator is that join and nothing else: no new parser, no wire change,
// no IO — it takes texts already read and hands back one merged stream.
//
// Degradation is per child, never per run: a sidecar whose meta is unreadable,
// whose join key the session never spawned, or whose stream is not one
// agent's transcript is SKIPPED and COUNTED. The session itself always
// imports; with zero sidecars the output is today's single-file import, byte
// for byte (pinned in the test file).

import type { RunEvent } from "../events";
import { detectAndLoad, type ImportKind, type ImportSource } from "./detect";
import { claudeCodeWithOrigin } from "./claudeCode";
import { readSubagentTranscript, type SubagentTranscript } from "./subagentFile";
import { clipMiddle } from "../lab/labScene";
import {
  declarationFor,
  readWorkflowState,
  type RunPhases,
  type WorkflowDeclaration,
} from "../lab/workflowGraph";

/** One child's two files, already read to text. The meta arrives as raw text
 *  because reading it is this module's job — a caller that parsed it would
 *  already have decided what a malformed one means. */
export interface SidecarText {
  jsonlText: string;
  metaJson: string;
  /** The workflow run whose directory the sidecar sat in, when the pick
   *  carried a path to read one from (card 297). A workflow child's meta is
   *  the WHOLE meta — `{"agentType":"workflow-subagent","spawnDepth":1}` — so
   *  the directory is the only attribution there is. */
  runId?: string;
}

/** One workflow run's own recorded state, `<session>/workflows/<runId>.json`,
 *  already read to text. */
export interface RunStateText {
  runId: string;
  json: string;
}

/** What the banner and the workspace pane need to know about a run import.
 *  A lone-file import never constructs one. */
export interface ImportedRunSummary {
  /** The `cwd` off the first record that carried one (session first, then the
   *  merged children, in order), or null when no record ever did. Display
   *  only: nothing on this machine is resolved or created from it. */
  workspace: string | null;
  childrenMerged: number;
  childrenSkipped: number;
  /** Card 297: agents a workflow run's state file NAMES and no transcript
   *  recorded. Neither merged nor skipped — nothing was there to skip — and
   *  it needs its own count, or a run that reports four agents shows three
   *  with nothing admitting the fourth. */
  childrenUnrecorded: number;
  /** Card 302: what each workflow run in this import DECLARED about its own
   *  columns, keyed by the node the run's agents hang under — the `Workflow`
   *  tool_use id. Absent, or empty, for a pick that carried no state file or
   *  whose state files listed no phases: the lens then draws its recovered
   *  picture and says so, which is the honest reading, not a degraded one. */
  declared?: WorkflowDeclaration;
}

export interface ClaudeCodeRunImport extends ImportedRunSummary {
  events: RunEvent[];
  /** The SESSION file's own detection, so the dialog hands the result to the
   *  same onLoad a single pick uses. */
  kind: ImportKind;
  /** What the session file said about itself when it was one agent's
   *  transcript (card 152), untouched by the merge. */
  subagent?: SubagentTranscript;
  /** The SESSION file's lines. A frame merged in from a sidecar carries
   *  origin -1 — "not from this file", the same word the importer uses for
   *  frames it built itself — because pointing it at a line of the session
   *  file would show a reader the wrong bytes. */
  source: ImportSource;
}

/**
 * The summary a run import hands the app — the measured half of the result,
 * without the stream.
 *
 * `ClaudeCodeRunImport` already IS an `ImportedRunSummary` structurally, so
 * handing the whole result over would compile. It would also carry the events,
 * the source map and the origin array into a value the app KEEPS for as long
 * as the session is open, which is not what that field is for. So the summary
 * is narrowed — and narrowed HERE, once, beside the interface it answers to,
 * rather than as a literal at the call site. A literal is where a field the
 * importer computes gets forgotten, and one was: `declared` was measured on
 * every run import from card 302 on, and no imported run ever reached the lab
 * with it (card 315).
 *
 * @param run the coordinator's result
 * @return what the banner, the workspace pane and the lab read
 */
export function runSummary(run: ClaudeCodeRunImport): ImportedRunSummary {
  return {
    workspace: run.workspace,
    childrenMerged: run.childrenMerged,
    childrenSkipped: run.childrenSkipped,
    childrenUnrecorded: run.childrenUnrecorded,
  };
}

/** The root run id the single-file importer stamps on the file's own run. */
const ROOT_RUN_ID = "cc-import";

/** A frame's fields as far as the merge reads them. Import-only frame types
 *  (ground_info) are not in the RunEvent union, so the merge reads shapes,
 *  never the union. */
interface FrameShape {
  type?: string;
  ts?: number;
  runId?: string;
  agentId?: string;
  parentId?: string;
  from?: string;
  to?: string;
  cwd?: string;
  callId?: string;
  output?: string;
  prompt?: string;
}

/** Every field a frame can carry an AGENT id in, measured over the importer's
 *  own output on the real reference run (2026-08-28): the hex root rides in
 *  `agentId` on run_start / turn_start / *_delta / tool_call / tool_result /
 *  usage / attachment_image, and — the moment a sidecar spawns its own Task —
 *  in `parentId` (agent_spawn, the grandchild's run_start) and in the
 *  `from`/`to` of agent_message. `ground_info.from` is a PATH, which is why
 *  the re-key below matches the value, never the field name alone. */
const ID_FIELDS = ["agentId", "parentId", "from", "to"] as const;

const shape = (e: RunEvent): FrameShape => e as unknown as FrameShape;

/** One event with the line it came from, the grain the merge works in. */
interface Sourced {
  ev: RunEvent;
  origin: number;
}

const parseJsonl = (text: string): unknown[] =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);

/** The meta's join key, or null for anything that is not a JSON object naming
 *  a non-empty `toolUseId`. */
function metaToolUseId(metaJson: string): string | null {
  try {
    const meta = JSON.parse(metaJson) as unknown;
    if (meta === null || typeof meta !== "object") return null;
    const id = (meta as { toolUseId?: unknown }).toolUseId;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

// ---- card 297: the workflow runs the session names --------------------------

/**
 * The run id a Workflow receipt prints.
 *
 * Deliberately the same grammar `state/work.ts` already owns for the launch
 * row, and duplicated for the same reason it duplicated the importer's: the
 * two readers must not be able to disagree about what a run id looks like,
 * and neither may reach into the other to find out. Measured 2026-08-29 over
 * a real session: 12 run directories, 12 tool_results naming a run id, one
 * `Workflow` tool_use each — no run resolved to two, none to none.
 */
const RECEIPT_RUN_ID = /\brun\s*id[:\s]\s*(wf_[A-Za-z0-9_-]{4,})\b/i;
/** The receipt's own one-line intent, the fallback name for a run whose state
 *  file was not picked (or not written yet). */
const RECEIPT_SUMMARY = /^Summary:\s*(.+)$/m;
/**
 * The outcome header `import/claudeCode.ts` folds under a receipt when the
 * task reports back: `--- task <id> · <status> ---`.
 *
 * A background launch is the one thing a session records TWICE — the receipt
 * where it went out, and a `<task-notification>` where it came back, minutes
 * or hours later. Without reading the second one the run node is spawned and
 * never ended, and every imported run reads "still running": measured
 * 2026-08-29 over one real session, 49 runs and 49 cards stuck at submitted.
 *
 * Duplicated from `state/work.ts` rather than imported, for the reason
 * RECEIPT_RUN_ID is: the two readers must not be able to disagree about what
 * an ending looks like, and neither may reach into the other to find out.
 */
const RECEIPT_OUTCOME = /^--- task (\S+)(?: · ([^-]+?))? ---$/gm;
/** How much of a child's own prompt survives into the spawn's task when
 *  nothing better names it. The lens clips again for its card; this only
 *  keeps a multi-kilobyte prompt out of the frame. */
const PROMPT_TASK_MAX = 120;

/** One `workflow_agent` line of a run's state file, as far as this module
 *  reads it: what to call the agent, and how the run says it ended. */
interface WfAgentEntry {
  agentId: string | null;
  label: string | null;
  promptPreview: string | null;
  /** The run's own word for this agent's lifecycle. Measured 2026-08-29 over
   *  the 536 state files in the store: 4,666 `done`, 211 `error`, 81
   *  `progress`, 25 `start` — so two of the four values are endings and two
   *  are not, and only an ending may close a card. */
  state: string | null;
}

/** A run's state file, as far as this module reads it. */
interface WfState {
  /** `workflowName`, else `summary` — what the run called itself. */
  name: string | null;
  agents: WfAgentEntry[];
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A run's state, or null for anything that is not a JSON object. Every field
 *  is optional: a state file written mid-run has fewer of them, and a missing
 *  one must degrade to "not known", never to a guess. */
function readRunState(json: string): WfState | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const d = parsed as Record<string, unknown>;
    const raw = Array.isArray(d.workflowProgress) ? d.workflowProgress : [];
    const agents: WfAgentEntry[] = [];
    for (const entry of raw) {
      const o = entry as Record<string, unknown> | null;
      if (o === null || typeof o !== "object" || o.type !== "workflow_agent") continue;
      agents.push({
        agentId: nonEmpty(o.agentId),
        label: nonEmpty(o.label),
        promptPreview: nonEmpty(o.promptPreview),
        state: nonEmpty(o.state),
      });
    }
    return { name: nonEmpty(d.workflowName) ?? nonEmpty(d.summary), agents };
  } catch {
    return null;
  }
}

/** A workflow run the SESSION named, joined to whatever state file came with it. */
interface ResolvedRun {
  /** The `Workflow` tool_use the receipt came back on — the run's identity on
   *  screen, and the parent every one of its agents hangs under. */
  workflowId: string;
  /** The tool_use's own stamp, so the run's node lands where the reader met it. */
  ts: number;
  /** What to call the run: its state file's name, else the receipt's Summary. */
  task: string;
  /** How the transcript says the run ENDED, and when — off the notification
   *  the launch's own tool_result carries. Null for a run still out there
   *  when the session file stops, which is a real state and not a gap. */
  end: { ts: number; state: "completed" | "failed" } | null;
  state: WfState | null;
}

/**
 * How a launch's output says it ended, or null while it does not say.
 *
 * Last header wins: a monitor reports many times and the newest word is the
 * one that stands. "no result by the end of the transcript" is the importer's
 * own marker for a launch that never settled — it is the ABSENCE of an
 * ending, not one. Everything that is not `completed` reads as failed, so a
 * `killed` run (37 of the 536 state files in the store, measured 2026-08-29)
 * still ends rather than running forever.
 */
function lastOutcome(output: string): "completed" | "failed" | null {
  let out: "completed" | "failed" | null = null;
  RECEIPT_OUTCOME.lastIndex = 0;
  for (let m = RECEIPT_OUTCOME.exec(output); m !== null; m = RECEIPT_OUTCOME.exec(output)) {
    const said = (m[2] ?? "").trim();
    out = said === "" || said.startsWith("no result") ? null : said === "completed" ? "completed" : "failed";
  }
  return out;
}

/**
 * Which workflow runs this session actually launched.
 *
 * The join key is the RUN, and the session prints it exactly once — in the
 * receipt the `Workflow` tool_use returned. First receipt wins: a later line
 * quoting the same run id is a line about the same run either way, and taking
 * the first keeps the resolution independent of how far the reader scrolled.
 */
function resolveRuns(sessionStream: Sourced[], states: RunStateText[]): Map<string, ResolvedRun> {
  const receipts = new Map<string, { callId: string; ts: number; summary: string | null }>();
  const callTs = new Map<string, number>();
  /** callId -> the last ending its results reported, and when. */
  const endings = new Map<string, { ts: number; state: "completed" | "failed" }>();
  for (const { ev } of sessionStream) {
    const f = shape(ev);
    if (f.type === "tool_call" && typeof f.callId === "string") {
      if (!callTs.has(f.callId)) callTs.set(f.callId, f.ts ?? 0);
      continue;
    }
    if (f.type !== "tool_result" || typeof f.output !== "string" || typeof f.callId !== "string") continue;
    // The ending is read from EVERY result of the call, not only the first
    // one: the receipt goes out at the launch and the outcome arrives on a
    // later result for the same callId, carrying the stamp of when it landed.
    const ended = lastOutcome(f.output);
    if (ended !== null) endings.set(f.callId, { ts: f.ts ?? 0, state: ended });
    const named = RECEIPT_RUN_ID.exec(f.output);
    if (named === null || receipts.has(named[1])) continue;
    receipts.set(named[1], {
      callId: f.callId,
      ts: f.ts ?? 0,
      summary: RECEIPT_SUMMARY.exec(f.output)?.[1]?.trim() ?? null,
    });
  }
  const stateOf = new Map<string, WfState | null>();
  for (const s of states) if (!stateOf.has(s.runId)) stateOf.set(s.runId, readRunState(s.json));
  const out = new Map<string, ResolvedRun>();
  for (const [runId, hit] of receipts) {
    const state = stateOf.get(runId) ?? null;
    out.set(runId, {
      workflowId: hit.callId,
      // The tool_use's stamp where the stream carried one; the receipt's
      // otherwise, which is the next-earliest honest point.
      ts: callTs.get(hit.callId) ?? hit.ts,
      task: state?.name ?? hit.summary ?? runId,
      end: endings.get(hit.callId) ?? null,
      state,
    });
  }
  return out;
}

/**
 * The run's own line about one of its children, in a fixed precedence, each
 * step honest about where it came from. The label AND the ending come from
 * that one line, so a card cannot end up named by one entry and closed by
 * another.
 *
 * 1. the state file's `label` for exactly this agent id — the exact answer.
 *    Measured 2026-08-29: 76 of 76 agents in one session, 4,956 of 5,521 over
 *    the whole store.
 * 2. the state file's `promptPreview`, whole, as a prefix of the child's own
 *    first prompt — for a superseded attempt, whose transcript is on disk
 *    under an id the state file no longer names. The WHOLE preview and a
 *    UNIQUE label, because a run's agents routinely share hundreds of leading
 *    characters: measured over the 565 agents rule 1 missed, a 400-character
 *    preview matched 36 uniquely and 134 ambiguously, and a short prefix would
 *    have handed those 134 somebody else's name.
 * 3. the child's own prompt, trimmed and clipped — the fallback for a live run
 *    whose state file is not written yet. 395 of those 565. Trimmed because a
 *    real prompt opens on a blank line often enough that the card did:
 *    measured against a session whose two newest runs had no state file, every
 *    label there began "\nCONTEXT — …".
 */
function entryForChild(state: WfState | null, agentId: string, prompt: string): WfAgentEntry | null {
  const exact = state?.agents.find((a) => a.agentId === agentId) ?? null;
  if (exact !== null && exact.label !== null) return exact;
  if (state !== null && prompt !== "") {
    const hits = state.agents.filter(
      (a) =>
        a.label !== null &&
        a.promptPreview !== null &&
        prompt.startsWith(a.promptPreview.replace(/\u2026\s*$/, "")),
    );
    if (new Set(hits.map((h) => h.label)).size === 1) return hits[0];
  }
  return exact;
}

/** The label itself: the entry's when one was found, the child's own prompt
 *  otherwise — rule 3, trimmed and clipped. */
function labelForChild(entry: WfAgentEntry | null, prompt: string): string {
  return entry?.label ?? clipMiddle(prompt.trim(), PROMPT_TASK_MAX);
}

/**
 * How the run says one of its agents ended, or null while it does not say.
 *
 * Without this every merged child works forever: the session stream never
 * spawned it, so nothing in it can end it either. Measured 2026-08-29 over one
 * real session, driving the importer and `foldWork` over the files on disk:
 * 462 agents merged, 462 of them stuck at working.
 */
function endOfChild(entry: WfAgentEntry | null): "completed" | "failed" | null {
  if (entry === null) return null;
  if (entry.state === "done") return "completed";
  return entry.state === "error" ? "failed" : null;
}

/** The file's own opening prompt, off the root run_start the importer built
 *  for it. "" when the file opened with something else. */
function promptOf(events: RunEvent[]): string {
  for (const ev of events) {
    const f = shape(ev);
    if (f.type === "run_start") return f.prompt ?? "";
  }
  return "";
}

/** The meta's `agentType`, which is the only readable kind a workflow child
 *  has ("workflow-subagent"). Null for a meta that names none. */
function metaAgentType(metaJson: string): string | null {
  try {
    const meta = JSON.parse(metaJson) as unknown;
    if (meta === null || typeof meta !== "object") return null;
    return nonEmpty((meta as { agentType?: unknown }).agentType);
  } catch {
    return null;
  }
}

/**
 * K-way merge by timestamp, session stream first on a tie.
 *
 * A merge, not a sort, on purpose: each input stream keeps its own order
 * unconditionally, whatever its stamps do — so the session's events can never
 * be reordered against each other, which is what keeps the zero-sidecar case
 * byte-identical to today's import. Ties go to the earliest stream, which
 * puts a child's first frame after the spawn that announced it when both
 * carry the same stamp.
 */
function mergeByTs(streams: Sourced[][]): Sourced[] {
  const heads = streams.map(() => 0);
  const total = streams.reduce((n, s) => n + s.length, 0);
  const out: Sourced[] = [];
  while (out.length < total) {
    let pick = -1;
    let pickTs = Infinity;
    for (let s = 0; s < streams.length; s++) {
      if (heads[s] >= streams[s].length) continue;
      const ts = shape(streams[s][heads[s]].ev).ts ?? 0;
      if (ts < pickTs) {
        pick = s;
        pickTs = ts;
      }
    }
    out.push(streams[pick][heads[pick]]);
    heads[pick]++;
  }
  return out;
}

/**
 * The session stream plus its sidecars, as one run.
 *
 * @param input the texts, already read — this module does no IO
 * @return the merged events, the session file as the source, the recorded
 *         workspace, and the honest child counts
 */
export function importClaudeCodeRun(input: {
  sessionText: string;
  sidecars: SidecarText[];
  /** Card 297: each workflow run's own state file, when the pick carried one. */
  runStates?: RunStateText[];
}): ClaudeCodeRunImport {
  const session = detectAndLoad(input.sessionText);
  const sessionStream: Sourced[] = session.events.map((ev, i) => ({
    ev,
    origin: session.source.origin[i],
  }));

  // The join keys the session actually spawned: `agent_spawn.agentId` IS the
  // Task's tool_use id in the importer's own output, so the importer's
  // reading — not a second scan of the records — is the authority. The spawn's
  // parentId comes along because it is the child run_start's parentId after
  // the re-key: the spawner, exactly as the in-file sidechain path writes it.
  const spawned = new Map<string, { ts: number; parentId: string }>();
  for (const { ev } of sessionStream) {
    const f = shape(ev);
    if (f.type === "agent_spawn" && typeof f.agentId === "string")
      spawned.set(f.agentId, { ts: f.ts ?? 0, parentId: f.parentId ?? "main" });
  }

  let childrenSkipped = 0;
  const mergedIds: string[] = [];
  const childStreams: Sourced[][] = [];
  // A session that is not a Claude Code transcript has no subagents/ layout;
  // every sidecar beside it is unjoinable and says so in the count.
  const joinable = session.kind === "claude-code";

  // The session's own root, the parent a workflow node hangs under. Read the
  // same way the lens reads it — the first run_start reporting no parent.
  let sessionRoot = "main";
  for (const { ev } of sessionStream) {
    const f = shape(ev);
    if (f.type === "run_start" && f.parentId === undefined) {
      sessionRoot = f.agentId ?? "main";
      break;
    }
  }

  // Card 297: the workflow runs this session launched, by run id.
  const runs = joinable ? resolveRuns(sessionStream, input.runStates ?? []) : new Map<string, ResolvedRun>();
  /** Per run, the children that actually made it in — the other half of the
   *  unrecorded count, and what decides whether a run gets a node at all. */
  const mergedPerRun = new Map<string, Set<string>>();
  const skippedPerRun = new Map<string, number>();
  /** The frames the merge synthesizes for the runs and their children. */
  const wfChildren: {
    runId: string;
    childId: string;
    ts: number;
    endTs: number;
    end: "completed" | "failed" | null;
    task: string;
    kind: string | null;
  }[] = [];

  for (const side of input.sidecars) {
    const metaId = joinable ? metaToolUseId(side.metaJson) : null;
    // BRANCH A, unchanged: the meta names the tool_use the spawn rode in on,
    // and the session spawned the child under exactly that id.
    const toolUseId = metaId !== null && spawned.has(metaId) ? metaId : null;
    // BRANCH B: no toolUseId anywhere in the meta — the run directory is the
    // whole attribution, and the session named that run once, in the receipt.
    const run = toolUseId === null && side.runId !== undefined ? runs.get(side.runId) : undefined;
    const countSkip = (): void => {
      childrenSkipped++;
      if (run !== undefined && side.runId !== undefined)
        skippedPerRun.set(side.runId, (skippedPerRun.get(side.runId) ?? 0) + 1);
    };
    if (toolUseId === null && run === undefined) {
      childrenSkipped++;
      continue;
    }
    let records: unknown[];
    try {
      records = parseJsonl(side.jsonlText);
    } catch {
      countSkip();
      continue;
    }
    // The shape rule decides what the file is, exactly as on a lone import: a
    // file that is not wholly one agent's transcript must not be reparented
    // under a Task. The base parameter is the spawn's stamp, so a sidecar
    // whose records carry no timestamps at all ladders from its own spawn
    // instead of from the importer's default epoch (measured: `stampRecords`
    // reads the base only when no record in the file is dated).
    const transcript = readSubagentTranscript(records);
    if (transcript === null) {
      countSkip();
      continue;
    }
    // Where the child hangs, and from when. A Task child ladders from its own
    // spawn; a workflow child from the tool_use its whole run rode in on.
    const join = toolUseId !== null ? spawned.get(toolUseId)! : { ts: run!.ts, parentId: run!.workflowId };
    const child = claudeCodeWithOrigin(records, join.ts);
    // THE RE-KEY (twin repair). The sidecar knows itself by its own hex
    // agentId; the session already spawned the same child under the Task
    // tool_use id — the importer's canon that "Task tool_use ids double as
    // the child agentIds". Left as two ids, every child is two agents: the
    // toolu one the result message ends, and a hex one working forever.
    // So every merged frame moves onto the identity the session knows. A
    // grandchild spawned INSIDE the sidecar keeps its own id — only values
    // equal to the sidecar's root id move, wherever an agent id can ride.
    const hexRoot = transcript.agentId;
    // A WORKFLOW child has no second identity to collapse onto: the run's
    // state file knows it by exactly the hex id its own file carries, so the
    // re-key below is the identity and the guard skips the copy.
    const childId = toolUseId ?? hexRoot;
    const rekey = (ev: RunEvent): RunEvent => {
      if (childId === hexRoot) return ev;
      const f = shape(ev);
      let patched: Record<string, unknown> | null = null;
      for (const k of ID_FIELDS)
        if (f[k] === hexRoot) {
          patched = patched ?? { ...(ev as object) };
          patched[k] = childId;
        }
      return patched === null ? ev : (patched as unknown as RunEvent);
    };
    const stream: Sourced[] = child.events.map((raw) => {
      const ev = rekey(raw);
      const f = shape(ev);
      // The file's own root run gets the in-file sidechain path's language:
      // runId `cc-<tool use id>`, parentId the SPAWNER — the same frame the
      // importer emits for a child it finds in the same file. That is the
      // join the single-file importer deliberately leaves open — the owner
      // lived in another file, and now that file is here.
      if (f.runId === ROOT_RUN_ID && (f.type === "run_start" || f.type === "run_end")) {
        const renamed = {
          ...(ev as object),
          runId: `cc-${childId}`,
          ...(f.type === "run_start" ? { parentId: join.parentId } : {}),
        };
        return { ev: renamed as RunEvent, origin: -1 };
      }
      return { ev, origin: -1 };
    });
    childStreams.push(stream);
    mergedIds.push(childId);
    if (run !== undefined && side.runId !== undefined) {
      const seen = mergedPerRun.get(side.runId);
      if (seen === undefined) mergedPerRun.set(side.runId, new Set([childId]));
      else seen.add(childId);
      const entry = entryForChild(run.state, childId, promptOf(child.events));
      wfChildren.push({
        runId: side.runId,
        childId,
        // The child's own first stamp, so its spawn lands immediately in front
        // of its run_start rather than back at the run's launch.
        ts: stream.length > 0 ? (shape(stream[0].ev).ts ?? run.ts) : run.ts,
        // Its own LAST stamp, which is where its transcript stops — the only
        // moment this import can honestly say it was last seen working.
        endTs: stream.length > 0 ? (shape(stream[stream.length - 1].ev).ts ?? run.ts) : run.ts,
        end: endOfChild(entry),
        task: labelForChild(entry, promptOf(child.events)),
        kind: metaAgentType(side.metaJson),
      });
    }
  }

  // The launch record's `usage` summarises the child's whole run. With the
  // child's own records merged in, the summary is the same money a second
  // time — the importer's `billedOwn` rule, applied across files. A SKIPPED
  // child keeps it: there, it is the only bill the stream holds.
  const merged = new Set(mergedIds);
  const dedupedSession = sessionStream.filter(({ ev }) => {
    const f = shape(ev);
    return !(f.type === "usage" && typeof f.agentId === "string" && merged.has(f.agentId));
  });

  // Card 297: the run itself becomes a node, and its agents hang under it.
  // Only a run that actually brought agents gets one — a lone workflow box
  // with nothing under it would be a claim about a run this import cannot
  // show. Everything here carries origin -1: it is the merge's own reading,
  // not a line of the session file.
  const synth: Sourced[] = [];
  const runNodes = new Set<string>();
  for (const c of wfChildren) {
    const run = runs.get(c.runId)!;
    if (!runNodes.has(c.runId)) {
      runNodes.add(c.runId);
      synth.push({
        ev: {
          type: "agent_spawn",
          agentId: run.workflowId,
          parentId: sessionRoot,
          task: run.task,
          ts: run.ts,
        },
        origin: -1,
      });
      synth.push({
        ev: {
          type: "agent_message",
          from: sessionRoot,
          to: run.workflowId,
          role: "task",
          state: "submitted",
          text: run.task,
          label: "workflow",
          ts: run.ts,
        },
        origin: -1,
      });
      // AND the frame that ends it. A node that is spawned and never closed
      // reads "still running" for as long as the import is on screen, and it
      // drags the run's drawn lifetime down to its last child spawn — under
      // "position carries time" that put two runs which genuinely overlapped
      // in different waves. The text is empty on purpose: the run's answer is
      // the receipt the session already carries, and repeating it here would
      // print it twice.
      if (run.end !== null)
        synth.push({
          ev: {
            type: "agent_message",
            from: run.workflowId,
            to: sessionRoot,
            role: "result",
            state: run.end.state,
            text: "",
            ts: run.end.ts,
          },
          origin: -1,
        });
    }
    synth.push({
      ev: {
        type: "agent_spawn",
        agentId: c.childId,
        parentId: run.workflowId,
        task: c.task,
        ts: c.ts,
      },
      origin: -1,
    });
    synth.push({
      ev: {
        type: "agent_message",
        from: run.workflowId,
        to: c.childId,
        role: "task",
        state: "submitted",
        text: c.task,
        ...(c.kind !== null ? { label: c.kind } : {}),
        ts: c.ts,
      },
      origin: -1,
    });
    // What ends the child. Nothing in the session stream can: it never
    // spawned this agent, so it never receives its result either. The run's
    // own state file is the only record of how it went, and a value that is
    // not an ending (`progress`, `start`) leaves the card open, because it
    // was.
    if (c.end !== null)
      synth.push({
        ev: {
          type: "agent_message",
          from: c.childId,
          to: run.workflowId,
          role: "result",
          state: c.end,
          text: "",
          ts: c.endTs,
        },
        origin: -1,
      });
  }
  // The merge below keeps each stream's order unconditionally, so this one
  // has to BE in order. A stable sort keeps a run's two frames in front of
  // the children that share their stamp.
  synth.sort((a, b) => (shape(a.ev).ts ?? 0) - (shape(b.ev).ts ?? 0));

  // What a run's state file named and no transcript recorded. The skips of
  // that same run come off first: a sidecar that WAS there and could not be
  // read is already counted once, and must not be counted twice.
  let childrenUnrecorded = 0;
  for (const [runId, run] of runs) {
    if (run.state === null || !runNodes.has(runId)) continue;
    const here = mergedPerRun.get(runId) ?? new Set<string>();
    const named = run.state.agents.filter(
      (a) => a.agentId !== null && a.label !== null && !here.has(a.agentId),
    ).length;
    childrenUnrecorded += Math.max(0, named - (skippedPerRun.get(runId) ?? 0));
  }

  // Card 302: the phases the runs declared before they ran. Only for a run
  // that actually got a node — a declaration about a run nothing drew would
  // rank agents that are not on screen.
  const declared = new Map<string, RunPhases>();
  for (const [runId, run] of runs) {
    if (!runNodes.has(runId)) continue;
    const raw = (input.runStates ?? []).find((s) => s.runId === runId);
    if (raw === undefined) continue;
    const parsed = readWorkflowState(raw.json);
    // No `phases` array is a run that declared nothing, not a run that
    // declared zero phases. It must not arrive looking declared.
    if (parsed === null || parsed.phases.length === 0) continue;
    declared.set(run.workflowId, declarationFor(parsed));
  }

  const all = mergeByTs([dedupedSession, synth, ...childStreams]);
  const events = all.map((s) => s.ev);
  const origin = Int32Array.from(all.map((s) => s.origin));

  // The recorded workspace: the first `ground_info` frame's cwd — the
  // importer's own reading of "the first record carrying cwd" — session
  // first, then the merged children in order.
  let workspace: string | null = null;
  for (const stream of [sessionStream, ...childStreams]) {
    for (const { ev } of stream) {
      const f = shape(ev);
      if (f.type === "ground_info" && typeof f.cwd === "string" && f.cwd !== "") {
        workspace = f.cwd;
        break;
      }
    }
    if (workspace !== null) break;
  }

  return {
    events,
    kind: session.kind,
    ...(session.subagent !== undefined ? { subagent: session.subagent } : {}),
    source: { lines: session.source.lines, origin },
    workspace,
    childrenMerged: mergedIds.length,
    childrenSkipped,
    childrenUnrecorded,
    declared,
  };
}

// ---- grouping a picked selection ----------------------------------------

/** A picked file as far as the grouping reads it: names only, no bytes. */
export interface PickedFile {
  name: string;
  /** `webkitRelativePath` on a directory pick, "" on a plain multi-select. */
  relativePath: string;
}

/** One picked sidecar: the two file indices, plus the workflow run whose
 *  directory it sat in (null for a direct `Task` spawn). */
export interface PickedSidecar {
  jsonl: number;
  meta: number | null;
  runId: string | null;
}

/** What a selection is. Indices point into the caller's own file list. */
export type PickedGroup =
  | { kind: "single"; session: number }
  | {
      kind: "run";
      session: number;
      sidecars: PickedSidecar[];
      /** Each workflow run's own state file, `workflows/<runId>.json`. */
      runStates: { runId: string; file: number }[];
    }
  | { kind: "none" };

const SIDECAR_NAME = /^agent-(.+)\.jsonl$/;
const META_NAME = /^agent-(.+)\.meta\.json$/;
/** A workflow run's agents sit in their own directory beside the session
 *  (card 297, measured 2026-08-29 over a real project folder). */
const SIDECAR_RUN_PATH = /(?:^|\/)subagents\/workflows\/(wf_[^/]+)\//;
/** The log a workflow run writes for ITSELF, next to its agents. It is a
 *  `.jsonl` and it is not a session — which is the whole reason the rule is
 *  the PATH and not the name: a `journal.jsonl` anywhere else stays a
 *  candidate, and a folder with 12 runs used to offer 13 of them and fail. */
const JOURNAL_PATH = /(?:^|\/)subagents\/workflows\/wf_[^/]+\/journal\.jsonl$/;
/** A run's recorded state: `<session>/workflows/<runId>.json`. The agents'
 *  directory is `<session>/subagents/workflows/<runId>/`, so no path can be
 *  read as both. */
const WF_STATE_PATH = /(?:^|\/)workflows\/(wf_[^/]+)\.json$/;

/**
 * What a picked selection holds.
 *
 * ONE file is always "single" — today's path, byte for byte, whatever the
 * file is named: the shape rule inside the importer decides what a lone file
 * is (card 152), never a filename here. Names only START mattering when
 * several files arrive together, because pairing `agent-<id>.jsonl` with
 * `agent-<id>.meta.json` is a statement about the directory layout, which is
 * exactly what a directory pick hands over.
 */
export function groupPickedFiles(files: PickedFile[]): PickedGroup {
  if (files.length === 1) {
    return { kind: "single", session: 0 };
  }
  const sessions: number[] = [];
  // Keyed by run AND agent: two runs are free to file an agent under the same
  // hex id, and a key that forgot the directory would silently drop one.
  const sidecarByAgent = new Map<string, { index: number; runId: string | null }>();
  const metaByAgent = new Map<string, number>();
  const runStates: { runId: string; file: number }[] = [];
  files.forEach((f, i) => {
    const runId = SIDECAR_RUN_PATH.exec(f.relativePath)?.[1] ?? null;
    const key = (agent: string): string => `${runId ?? ""}/${agent}`;
    if (JOURNAL_PATH.test(f.relativePath)) return;
    const sidecar = SIDECAR_NAME.exec(f.name);
    if (sidecar !== null) {
      if (!sidecarByAgent.has(key(sidecar[1]))) sidecarByAgent.set(key(sidecar[1]), { index: i, runId });
      return;
    }
    const meta = META_NAME.exec(f.name);
    if (meta !== null) {
      if (!metaByAgent.has(key(meta[1]))) metaByAgent.set(key(meta[1]), i);
      return;
    }
    const state = WF_STATE_PATH.exec(f.relativePath);
    if (state !== null) {
      runStates.push({ runId: state[1], file: i });
      return;
    }
    if (f.name.endsWith(".jsonl")) sessions.push(i);
  });
  // No session, or two: nothing to load rather than a coin toss.
  if (sessions.length !== 1) return { kind: "none" };
  const sidecars = [...sidecarByAgent.entries()].map(([agentKey, { index, runId }]) => ({
    jsonl: index,
    meta: metaByAgent.get(agentKey) ?? null,
    runId,
  }));
  return { kind: "run", session: sessions[0], sidecars, runStates };
}
