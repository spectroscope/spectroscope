// Card 604: the fold of the files tab. One pass over a session's events turns
// every tool call that touched files into a FileCall with its touches. The
// explorer rows and the summary line are read from that ledger, and so is the
// digest a model reads. Section 1 of the design document
// (docs/superpowers/specs/2026-11-09-files-tab-design.md) is the authority;
// C11 to C18 of the plan's global constraints settle the open points.

import { describeTool, fileChange, type ToolView } from "../components/toolViews";
import { TITLE_AGENT_ID, type RunEvent } from "../events";
import { shortenPath } from "../lab/fileTree";
import { elapsedAt } from "../state/stepper";
import { isRooted, resolvePath } from "./paths";
import { shellTouches, type ShellTouch, type TouchKind } from "./shell";

/** Who says the file was touched: a file tool, the shell heuristic, a model. */
export type Source = "recorded" | "probable" | "model";

export interface FileTouch extends ShellTouch {
  sources: Source[]; // non-empty; "recorded" never shares with another
  callIndex: number; // index of the tool_call in the event list
  agentId: string;
  t: number | null; // seconds from the first event (C12)
}

export interface FileCall {
  callIndex: number;
  agentId: string;
  t: number | null;
  tool: string;
  line: string; // path or full command, one line
  status: "ok" | "failed" | "pending";
  shell: boolean;
  output: string | null; // shell calls only, for the digest
  base: string | null; // the folder relative paths of this call resolve against (C13)
  script: string | null;
  inline: boolean;
  note: string | null; // "no change" for an unchanged write, "no file named" for a shell call without touches
  touches: FileTouch[];
}

export interface PromptMark {
  eventIndex: number;
  t: number | null;
  n: number;
  text: string;
}

export interface FileLedger {
  calls: FileCall[];
  prompts: PromptMark[];
  workspace: string | null;
  timed: boolean;
}

export interface FileRow {
  path: string;
  label: string; // shortenPath(path, workspace)
  group: "changed" | "read";
  letter: "A" | "M" | "D" | "?" | "R";
  sources: Source[]; // union over the row's touches
  firstT: number | null;
  firstCall: number;
  touches: FileTouch[];
}

export interface FilesSummary {
  recordedChanged: number;
  probableChanged: number;
  onlyRead: number;
  shellCalls: number;
  unknownScripts: number;
}

/** The kinds that say a file's content or existence moved. */
const CHANGES: ReadonlySet<TouchKind> = new Set([
  "create",
  "change",
  "overwrite",
  "write",
  "append",
  "delete",
]);
const SOURCE_ORDER: readonly Source[] = ["recorded", "probable", "model"];
const PENDING = " (no result yet)";

/** A tool call while the pass is still running: its result may come later. */
interface Open {
  callIndex: number;
  agentId: string;
  name: string;
  input: unknown;
  base: string | null;
  t: number | null;
  result: { output: string; isError: boolean; fileChange: string | undefined } | null;
}

/** What one call says about files, before the call's index, agent and time are stamped on. */
interface Reading {
  line: string;
  shell: boolean;
  output: string | null;
  script: string | null;
  inline: boolean;
  note: string | null;
  touches: (ShellTouch & { sources: Source[] })[];
}

/**
 * Folds a session's events into its file calls and prompt marks.
 *
 * One pass: a result pairs with the latest unpaired call of the same agent and
 * call id through a map of stacks, so the cost stays linear in the events.
 */
export function foldFiles(events: readonly RunEvent[]): FileLedger {
  const opened: Open[] = [];
  const unpaired = new Map<string, Open[]>();
  const prompts: PromptMark[] = [];
  let runWorkspace: string | null = null;
  let importCwd: string | null = null;
  let workspace: string | null = null;
  // The last user_message read: the importer writes one frame per text block
  // and attachment note of a record, all on the record's ts.
  let lastUser: { at: number; ts: unknown } | null = null;

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as unknown as Record<string, unknown>;
    switch (e.type) {
      case "run_start": {
        if (e.parentId || e.agentId === TITLE_AGENT_ID) break;
        prompts.push(mark(events, i, prompts.length + 1, e.prompt));
        const ws = text(e.workspace);
        if (ws !== null) {
          runWorkspace = ws;
          workspace ??= ws;
        }
        break;
      }
      case "user_message": {
        // Limit: a sidechain coordinator message has no agent id, so it counts as a prompt in an agent transcript imported on its own.
        const sameRecord =
          lastUser !== null && lastUser.at === i - 1 && typeof e.ts === "number" && e.ts === lastUser.ts;
        const said = typeof e.text === "string" ? e.text : "";
        if (sameRecord) prompts[prompts.length - 1].text += `\n${said}`;
        else prompts.push(mark(events, i, prompts.length + 1, said));
        lastUser = { at: i, ts: e.ts };
        break;
      }
      case "ground_info": {
        const cwd = text(e.cwd);
        if (cwd !== null) {
          importCwd = cwd;
          workspace ??= cwd;
        }
        break;
      }
      case "tool_call": {
        const open: Open = {
          callIndex: i,
          agentId: String(e.agentId),
          name: String(e.name),
          input: e.input,
          base: importCwd ?? runWorkspace,
          t: seconds(events, i),
          result: null,
        };
        opened.push(open);
        const key = pairKey(e.agentId, e.callId);
        const stack = unpaired.get(key);
        if (stack === undefined) unpaired.set(key, [open]);
        else stack.push(open);
        break;
      }
      case "tool_result": {
        const open = unpaired.get(pairKey(e.agentId, e.callId))?.pop();
        if (open !== undefined) {
          open.result = {
            output: typeof e.output === "string" ? e.output : "",
            isError: e.isError === true,
            fileChange: typeof e.fileChange === "string" ? e.fileChange : undefined,
          };
        }
        break;
      }
    }
  }

  const calls: FileCall[] = [];
  for (const open of opened) {
    const call = fileCall(open);
    if (call !== null) calls.push(call);
  }
  const timed = calls.some((c) => c.t !== null) || prompts.some((p) => p.t !== null);
  return { calls, prompts, workspace, timed };
}

/**
 * The explorer's rows: one per resolved path, in the order the paths were
 * first touched, over the calls of the given agents (all agents for null).
 */
export function fileRows(ledger: FileLedger, agents: ReadonlySet<string> | null): FileRow[] {
  const byPath = new Map<string, FileTouch[]>();
  for (const call of ledger.calls) {
    if (agents !== null && !agents.has(call.agentId)) continue;
    for (const touch of call.touches) {
      const list = byPath.get(touch.path);
      if (list === undefined) byPath.set(touch.path, [touch]);
      else list.push(touch);
    }
  }
  const rows: FileRow[] = [];
  for (const [path, touches] of byPath) {
    const letter = letterOf(touches);
    rows.push({
      path,
      label: shortenPath(path, ledger.workspace),
      group: letter === "R" ? "read" : "changed",
      letter,
      sources: SOURCE_ORDER.filter((s) => touches.some((t) => t.sources.includes(s))),
      firstT: touches[0].t,
      firstCall: touches[0].callIndex,
      touches,
    });
  }
  return rows;
}

/**
 * The summary line's counts. The file counts come from `rows`, which are
 * expected to be `fileRows(ledger, agents)` with the same set; the shell counts
 * read the ledger's calls of those agents (all agents for null). A failed
 * shell call counts as a shell call but not as a script with unknown effect.
 */
export function summarize(
  ledger: FileLedger,
  rows: readonly FileRow[],
  agents: ReadonlySet<string> | null,
): FilesSummary {
  let recordedChanged = 0;
  let probableChanged = 0;
  let onlyRead = 0;
  for (const row of rows) {
    if (row.letter === "R") onlyRead++;
    else if (row.letter !== "?") {
      const recorded = row.touches.some((t) => CHANGES.has(t.kind) && t.sources.includes("recorded"));
      if (recorded) recordedChanged++;
      else probableChanged++;
    }
  }
  let shellCalls = 0;
  let unknownScripts = 0;
  for (const call of ledger.calls) {
    if (!call.shell || (agents !== null && !agents.has(call.agentId))) continue;
    shellCalls++;
    if (call.status !== "failed" && (call.script !== null || call.inline)) unknownScripts++;
  }
  return { recordedChanged, probableChanged, onlyRead, shellCalls, unknownScripts };
}

/**
 * A row's letter: D when its last change is a delete, A when its first change
 * is a create, M for any other change, ? when nothing but unknown touches
 * stand beside its reads, R when it was only read.
 */
function letterOf(touches: readonly FileTouch[]): FileRow["letter"] {
  let first: TouchKind | null = null;
  let last: TouchKind | null = null;
  let unknown = false;
  for (const t of touches) {
    if (CHANGES.has(t.kind)) {
      first ??= t.kind;
      last = t.kind;
    } else if (t.kind === "unknown") unknown = true;
  }
  if (last === "delete") return "D";
  if (first !== null) return first === "create" ? "A" : "M";
  return unknown ? "?" : "R";
}

// The fold of one call.

function fileCall(open: Open): FileCall | null {
  const reading = readCall(open);
  if (reading === null) return null;
  const r = open.result;
  const failed = r?.isError === true;
  const touches: FileTouch[] = failed
    ? []
    : reading.touches.map((t) => ({
        ...t,
        reason: r === null ? t.reason + PENDING : t.reason,
        callIndex: open.callIndex,
        agentId: open.agentId,
        t: open.t,
      }));
  return {
    callIndex: open.callIndex,
    agentId: open.agentId,
    t: open.t,
    tool: open.name,
    line: reading.line,
    status: r === null ? "pending" : failed ? "failed" : "ok",
    shell: reading.shell,
    output: reading.output,
    base: open.base,
    script: reading.script,
    inline: reading.inline,
    note: failed ? null : reading.note,
    touches,
  };
}

function readCall(open: Open): Reading | null {
  // C15: Monitor waits on a shell loop; its command is not work on files.
  if (open.name === "Monitor") return null;
  // describeTool has no case for these two Claude Code tools.
  if (open.name === "MultiEdit") return multiEdit(open);
  if (open.name === "NotebookEdit") return notebookEdit(open);
  const r = open.result;
  const view = describeTool(open.name, open.input, r?.output, r?.isError ?? false, null, r?.fileChange);
  const base = open.base;
  switch (view.kind) {
    case "file":
      return recorded(view.path, base, "read", view.range === null ? "read" : `read ${view.range}`);
    case "image":
      // An image with a prompt was generated, not viewed.
      return view.prompt === null && view.source !== null
        ? recorded(view.source, base, "read", "viewed")
        : null;
    case "listing":
      return recorded(view.path, base, "read", "listed", { folder: true });
    case "matches":
      return matches(open.name, view, base);
    case "write":
      return write(view, base);
    case "edit":
      if (view.changed === "unchanged") return noChange(view.path);
      return recorded(view.path, base, "change", replacements(1), {
        replaced: [{ old: view.before, new: view.after }],
      });
    case "command":
      return shell(view, open);
    default:
      return null;
  }
}

function write(view: Extract<ToolView, { kind: "write" }>, base: string | null): Reading {
  const content = { content: view.content };
  switch (view.changed) {
    case "unchanged":
      return noChange(view.path);
    case "created":
      return recorded(view.path, base, "create", "recorded as created", content);
    case "changed":
      return recorded(view.path, base, "overwrite", "recorded as changed", content);
    default:
      return recorded(view.path, base, "write", "existence not recorded", content);
  }
}

/** describeTool folds globs and greps into one shape; a glob's pattern is a path pattern. */
const GLOB_TOOLS: ReadonlySet<string> = new Set(["glob", "Glob", "file_search"]);

/** A path that says it is a folder or a pattern: a trailing slash, `.` or `..`, or a glob character. */
const saysFolder = (path: string): boolean => /\/$|(^|\/)\.\.?$|[*?[\]{}]/.test(path);

function matches(name: string, view: Extract<ToolView, { kind: "matches" }>, base: string | null): Reading {
  const pattern = view.pattern;
  const path = view.path === "" ? null : view.path;
  if (GLOB_TOOLS.has(name)) {
    // Not resolved against the base: the pattern stays as the tool matched it.
    const joined = path === null || isRooted(pattern) ? pattern : `${path.replace(/\/+$/, "")}/${pattern}`;
    return recorded(joined, null, "read", `files matching ${pattern}`, { folder: true });
  }
  if (path === null) return recorded(pattern, null, "read", `search for ${pattern}`, { folder: true });
  // A grep on a plain path searched that file or folder; only the path itself can say folder.
  return recorded(path, base, "read", `search for ${pattern}`, { folder: saysFolder(path) });
}

function shell(view: Extract<ToolView, { kind: "command" }>, open: Open): Reading {
  const reading = shellTouches(view.command, open.base);
  return {
    line: oneLine(view.command),
    shell: true,
    output: open.result === null ? null : view.output,
    script: reading.script,
    inline: reading.inline,
    note: reading.touches.length === 0 ? "no file named" : null,
    touches: reading.touches.map((t) => ({ ...t, sources: ["probable"] })),
  };
}

function multiEdit(open: Open): Reading | null {
  const path = pathOf(open.input);
  const edits = field(open.input, "edits");
  if (path === null || !Array.isArray(edits)) return null;
  if (fileChange(open.result?.fileChange) === "unchanged") return noChange(path);
  const replaced: { old: string; new: string }[] = [];
  for (const entry of edits) {
    const before = anyText(field(entry, "old_string")) ?? anyText(field(entry, "oldString"));
    const after = anyText(field(entry, "new_string")) ?? anyText(field(entry, "newString"));
    if (before !== null && after !== null) replaced.push({ old: before, new: after });
  }
  return recorded(path, open.base, "change", replacements(replaced.length), { replaced });
}

function notebookEdit(open: Open): Reading | null {
  const path = text(field(open.input, "notebook_path")) ?? pathOf(open.input);
  if (path === null) return null;
  const mode = text(field(open.input, "edit_mode"));
  return recorded(path, open.base, "change", mode === null ? "notebook edit" : `notebook edit (${mode})`);
}

// Small builders and readers.

function recorded(
  written: string,
  base: string | null,
  kind: TouchKind,
  reason: string,
  extra: Partial<Pick<ShellTouch, "folder" | "replaced" | "content" | "appended">> = {},
): Reading {
  const { folder = false, ...rest } = extra;
  return {
    line: written,
    shell: false,
    output: null,
    script: null,
    inline: false,
    note: null,
    touches: [
      { written, path: resolvePath(written, base), folder, kind, reason, ...rest, sources: ["recorded"] },
    ],
  };
}

function noChange(written: string): Reading {
  return {
    line: written,
    shell: false,
    output: null,
    script: null,
    inline: false,
    note: "no change",
    touches: [],
  };
}

const replacements = (n: number) => (n === 1 ? "1 replacement" : `${n} replacements`);

/** The command on one line: each line break becomes a visible return mark. */
const oneLine = (command: string) => command.trim().replace(/\r\n|\r|\n/g, " ⏎ ");

const pairKey = (agentId: unknown, callId: unknown) => `${String(agentId)}\u0000${String(callId)}`;

function seconds(events: readonly RunEvent[], at: number): number | null {
  const ms = elapsedAt(events, at);
  return ms === null ? null : ms / 1000;
}

function mark(events: readonly RunEvent[], at: number, n: number, said: unknown): PromptMark {
  return { eventIndex: at, t: seconds(events, at), n, text: typeof said === "string" ? said : "" };
}

function field(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** An edit's old or new string, where "" is a real value (an insertion or a deletion). */
function anyText(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The three spellings of a file tool's path field that toolViews.ts reads. */
function pathOf(input: unknown): string | null {
  return text(field(input, "path")) ?? text(field(input, "filePath")) ?? text(field(input, "file_path"));
}
