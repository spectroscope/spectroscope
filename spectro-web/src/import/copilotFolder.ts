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

/** What a Copilot session carries beside its events: never a RunEvent, never written to a file. */
export interface CopilotSide {
  /** session.start's sessionId, or null when it names none. */
  sessionId: string | null;
  /** What the folder's workspace.yaml said; absent without one. */
  workspace?: CopilotWorkspace;
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
 * frame; a ground_info from session.start stays first).
 *
 * @param texts the folder's texts
 * @return the import, named and summarised for the dialog
 * @throws Error when events.jsonl is not a session the importer reads
 */
export function loadCopilotFolder(texts: CopilotFolderTexts): CopilotFolderLoad {
  const loaded = detectAndLoad(texts.events);
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
  const copilot: CopilotSide = { ...side, ...(workspace !== null ? { workspace } : {}) };
  return {
    events,
    kind: loaded.kind,
    source: { ...loaded.source, origin, copilot },
    label: workspace?.name ?? EVENTS_FILE,
    run: summary(groundCwd(events)),
  };
}

const summary = (workspace: string | null): ImportedRunSummary => ({
  workspace,
  childrenMerged: 0,
  childrenSkipped: 0,
  childrenUnrecorded: 0,
});
