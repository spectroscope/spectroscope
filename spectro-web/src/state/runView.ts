// Card 586: the runs of a session for the run view beside the chat, folded
// from run_step lines and from the events of each step's agents. Pure: a
// change returns new arrays and objects, and an event that changes nothing
// returns the array it was given, which the reducer compares to keep its
// state as it was.

import type { RunEvent } from "../events";
import { CC_DISK_WRITE, ROOT_AGENT, SHELL_TOOLS } from "../lab/labScene";

type RunStepLine = Extract<RunEvent, { type: "run_step" }>;

export type EntryStatus = "running" | "waiting" | "done" | "failed" | "stopped";
export type NodeStatus = EntryStatus | "pending" | "skipped";
/** A document a step wrote, by its path in the workspace. */
export interface RunDoc {
  doc: string;
  path: string;
  change?: "created" | "changed";
}
/** A document a step is told to read. It has no path when its location is not
 *  a file inside the workspace; then only its name is known. */
export interface RunRead {
  doc: string;
  path?: string;
}
export interface RunFile {
  path: string;
  change: "created" | "changed" | "unchanged" | "unknown";
}
export interface RunEntry {
  key: string; // `${runId}:${node}:${entry}`
  runId: string;
  node: string;
  name: string;
  kind: string;
  entry: number;
  status: EntryStatus;
  startedTs: number;
  endedTs: number | null;
  durationMs: number | null;
  performer: "chat" | "child" | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  picked: boolean;
  agents: string[]; // "main" for a chat step; the child and its descendants for a child step
  input: string | null;
  inputChars: number | null;
  reads: RunRead[];
  round: number | null;
  maxRounds: number | null;
  output: string | null;
  outputChars: number | null;
  documents: RunDoc[];
  files: RunFile[];
  shellCalls: number;
  liveLine: string | null;
  /** Per agent of the entry, the last 2,000 characters it streamed while the
   *  entry was open. liveLine is the last non-empty line of the agent that
   *  streamed last; while that agent has none yet, the line shown stays. */
  liveText: Record<string, string>;
  /** The file tool calls of the entry's agents that wait for their result:
   *  call id to path. */
  fileCalls: Record<string, string>;
  label: string | null;
  error: string | null;
  children: string[];
}
export interface RunTrack {
  runId: string;
  kind: "playbook" | "workflow";
  name: string;
  task: string | null;
  nodes: { id: string; name: string; kind: string }[];
  startedTs: number;
  endedTs: number | null;
  durationMs: number | null;
  stopReason: string | null;
  result: string | null;
  detail: string | null;
  /** The call id of a question the run asked while none of its entries was
   *  open: the model question of a step comes before the step's start. Null
   *  otherwise. The answer to it, the next step_start and the run's end clear
   *  it. */
  waitingOn: string | null;
  entries: RunEntry[];
  /** Final fix round (review I4): true for a run without run_end in a history
   *  that was loaded, as a stored view or as the start of a continued session.
   *  It will not end any more: it joins no later event and does not tick. */
  cut?: boolean;
}
/** How a run ended, read from its run_end alone; "running" while none came. */
export type RunOutcome = "running" | "done" | "stopped" | "failed";

/** How much of the streamed text an entry keeps to find its live line. */
const LIVE_TEXT_MAX = 2_000;
/** The native file tools that write; the imported ones are the Lab's CC_DISK_WRITE. */
const NATIVE_FILE_WRITES: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

const isOpen = (entry: RunEntry): boolean => entry.status === "running" || entry.status === "waiting";

/**
 * Fold one event into the runs of a session.
 *
 * @param runs  the runs so far, oldest first
 * @param event any event of the session
 * @returns the runs; the same array when the event changes none of them
 */
export function foldRun(runs: RunTrack[], event: RunEvent): RunTrack[] {
  if (event.type === "run_step") return foldLine(runs, event);
  const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
  if (last === undefined || last.endedTs !== null || last.cut === true) return runs;
  const next = joinEvent(last, event);
  if (next === last) return runs;
  const out = runs.slice();
  out[out.length - 1] = next;
  return out;
}

function foldLine(runs: RunTrack[], line: RunStepLine): RunTrack[] {
  switch (line.phase) {
    case "run_start":
      return [...runs, openRun(line)];
    case "step_start":
      return patchRun(runs, line.runId, (run) => startEntry(run, line));
    case "step_end":
      return patchRun(runs, line.runId, (run) => endEntry(run, line));
    case "run_end":
      return patchRun(runs, line.runId, (run) => endRun(run, line));
    default:
      return runs;
  }
}

function openRun(line: RunStepLine): RunTrack {
  return {
    runId: line.runId,
    kind: line.runKind,
    name: line.name ?? "",
    task: line.task ?? null,
    nodes: (line.nodes ?? []).map((n) => ({ id: n.id, name: n.name ?? n.id, kind: n.kind })),
    startedTs: line.ts,
    endedTs: null,
    durationMs: null,
    stopReason: null,
    result: null,
    detail: null,
    waitingOn: null,
    entries: [],
  };
}

/** The latest run of that id, patched; the same array when the patch changes nothing. */
function patchRun(runs: RunTrack[], runId: string, patch: (run: RunTrack) => RunTrack): RunTrack[] {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].runId !== runId) continue;
    const next = patch(runs[i]);
    if (next === runs[i]) return runs;
    const out = runs.slice();
    out[i] = next;
    return out;
  }
  return runs;
}

function startEntry(run: RunTrack, line: RunStepLine): RunTrack {
  if (typeof line.node !== "string") return run;
  const entry = line.entry ?? 1;
  const opened: RunEntry = {
    key: `${run.runId}:${line.node}:${entry}`,
    runId: run.runId,
    node: line.node,
    name: line.name ?? line.node,
    kind: line.kind ?? "",
    entry,
    status: "running",
    startedTs: line.ts,
    endedTs: null,
    durationMs: null,
    performer: line.performer ?? null,
    role: line.role ?? null,
    provider: line.provider ?? null,
    model: line.model ?? null,
    picked: line.picked === true,
    agents: line.performer === "chat" ? [ROOT_AGENT] : [],
    input: line.input ?? null,
    inputChars: line.inputChars ?? null,
    reads: (line.reads ?? []).map((r) =>
      typeof r.path === "string" ? { doc: r.doc, path: r.path } : { doc: r.doc },
    ),
    round: line.round ?? null,
    maxRounds: line.maxRounds ?? null,
    output: null,
    outputChars: null,
    documents: [],
    files: [],
    shellCalls: 0,
    liveLine: null,
    liveText: {},
    fileCalls: {},
    label: null,
    error: null,
    children: [],
  };
  return { ...run, waitingOn: null, entries: [...run.entries, opened] };
}

/** Closes the entry the line names; a step_end without its step_start (a cut session) changes nothing. */
function endEntry(run: RunTrack, line: RunStepLine): RunTrack {
  const entry = line.entry ?? 1;
  let at = -1;
  for (let i = run.entries.length - 1; i >= 0 && at < 0; i--) {
    if (run.entries[i].node === line.node && run.entries[i].entry === entry) at = i;
  }
  if (at < 0) return run;
  const was = run.entries[at];
  const child = line.childId;
  const entries = run.entries.slice();
  entries[at] = {
    ...was,
    // A step_end always names its status; one without it did not report success.
    status: line.status ?? "failed",
    endedTs: line.ts,
    durationMs: line.durationMs ?? null,
    output: line.output ?? null,
    outputChars: line.outputChars ?? null,
    documents: (line.documents ?? []).map((d) => ({
      doc: d.doc,
      path: d.path,
      ...(d.change === undefined ? {} : { change: d.change }),
    })),
    label: line.label ?? null,
    error: line.error ?? null,
    round: line.round ?? was.round,
    maxRounds: line.maxRounds ?? was.maxRounds,
    children: line.children ?? was.children,
    agents: child !== undefined && !was.agents.includes(child) ? [...was.agents, child] : was.agents,
  };
  return { ...run, entries };
}

function endRun(run: RunTrack, line: RunStepLine): RunTrack {
  return {
    ...run,
    endedTs: line.ts,
    durationMs: line.durationMs ?? null,
    stopReason: line.stopReason ?? null,
    result: line.result ?? null,
    detail: line.detail ?? null,
    waitingOn: null,
    entries: run.entries.map((entry) =>
      isOpen(entry) ? { ...entry, status: "stopped" as const, endedTs: line.ts } : entry,
    ),
  };
}

/** Every open entry of the run, patched; the same run when no entry changed. */
function patchOpen(run: RunTrack, patch: (entry: RunEntry) => RunEntry): RunTrack {
  let entries: RunEntry[] | null = null;
  for (let i = 0; i < run.entries.length; i++) {
    const entry = run.entries[i];
    if (!isOpen(entry)) continue;
    const next = patch(entry);
    if (next === entry) continue;
    if (entries === null) entries = run.entries.slice();
    entries[i] = next;
  }
  return entries === null ? run : { ...run, entries };
}

/** What an event of the session does to the last run and its open entries. */
function joinEvent(run: RunTrack, event: RunEvent): RunTrack {
  switch (event.type) {
    case "agent_message": {
      if (event.role !== "task") return run;
      const label = event.label;
      if (label === undefined) {
        // A helper the run's main agent hands a task without a label is one of
        // a fan-out's children (spawn_agents): the main agent runs no turn of
        // its own while a fan-out is open.
        if (event.from !== ROOT_AGENT) return run;
        return patchOpen(run, (entry) =>
          entry.kind === "fanout" ? withAgent(entry, event.to, true) : entry,
        );
      }
      return patchOpen(run, (entry) =>
        label === `${run.kind}:${entry.node}` ? withAgent(entry, event.to, false) : entry,
      );
    }
    case "agent_spawn":
      return patchOpen(run, (entry) =>
        entry.agents.includes(event.parentId)
          ? withAgent(entry, event.agentId, entry.kind === "fanout")
          : entry,
      );
    case "tool_call": {
      if (SHELL_TOOLS.has(event.name)) {
        return patchOpen(run, (entry) =>
          entry.agents.includes(event.agentId) ? { ...entry, shellCalls: entry.shellCalls + 1 } : entry,
        );
      }
      const path =
        NATIVE_FILE_WRITES.has(event.name) || CC_DISK_WRITE.has(event.name) ? pathOf(event.input) : null;
      if (path === null) return run;
      return patchOpen(run, (entry) =>
        entry.agents.includes(event.agentId) && entry.fileCalls[event.callId] !== path
          ? { ...entry, fileCalls: { ...entry.fileCalls, [event.callId]: path } }
          : entry,
      );
    }
    case "tool_result":
      return patchOpen(run, (entry) => {
        if (!Object.hasOwn(entry.fileCalls, event.callId)) return entry;
        const { [event.callId]: path, ...fileCalls } = entry.fileCalls;
        if (event.isError) return { ...entry, fileCalls };
        return { ...entry, fileCalls, files: withFile(entry.files, path, changeOf(event.fileChange)) };
      });
    case "text_delta":
      return patchOpen(run, (entry) => {
        if (event.text === "" || !entry.agents.includes(event.agentId)) return entry;
        const own = tail((entry.liveText[event.agentId] ?? "") + event.text, LIVE_TEXT_MAX);
        const liveText = { ...entry.liveText, [event.agentId]: own };
        return { ...entry, liveText, liveLine: lastLine(own) ?? entry.liveLine };
      });
    case "question_asked": {
      if (!ofRun(run, event.callId)) return run;
      // Inside an open entry the entry waits; with none open the run does.
      if (run.entries.some(isOpen)) {
        return patchOpen(run, (entry) =>
          entry.status === "running" ? { ...entry, status: "waiting" } : entry,
        );
      }
      return run.waitingOn === event.callId ? run : { ...run, waitingOn: event.callId };
    }
    case "question_answered": {
      if (!ofRun(run, event.callId)) return run;
      const next = patchOpen(run, (entry) =>
        entry.status === "waiting" ? { ...entry, status: "running" } : entry,
      );
      return next.waitingOn === event.callId ? { ...next, waitingOn: null } : next;
    }
    default:
      return run;
  }
}

/** Whether a question's call id is one the run itself asked: `pb-<runId>-<n>`. */
function ofRun(run: RunTrack, callId: unknown): boolean {
  return typeof callId === "string" && callId.startsWith(`pb-${run.runId}-`);
}

/** The entry with the agent among its agents, and among its children when `child` says so. */
function withAgent(entry: RunEntry, agentId: string, child: boolean): RunEntry {
  if (entry.agents.includes(agentId)) return entry;
  return {
    ...entry,
    agents: [...entry.agents, agentId],
    ...(child ? { children: [...entry.children, agentId] } : {}),
  };
}

/** The path a file tool writes: `path` for the native tools, `file_path` for the imported ones. */
function pathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const fields = input as Record<string, unknown>;
  const path = typeof fields.path === "string" ? fields.path : fields.file_path;
  return typeof path === "string" && path.trim() !== "" ? path : null;
}

function changeOf(fileChange: string | undefined): RunFile["change"] {
  return fileChange === "created" || fileChange === "changed" || fileChange === "unchanged"
    ? fileChange
    : "unknown";
}

/** The files with this result: a new row for a new path, else the row updated, where created stays. */
function withFile(files: RunFile[], path: string, change: RunFile["change"]): RunFile[] {
  const at = files.findIndex((f) => f.path === path);
  if (at < 0) return [...files, { path, change }];
  if (files[at].change === "created" || files[at].change === change) return files;
  const out = files.slice();
  out[at] = { path, change };
  return out;
}

/** The last `max` UTF-16 units of `text`, never starting with the low half of a surrogate pair. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const from = text.length - max;
  const first = text.charCodeAt(from);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? from + 1 : from);
}

/** The last line of the text that holds more than blanks, without its trailing blanks; null when none does. */
function lastLine(text: string): string | null {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1);
    const line = text.slice(start + 1, end);
    if (line.trim() !== "") return line.trimEnd();
    end = start;
  }
  return null;
}

/**
 * Each node of the run's forward path with the status of its latest entry. A
 * node without an entry is skipped once the run has ended, else pending.
 */
export function nodeStatuses(run: RunTrack): Record<string, NodeStatus> {
  const latest = new Map<string, EntryStatus>();
  for (const entry of run.entries) latest.set(entry.node, entry.status);
  const out: Record<string, NodeStatus> = {};
  for (const node of run.nodes) {
    out[node.id] = latest.get(node.id) ?? (run.endedTs === null ? "pending" : "skipped");
  }
  return out;
}

/** The last open entry (running or waiting), else the last entry, else null. */
export function currentEntry(run: RunTrack): RunEntry | null {
  for (let i = run.entries.length - 1; i >= 0; i--) {
    if (isOpen(run.entries[i])) return run.entries[i];
  }
  return run.entries.length > 0 ? run.entries[run.entries.length - 1] : null;
}

/** The key of the last run's running chat entry, else null. */
export function runningChatEntryKey(runs: RunTrack[]): string | null {
  const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
  if (last === undefined) return null;
  for (let i = last.entries.length - 1; i >= 0; i--) {
    const entry = last.entries[i];
    if (entry.performer === "chat" && entry.status === "running") return entry.key;
  }
  return null;
}

/** True for a run without a run_end that will not end any more: the session is not live, or the run was cut. */
export function isUnfinished(run: RunTrack, live: boolean): boolean {
  return run.endedTs === null && (!live || run.cut === true);
}

/** Whether a clock ticks for the runs: a live session holds a run that is still running. */
export function runsTick(runs: RunTrack[], live: boolean): boolean {
  return live && runs.some((run) => run.endedTs === null && run.cut !== true);
}

/**
 * Cuts the runs a loaded history left without a run_end (review I4). The
 * operator quit the app or the server stopped during the run, so it will not
 * end: a cut run joins none of the session's later turns.
 *
 * @param runs the runs of the history, oldest first
 * @returns the runs; the same array when none is open
 */
export function cutOpenRuns(runs: RunTrack[]): RunTrack[] {
  if (!runs.some((run) => run.endedTs === null && run.cut !== true)) return runs;
  return runs.map((run) => (run.endedTs === null && run.cut !== true ? { ...run, cut: true } : run));
}

/**
 * How the run ended, from its run_end's stop reason only, never from its last
 * entry: a Stop during a question closes the entry as stopped while the run
 * ends with the reason of the question, such as model_unavailable.
 */
export function runOutcome(run: RunTrack): RunOutcome {
  if (run.endedTs === null) return "running";
  if (run.stopReason === "done") return "done";
  if (run.stopReason === "aborted") return "stopped";
  return "failed";
}
