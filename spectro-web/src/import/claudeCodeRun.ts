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

/** One child's two files, already read to text. The meta arrives as raw text
 *  because reading it is this module's job — a caller that parsed it would
 *  already have decided what a malformed one means. */
export interface SidecarText {
  jsonlText: string;
  metaJson: string;
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

  for (const side of input.sidecars) {
    const toolUseId = joinable ? metaToolUseId(side.metaJson) : null;
    if (toolUseId === null || !spawned.has(toolUseId)) {
      childrenSkipped++;
      continue;
    }
    let records: unknown[];
    try {
      records = parseJsonl(side.jsonlText);
    } catch {
      childrenSkipped++;
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
      childrenSkipped++;
      continue;
    }
    const join = spawned.get(toolUseId)!;
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
    const rekey = (ev: RunEvent): RunEvent => {
      const f = shape(ev);
      let patched: Record<string, unknown> | null = null;
      for (const k of ID_FIELDS)
        if (f[k] === hexRoot) {
          patched = patched ?? { ...(ev as object) };
          patched[k] = toolUseId;
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
          runId: `cc-${toolUseId}`,
          ...(f.type === "run_start" ? { parentId: join.parentId } : {}),
        };
        return { ev: renamed as RunEvent, origin: -1 };
      }
      return { ev, origin: -1 };
    });
    childStreams.push(stream);
    mergedIds.push(toolUseId);
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

  const all = mergeByTs([dedupedSession, ...childStreams]);
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
