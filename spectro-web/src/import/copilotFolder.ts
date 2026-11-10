// Card 605, task 12: a GitHub Copilot session folder, read as a whole.
//
// The grouping (groupPickedFiles in claudeCodeRun.ts) names the folder's files
// from their paths; this module reads the ones it names and loads the folder.
// The events go through the importer (detect.ts), whose content check decides
// the format: a folder whose events.jsonl is not a Copilot session loads as
// whatever it is, without the side files. A browser hands a page only the files
// the person picked, so nothing here reads a file the person did not pick.

import type { RunEvent } from "../events";
import type { ImportedRunSummary, PickedCopilotFolder } from "./claudeCodeRun";
import { detectAndLoad, type ImportKind, type ImportSource } from "./detect";
import type { SubagentTranscript } from "./subagentFile";

/** What workspace.yaml says that the import uses (item 2). */
export interface CopilotWorkspace {
  /** The session's name, the import's title. */
  name: string | null;
  /** An absolute POSIX path, the workspace when session.start names none. */
  cwd: string | null;
  /** client_name: copilot-intellij, github/cli. */
  client: string | null;
  /** created_at, as written. */
  createdAt: string | null;
}

/** One file of a recorded snapshot (item 3). */
export interface CopilotSnapshotFile {
  path: string;
  /** create when the preimage holds no content, delete when the postimage holds none, else change. */
  kind: "create" | "change" | "delete";
  added: number;
  removed: number;
}

/** A snapshot of rewind-file-snapshots/index.json, as the file records it. */
export interface CopilotSnapshotRecord {
  /** The user.message the snapshot belongs to, or null when the record names none. */
  eventId: string | null;
  /** The agent the record names, else "main". */
  agentId: string;
  files: CopilotSnapshotFile[];
}

/** A snapshot placed on the loaded stream. */
export interface CopilotSnapshot {
  /** The event index of the root run_start its user.message opened, or null when it opened none. */
  from: number | null;
  /** The event index of that run's end (its last event before the next root
   *  run_start), or the stream's last event when it opened none. */
  at: number;
  agentId: string;
  files: CopilotSnapshotFile[];
}

/** What a Copilot session carries beside its events: never a RunEvent, never written to a file. */
export interface CopilotSide {
  /** session.start's sessionId, or null when it names none. */
  sessionId: string | null;
  /** What the folder's workspace.yaml said; absent without one. */
  workspace?: CopilotWorkspace;
  /** The folder's recorded file snapshots; absent when it had none. */
  snapshots?: CopilotSnapshot[];
  /** An inuse.*.lock sat beside events.jsonl (item 4): a lock file marked the
   *  session as in use when it was picked (a stale lock says the same), and
   *  the import holds this many records. */
  live?: { records: number };
  /** events.jsonl was picked or dropped on its own, without its folder (item 6). */
  alone?: true;
  /** The file's last line did not parse and was left out (fix round 1 item 5). */
  torn?: true;
  /** The session folder's name, when the import came from a folder (fix round 1 item 7). */
  folderId?: string;
}

/** A picked file as far as this module reads it; a browser File is one. */
export interface PickedText {
  name: string;
  text(): Promise<string>;
}

/** The texts of one Copilot session folder: events.jsonl, and the side files the pick held. */
export interface CopilotFolderTexts {
  events: string;
  /** workspace.yaml, or null when the folder had none or it could not be read. */
  workspace: string | null;
  /** rewind-file-snapshots/index.json, or null likewise. */
  snapshots: string | null;
  /** An inuse.*.lock sat beside events.jsonl. */
  live: boolean;
  /** The folder's path inside the pick, when it had one: its name keys the view (fix round 1 item 7). */
  folder?: string;
}

/** What a folder load hands the dialog: the same parts a file load hands it, plus the run summary. */
export interface CopilotFolderLoad {
  events: RunEvent[];
  kind: ImportKind;
  source: ImportSource;
  subagent?: SubagentTranscript;
  /** The name the import goes by. */
  label: string;
  run: ImportedRunSummary;
}

/** The name an import of a folder goes by when nothing better names it. */
const EVENTS_FILE = "events.jsonl";

/**
 * Reads the files the grouping named for one folder. events.jsonl must read; a
 * side file that cannot be read is left out, so the session still loads.
 *
 * @param files the picked files the grouping's indices point into
 * @param pick  the folder the grouping found
 * @return the texts
 */
export async function readCopilotFolder(
  files: readonly PickedText[],
  pick: PickedCopilotFolder,
): Promise<CopilotFolderTexts> {
  const side = async (i: number | null): Promise<string | null> =>
    i === null ? null : await files[i].text().catch(() => null);
  return {
    events: await files[pick.events].text(),
    workspace: await side(pick.workspace),
    snapshots: await side(pick.snapshots),
    live: pick.live,
    folder: pick.folder,
  };
}

/** The cwd of the first ground_info frame, the importer's own reading of the folder it worked in. */
function groundCwd(events: readonly RunEvent[]): string | null {
  for (const e of events) {
    const f = e as unknown as { type?: unknown; cwd?: unknown };
    if (f.type === "ground_info" && typeof f.cwd === "string" && f.cwd !== "") return f.cwd;
  }
  return null;
}

// ---- a half-written last line ----------------------------------------------------

const parses = (line: string): boolean => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

/** The text without its last record line when that line alone does not parse, else null. */
function withoutTornTail(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0 || parses(lines[last])) return null;
  // A line before it that does not parse fails the second read, and so the whole load.
  return lines.slice(0, last).join("\n");
}

/**
 * The importer, with one allowance for a Copilot session: a last line that
 * does not parse (the file was read while Copilot was writing it) is left out
 * and the source says so, instead of failing the import (fix round 1 item 5).
 * Any other line that does not parse, and a torn last line of any other kind
 * of file, fail as `detectAndLoad` does.
 *
 * @param text the file
 * @return what detectAndLoad returns
 * @throws Error what detectAndLoad throws for the whole text
 */
export function loadEvents(text: string): ReturnType<typeof detectAndLoad> {
  try {
    return detectAndLoad(text);
  } catch (whole) {
    const cut = withoutTornTail(text);
    if (cut === null) throw whole;
    let loaded: ReturnType<typeof detectAndLoad>;
    try {
      loaded = detectAndLoad(cut);
    } catch {
      throw whole;
    }
    const side = loaded.source.copilot;
    if (side === undefined) throw whole;
    return { ...loaded, source: { ...loaded.source, copilot: { ...side, torn: true } } };
  }
}

// ---- workspace.yaml ---------------------------------------------------------------

const YAML_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/;
const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/;
/** A first character that makes a value something other than a plain scalar. */
const NOT_PLAIN = /^(?:[[\]{}!&*|>%@`#,]|[-?:](?:[ \t]|$))/;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r" };
const YAML_NULL = new Set(["~", "null", "Null", "NULL"]);

/** One value: a double-quoted, single-quoted or plain scalar, else null. */
function scalar(raw: string): string | null {
  const double = DOUBLE_QUOTED.exec(raw);
  if (double !== null) {
    let ok = true;
    const value = double[1].replace(/\\(.)/g, (_, c: string) => {
      if (ESCAPES[c] === undefined) ok = false;
      return ESCAPES[c] ?? "";
    });
    return ok ? value : null;
  }
  const single = SINGLE_QUOTED.exec(raw);
  if (single !== null) return single[1].replace(/''/g, "'");
  if (raw.startsWith('"') || raw.startsWith("'") || NOT_PLAIN.test(raw)) return null;
  const plain = raw.replace(/[ \t]+#.*$/, "").trim();
  if (plain === "" || plain.includes(": ") || plain.endsWith(":") || YAML_NULL.has(plain)) return null;
  return plain;
}

/**
 * The flat `key: value` lines of a workspace.yaml (25 of 25 measured files have
 * no other kind of line but comments). A quoted or plain scalar is read as
 * text; anything else (a flow collection, a tag, an anchor, an alias, a block,
 * an indented line) is skipped and never evaluated. The first of a key named
 * twice wins.
 *
 * @param text the file
 * @return its keys and their values
 */
export function readWorkspaceYaml(text: string): Record<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = YAML_KEY.exec(line.trimEnd());
    if (m === null || m[2] === undefined || out.has(m[1])) continue;
    const value = scalar(m[2].trim());
    if (value !== null) out.set(m[1], value);
  }
  // Built from entries, so a key such as __proto__ stays an own property.
  return Object.fromEntries(out);
}

/** What the import uses of a read workspace.yaml: the name, the folder, the client, the creation time. */
export function copilotWorkspace(yaml: Readonly<Record<string, string>>): CopilotWorkspace {
  const text = (key: string): string | null => {
    const v = yaml[key];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const cwd = text("cwd");
  return {
    name: text("name"),
    cwd: cwd !== null && cwd.startsWith("/") ? cwd : null,
    client: text("client_name"),
    createdAt: text("created_at"),
  };
}

// ---- rewind-file-snapshots/index.json ---------------------------------------------

const MAIN = "main";

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A count of lines: a finite number not below zero, else 0. */
const lineCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** An image holds content when its kind says so: 7 of 8 preimages and 8 of 8
 *  postimages measured say "content"; the other kind is read as no content. */
const holdsContent = (image: unknown): boolean => asObject(image)?.kind === "content";

/**
 * The snapshots of a rewind-file-snapshots/index.json, or null when the text
 * is no snapshot index (an object with `schema` and a `snapshots` list). Only
 * which files changed is read: the stored file contents (the backups) are
 * never named, and an image's hash, size and mode are left unread.
 *
 * @param text the file
 * @return the snapshots in file order, or null
 */
export function readSnapshotIndex(text: string): CopilotSnapshotRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const root = asObject(parsed);
  if (root === null || !("schema" in root) || !Array.isArray(root.snapshots)) return null;
  const out: CopilotSnapshotRecord[] = [];
  for (const raw of root.snapshots) {
    const snapshot = asObject(raw);
    if (snapshot === null) continue;
    const agent = nonEmpty(snapshot.agentId);
    const files: CopilotSnapshotFile[] = [];
    for (const value of Object.values(asObject(snapshot.files) ?? {})) {
      const entry = asObject(value);
      if (entry === null) continue;
      const pre = asObject(entry.preimage);
      const post = asObject(entry.postimage);
      const path = nonEmpty(entry.path) ?? nonEmpty(pre?.resolvedPath) ?? nonEmpty(post?.resolvedPath);
      if (path === null) continue;
      const kind = !holdsContent(post) ? "delete" : !holdsContent(pre) ? "create" : "change";
      files.push({ path, kind, added: lineCount(entry.linesAdded), removed: lineCount(entry.linesRemoved) });
    }
    out.push({
      eventId: nonEmpty(snapshot.eventId),
      agentId: agent !== null && agent !== MAIN ? agent : MAIN,
      files,
    });
  }
  return out;
}

/** The record a line holds, or null. */
function recordOf(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined) return null;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * The snapshots placed on the stream: each belongs to the root run that its
 * user.message opened, at that run's end. A snapshot whose eventId opened no
 * run stands at the end of the stream.
 *
 * @param records the snapshots as the index records them
 * @param events  the loaded stream
 * @param source  the stream's lines and origins
 * @return the placed snapshots, in record order
 */
export function placeSnapshots(
  records: readonly CopilotSnapshotRecord[],
  events: readonly RunEvent[],
  source: Pick<ImportSource, "lines" | "origin">,
): CopilotSnapshot[] {
  if (events.length === 0) return [];
  const roots: number[] = [];
  const openedBy = new Map<string, number>();
  events.forEach((e, i) => {
    const f = e as unknown as { type?: unknown; parentId?: unknown };
    if (f.type !== "run_start" || f.parentId != null) return;
    roots.push(i);
    const line = source.origin[i];
    const record = line < 0 ? null : recordOf(source.lines[line]);
    const id = record?.type === "user.message" ? nonEmpty(record.id) : null;
    if (id !== null && !openedBy.has(id)) openedBy.set(id, i);
  });
  const last = events.length - 1;
  return records.map((r) => {
    const from = r.eventId === null ? undefined : openedBy.get(r.eventId);
    if (from === undefined) return { from: null, at: last, agentId: r.agentId, files: r.files };
    const next = roots.find((at) => at > from);
    return { from, at: next === undefined ? last : next - 1, agentId: r.agentId, files: r.files };
  });
}

// ---- the folder -------------------------------------------------------------------

/** The stream with a ground_info frame of the importer's own at its head. */
function withGround(
  events: readonly RunEvent[],
  origin: Int32Array,
  cwd: string,
): { events: RunEvent[]; origin: Int32Array } {
  const ts = (events[0] as { ts?: unknown } | undefined)?.ts;
  const ground = {
    type: "ground_info",
    cwd,
    ...(typeof ts === "number" ? { ts } : {}),
  } as unknown as RunEvent;
  const out = new Int32Array(origin.length + 1);
  out[0] = -1;
  out.set(origin, 1);
  return { events: [ground, ...events], origin: out };
}

/**
 * One Copilot session folder, loaded.
 *
 * The side files apply only when the importer recognised the events as a
 * Copilot session by its producer; any other events.jsonl loads as whatever it
 * is. workspace.yaml names the import (its `name`) and gives the workspace
 * when session.start names none (its `cwd`, as an importer-built ground_info
 * frame; a ground_info from session.start stays first). The snapshot index
 * gives the recorded file changes, placed on the stream and carried beside
 * it (`source.copilot.snapshots`), never as frames.
 *
 * @param texts the folder's texts
 * @return the import, named and summarised for the dialog
 * @throws Error when events.jsonl is not a session the importer reads
 */
export function loadCopilotFolder(texts: CopilotFolderTexts): CopilotFolderLoad {
  const loaded = loadEvents(texts.events);
  const plain = (): CopilotFolderLoad => ({
    events: loaded.events,
    kind: loaded.kind,
    source: loaded.source,
    ...(loaded.subagent !== undefined ? { subagent: loaded.subagent } : {}),
    label: EVENTS_FILE,
    run: summary(groundCwd(loaded.events)),
  });
  const side = loaded.source.copilot;
  if (side === undefined) return plain();
  const workspace = texts.workspace === null ? null : copilotWorkspace(readWorkspaceYaml(texts.workspace));
  let events = loaded.events;
  let origin = loaded.source.origin;
  if (workspace?.cwd != null && groundCwd(events) === null)
    ({ events, origin } = withGround(events, origin, workspace.cwd));
  const records = texts.snapshots === null ? null : readSnapshotIndex(texts.snapshots);
  const snapshots =
    records === null ? [] : placeSnapshots(records, events, { lines: loaded.source.lines, origin });
  const folderId = texts.folder === undefined ? "" : folderName(texts.folder);
  const copilot: CopilotSide = {
    ...side,
    ...(folderId !== "" ? { folderId } : {}),
    ...(workspace !== null ? { workspace } : {}),
    ...(snapshots.length > 0 ? { snapshots } : {}),
    ...(texts.live
      ? { live: { records: loaded.source.lines.filter((line) => line.trim() !== "").length } }
      : {}),
  };
  return {
    events,
    kind: loaded.kind,
    source: { ...loaded.source, origin, copilot },
    label: workspace?.name ?? EVENTS_FILE,
    run: summary(groundCwd(events)),
  };
}

// ---- one file of a folder ----------------------------------------------------------

/**
 * The source of a file picked or dropped alone, marked when it is a Copilot
 * session: its folder holds more than the file did (item 6).
 *
 * @param source what the importer read from the file
 * @return the source, marked, or the same source for any other file
 */
export function pickedAlone(source: ImportSource): ImportSource {
  return source.copilot === undefined ? source : { ...source, copilot: { ...source.copilot, alone: true } };
}

/**
 * True for a file the person picked or dropped on its own, false for a file
 * of a folder pick: a folder pick that holds only events.jsonl is still the
 * folder (fix round 1 item 2).
 *
 * @param file the picked file; a browser File carries its folder path
 * @return whether it came without a folder path
 */
export function pickedOnItsOwn(file: { webkitRelativePath?: string }): boolean {
  return (file.webkitRelativePath ?? "") === "";
}

/**
 * True when a folder load is the session already shown, by its session id.
 *
 * @param source the folder load's source
 * @param shown  the session id of the session on screen, when it is a Copilot one
 * @return whether the load replaces the shown session rather than being a new import
 */
export function replacesShown(
  source: Pick<ImportSource, "copilot">,
  shown: string | null | undefined,
): boolean {
  const id = source.copilot?.sessionId ?? null;
  return id !== null && shown != null && id === shown;
}

// ---- a side file alone --------------------------------------------------------------

/** The heading the checkpoint list of a Copilot folder opens with. */
const CHECKPOINTS_HEADING = "# Checkpoints";

/**
 * True for a side file of a Copilot session folder (item 7): workspace.yaml by
 * its name, the snapshot index by its `schema` and `snapshots` keys, the
 * tracking file by `schema` and `tracking`, the checkpoint list (index.md) by
 * its heading.
 *
 * @param name the file's name
 * @param text the file
 * @return whether the file is one of the four
 */
export function copilotSideFile(name: string, text: string): boolean {
  if (name === "workspace.yaml") return true;
  if (name === "index.md")
    return (
      text
        .split(/\r?\n/)
        .find((line) => line.trim() !== "")
        ?.trim() === CHECKPOINTS_HEADING
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const root = asObject(parsed);
  return root !== null && "schema" in root && ("snapshots" in root || "tracking" in root);
}

// ---- the snapshot count of the import on screen ------------------------------------

/** The import on screen and its snapshot count; only that import holds one. */
let heldSnapshots: { sessionId: string; count: number } | null = null;

/**
 * Holds the snapshot count of the import that just opened, for the export
 * sheet to say they are not exported (item 9). A later import replaces it.
 *
 * @param sessionId the import's replay id
 * @param count     how many snapshots it carried
 */
export function holdCopilotSnapshots(sessionId: string, count: number): void {
  heldSnapshots = count > 0 ? { sessionId, count } : null;
}

/** The snapshot count of the import with this id, 0 for any other view. */
export function heldCopilotSnapshots(sessionId: string | null | undefined): number {
  return heldSnapshots !== null && heldSnapshots.sessionId === sessionId ? heldSnapshots.count : 0;
}

/** The last segment of a folder path inside a pick. */
const folderName = (folder: string): string => folder.slice(folder.lastIndexOf("/") + 1);

/**
 * The view id of an import: `import:<kind>:<label>`, and for a Copilot session
 * its folder name, else its session id, after a `#` (fix round 1 item 7), so
 * two sessions of the same name or file name do not share a view.
 *
 * @param kind   the format the importer read
 * @param label  the name the import goes by
 * @param source what the importer carried beside the stream
 * @return the replay id
 */
export function importViewId(kind: string, label: string, source: Pick<ImportSource, "copilot">): string {
  const id = source.copilot?.folderId ?? source.copilot?.sessionId ?? null;
  return id === null ? `import:${kind}:${label}` : `import:${kind}:${label}#${id}`;
}

/** The yaml name of an imported Copilot folder, the header's title (fix round 1 item 6), or null. */
export function copilotName(source: Pick<ImportSource, "copilot"> | undefined): string | null {
  return source?.copilot?.workspace?.name ?? null;
}

// ---- a store ----------------------------------------------------------------------

/** A picked file as the store list reads it: its size and time come from the File, never from a read. */
export interface PickedFileInfo extends PickedText {
  size: number;
  lastModified: number;
}

/** One row of a Copilot store's list (item 5). */
export interface CopilotStoreRow {
  /** The index of the session folder in the store group. */
  session: number;
  /** The first 8 characters of the folder's name, which tell unnamed sessions apart (fix round 1 item 6). */
  id: string;
  /** workspace.yaml's name, or null. */
  name: string | null;
  /** created_at in epoch ms, else the last-modified time of events.jsonl. */
  created: number;
  client: string | null;
  /** The size of events.jsonl, from the File object. */
  bytes: number;
  live: boolean;
}

/**
 * The rows of a store, newest first. Only the workspace.yaml files are read;
 * a folder without one, or with one that cannot be read, is a row without a
 * name, at the time its events.jsonl was last modified.
 *
 * @param files    the picked files the group's indices point into
 * @param sessions the store group's session folders
 * @return one row per session folder
 */
export async function copilotStoreRows(
  files: readonly PickedFileInfo[],
  sessions: readonly PickedCopilotFolder[],
): Promise<CopilotStoreRow[]> {
  const rows: CopilotStoreRow[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const pick = sessions[i];
    const events = files[pick.events];
    const yaml = pick.workspace === null ? null : await files[pick.workspace].text().catch(() => null);
    const ws = yaml === null ? null : copilotWorkspace(readWorkspaceYaml(yaml));
    const created = ws?.createdAt == null ? NaN : Date.parse(ws.createdAt);
    rows.push({
      session: i,
      id: folderName(pick.folder).slice(0, 8),
      name: ws?.name ?? null,
      created: Number.isFinite(created) ? created : events.lastModified,
      client: ws?.client ?? null,
      bytes: events.size,
      live: pick.live,
    });
  }
  return rows.sort((a, b) => b.created - a.created);
}

const summary = (workspace: string | null): ImportedRunSummary => ({
  workspace,
  childrenMerged: 0,
  childrenSkipped: 0,
  childrenUnrecorded: 0,
});
